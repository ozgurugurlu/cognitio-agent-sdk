import { sdkError } from "./errors.js"
import type {
  Event as CognitioEvent,
  Message as CognitioMessage,
  CognitioClient,
  Part as CognitioPart,
  SessionCheckpoint as CognitioCheckpoint,
  RuntimeConfig as CognitioRuntimeConfig,
  Session as CognitioSession,
} from "./internal/runtime-client/index.js"
import type {
  AgentMessage,
  AgentDefinition,
  AppliedSettings,
  CheckpointHandle,
  CompactResult,
  ControlOptions,
  ModelId,
  PermissionMode,
  PromptInput,
  PromptPart,
  PromptTurn,
  ModelUsageSummary,
  ResultMessage,
  RewindResult,
  RuntimeConfig,
  SdkMcpServer,
  SessionCreateOptions,
  SessionUsage,
  StreamOptions,
  TodoItem,
  UsageSummary,
} from "./types.js"
import { createDispatcher, type Dispatcher } from "./dispatcher/index.js"
import { assertNoError, assertOk } from "./internal/errors.js"
import { NEUTRAL_BASE_PROMPT } from "./internal/neutral-prompt.js"
import { extractSessionID, isSessionIdle, isSessionResult } from "./internal/events.js"
import {
  assertSupportedRuntimeConfig,
  collectDirectSdkMcpServers,
  collectHookRegistrations,
  normalizeOutputFormat,
  normalizeRuntimeConfig,
  parseModel,
} from "./internal/runtime-config.js"
import { stopSdkMcpHosts, type SdkMcpHost } from "./tools/mcp-server.js"

const POST_RESULT_IDLE_DRAIN_MS = 50
const POST_ERROR_RESULT_WAIT_MS = 250
const STALE_IDLE_GRACE_MS = 250
const CLEANUP_RETURN_GRACE_MS = 50
/**
 * How long `close()` waits for an abandoned turn's abort POST before giving up
 * on reporting its outcome. Long enough that a responsive server's failure is
 * still surfaced, short enough that an unreachable one cannot wedge `close()` —
 * which is the call you make precisely when you want to stop waiting.
 */
const SERVER_ABORT_DRAIN_MS = 1000
let messageCounter = 0
let lastMessageTimestamp = 0

class EventReader {
  // Unbounded by design: dropping any event can corrupt the stateful decoder.
  // Every path that stops consuming also aborts the owning subscription.
  private queue: IteratorResult<CognitioEvent>[] = []
  private waiters: Array<{
    active: boolean
    resolve: (value: IteratorResult<CognitioEvent>) => void
    reject: (error: unknown) => void
  }> = []
  private error: unknown
  private done = false
  private returning?: Promise<void>

  constructor(private readonly iterator: AsyncIterator<CognitioEvent>) {
    this.pump()
  }

  async next(): Promise<IteratorResult<CognitioEvent>> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.error) throw this.error
    if (this.done) return { done: true, value: undefined }
    return new Promise((resolve, reject) => {
      this.waiters.push({ active: true, resolve, reject })
    })
  }

  async nextWithin(ms: number): Promise<IteratorResult<CognitioEvent> | undefined> {
    const queued = this.queue.shift()
    if (queued) return queued
    if (this.error) throw this.error
    if (this.done) return { done: true, value: undefined }

    let timer: ReturnType<typeof setTimeout> | undefined
    return await new Promise((resolve, reject) => {
      const waiter = {
        active: true,
        resolve: (value: IteratorResult<CognitioEvent>) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error: unknown) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      }
      timer = setTimeout(() => {
        waiter.active = false
        resolve(undefined)
      }, ms)
      this.waiters.push(waiter)
    })
  }

  async return(): Promise<void> {
    this.finish()
    this.returning ??= Promise.resolve()
      .then(() => this.iterator.return?.(undefined))
      .then(() => {})
    await this.returning
  }

  private pump(): void {
    this.readLoop().catch((error: unknown) => {
      if (this.done) return
      this.error = error
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.active) waiter.reject(error)
      }
    })
  }

  private async readLoop(): Promise<void> {
    while (true) {
      const next = await this.iterator.next()
      if (this.done) return
      if (next.done) this.done = true
      const waiter = this.waiters.find((item) => item.active)
      if (waiter) {
        waiter.active = false
        this.waiters = this.waiters.filter((item) => item.active)
        waiter.resolve(next)
      } else {
        this.waiters = this.waiters.filter((item) => item.active)
        this.queue.push(next)
      }
      if (next.done) {
        for (const pending of this.waiters.splice(0)) {
          if (!pending.active) continue
          pending.active = false
          pending.resolve({ done: true, value: undefined })
        }
        return
      }
    }
  }

  private finish(): void {
    if (this.done) return
    this.done = true
    this.queue = []
    for (const pending of this.waiters.splice(0)) {
      if (!pending.active) continue
      pending.active = false
      pending.resolve({ done: true, value: undefined })
    }
  }
}

async function bufferUntilOwnTerminalWithin(input: {
  reader: EventReader
  bufferedEvents: CognitioEvent[]
  sessionId: string
  ms: number
}): Promise<boolean> {
  const deadline = Date.now() + input.ms
  while (Date.now() < deadline) {
    const next = await input.reader.nextWithin(Math.max(0, deadline - Date.now()))
    if (!next || next.done) return false
    input.bufferedEvents.push(next.value)
    if (
      extractSessionID(next.value) === input.sessionId &&
      (isSessionResult(next.value) || isSessionIdle(next.value))
    ) {
      return true
    }
  }
  return false
}

async function drainOwnIdleWithin(input: {
  reader: EventReader
  bufferedEvents: CognitioEvent[]
  sessionId: string
  ms: number
  staleIdleDeadline?: number
}): Promise<void> {
  const deadline = Date.now() + input.ms
  let staleIdleDeadline = input.staleIdleDeadline
  while (Date.now() < deadline) {
    const next = await input.reader.nextWithin(Math.max(0, deadline - Date.now()))
    if (!next || next.done) return
    if (extractSessionID(next.value) === input.sessionId && isSessionIdle(next.value)) {
      if (staleIdleDeadline !== undefined && Date.now() <= staleIdleDeadline) {
        staleIdleDeadline = undefined
        continue
      }
      return
    }
    input.bufferedEvents.push(next.value)
  }
}

/**
 * Dependencies and runtime metadata used to construct a Session. Applications normally obtain handles from Agent or AgentClient instead.
 */
export interface SessionContext {
  client: CognitioClient
  session: CognitioSession
  directory: string
  workspaceId?: string
  runtimeConfig?: RuntimeConfig
  sdkMcpHosts?: SdkMcpHost[]
  control?: ControlOptions
  createOptions: SessionCreateOptions | undefined
  /**
   * Called when a handle closes so its owning client can release its registration.
   */
  onClose?: (sessionId: string, session: Session) => void
}

interface StreamState {
  textByMessage: Map<string, string>
  reasoningByMessage: Map<string, string>
  partsByMessage: Map<string, Map<string, CognitioPart>>
  partTypes: Map<string, string>
  userMessages: Map<string, CognitioMessage>
  pendingUserMessageIds: Set<string>
  emittedUserMessageIds: Set<string>
  emittedToolResults: Set<string>
  emittedToolUses: Set<string>
  emittedTaskStarts: Set<string>
  emittedTaskTerminals: Set<string>
  // childSessionID -> immediate parent + spawning assistant message. Keeping
  // the full edge lets stale filtering walk nested subagents back to the root.
  // The session-level backing map survives across stream()/send() calls.
  subagentParents: Map<string, SubagentParentLink>
  ownedMessageIds: Set<string>
  ignoredMessageIds: Set<string>
  startedAt: number
  includePartialMessages: boolean
}

interface SubagentParentLink {
  parentSessionID: string
  messageID: string
}

interface LiveUsageEntry {
  providerID?: string
  modelID?: string
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  cost: number
  completed: boolean
  summary: boolean
}

interface InFlightOperation {
  closed: boolean
  cleanup: () => Promise<void>
  release: () => Promise<void>
}

/**
 * A conversation handle with one active query at a time. Owns its local control dispatcher and SDK-hosted MCP resources, while persisted server state survives normal close.
 * @example
 * ```ts
 * const session = await agent.createSession()
 * await session.send("Remember that the service uses PostgreSQL.")
 * await session.send("Suggest a backup strategy.")
 * ```
 */
export class Session {
  readonly id: string
  readonly directory: string
  readonly workspaceId?: string
  private readonly ctx: SessionContext
  private readonly dispatcher: Dispatcher
  private activeQuery?: symbol
  private closed = false
  private closePromise?: Promise<void>
  private closeFinished = false
  private readonly closeListeners = new Set<() => void>()
  private readonly inFlight = new Set<InFlightOperation>()
  private readonly pendingServerAborts = new Set<Promise<void>>()
  private readonly serverAbortErrors: unknown[] = []
  private readonly abandonedMessageIds = new Set<string>()
  // childSessionID -> immediate parent provenance, learned from subagent.*.
  // Session-level (NOT per-stream): abandoned-turn ids already persist across
  // streams, so the links they suppress through must persist too.
  private readonly subagentParentLinks = new Map<string, SubagentParentLink>()
  // Live usage accumulation (see SessionUsage docs): per-message provisional
  // entries observed from message.updated, plus a single committed aggregate
  // reconciled from authoritative session.result payloads (bounded memory —
  // long-lived sessions do not grow a per-turn list).
  private readonly usageCommitted = {
    turns: 0,
    totalCostUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    modelUsage: {} as Record<string, ModelUsageSummary>,
  }
  private readonly usageLive = new Map<string, LiveUsageEntry>()

  constructor(ctx: SessionContext) {
    assertSupportedRuntimeConfig(ctx.runtimeConfig)
    this.ctx = ctx
    this.id = ctx.session.id
    this.directory = ctx.directory
    this.workspaceId = ctx.workspaceId
    this.dispatcher = createDispatcher({
      client: ctx.client,
      sessionId: ctx.session.id,
      directory: ctx.directory,
      workspaceId: ctx.workspaceId,
      control: ctx.control,
      canUseTool: ctx.runtimeConfig?.canUseTool || undefined,
      hooks: collectHookRegistrations(ctx.runtimeConfig),
      sdkMcpServers: collectDirectSdkMcpServers(ctx.runtimeConfig),
    })
  }

  /**
   * @internal Start the local control dispatcher before exposing this handle to callers.
   */
  async startDispatcher(): Promise<void> {
    this.assertOpen()
    await this.dispatcher.start()
  }

  /**
   * Live cost/usage accumulated on this session handle. Grows while
   * `stream()` / `send()` / `command()` consume events and reconciles with
   * each turn's authoritative result (which includes subagent child-session
   * cost). Attached/resumed handles start at zero. Returns a defensive
   * snapshot.
   */
  get usage(): SessionUsage {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }
    const modelUsage: Record<string, ModelUsageSummary> = {}
    let totalCostUsd = 0
    let turns = 0
    const addModel = (key: string, item: Omit<ModelUsageSummary, "costUsd"> & { costUsd?: number }) => {
      const target = (modelUsage[key] ??= {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      })
      target.inputTokens += item.inputTokens
      target.outputTokens += item.outputTokens
      target.reasoningTokens = (target.reasoningTokens ?? 0) + (item.reasoningTokens ?? 0)
      target.cacheReadInputTokens = (target.cacheReadInputTokens ?? 0) + (item.cacheReadInputTokens ?? 0)
      target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + (item.cacheCreationInputTokens ?? 0)
      target.costUsd += item.costUsd ?? 0
    }
    turns += this.usageCommitted.turns
    totalCostUsd += this.usageCommitted.totalCostUsd
    usage.inputTokens += this.usageCommitted.usage.inputTokens
    usage.outputTokens += this.usageCommitted.usage.outputTokens
    usage.reasoningTokens += this.usageCommitted.usage.reasoningTokens
    usage.cacheReadInputTokens += this.usageCommitted.usage.cacheReadInputTokens
    usage.cacheCreationInputTokens += this.usageCommitted.usage.cacheCreationInputTokens
    for (const [key, item] of Object.entries(this.usageCommitted.modelUsage)) addModel(key, item)
    for (const entry of this.usageLive.values()) {
      totalCostUsd += entry.cost
      if (entry.completed && !entry.summary) turns += 1
      if (!entry.tokens) continue
      usage.inputTokens += entry.tokens.input
      usage.outputTokens += entry.tokens.output
      usage.reasoningTokens += entry.tokens.reasoning
      usage.cacheReadInputTokens += entry.tokens.cache.read
      usage.cacheCreationInputTokens += entry.tokens.cache.write
      if (entry.providerID && entry.modelID) {
        addModel(`${entry.providerID}/${entry.modelID}`, {
          inputTokens: entry.tokens.input,
          outputTokens: entry.tokens.output,
          reasoningTokens: entry.tokens.reasoning,
          cacheReadInputTokens: entry.tokens.cache.read,
          cacheCreationInputTokens: entry.tokens.cache.write,
          costUsd: entry.cost,
        })
      }
    }
    return { turns, totalCostUsd, usage, modelUsage }
  }

  /**
   * Folds an observed own-session assistant `message.updated` into the live
   * accumulator. Idempotent per message: `cost` is cumulative and `tokens`
   * is the latest step snapshot on the server, matching the accounting
   * `session.result` aggregates from.
   */
  private foldUsage(event: CognitioEvent, foldedThisTurn?: Set<string>): void {
    if (event.type !== "message.updated") return
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (info.sessionID !== this.id) return
    if (this.abandonedMessageIds.has(info.id)) return
    this.usageLive.set(info.id, {
      providerID: info.providerID,
      modelID: info.modelID,
      tokens: info.tokens,
      cost: info.cost ?? 0,
      completed: Boolean(info.time?.completed ?? info.finish),
      summary: info.summary === true,
    })
    foldedThisTurn?.add(info.id)
  }

  /**
   * Replaces this turn's provisional live entries with the authoritative
   * result totals (which include subagent child sessions) — no double count.
   */
  private commitLiveEntry(entry: LiveUsageEntry): void {
    const committed = this.usageCommitted
    committed.totalCostUsd += entry.cost
    if (entry.completed && !entry.summary) committed.turns += 1
    if (!entry.tokens) return
    committed.usage.inputTokens += entry.tokens.input
    committed.usage.outputTokens += entry.tokens.output
    committed.usage.reasoningTokens += entry.tokens.reasoning
    committed.usage.cacheReadInputTokens += entry.tokens.cache.read
    committed.usage.cacheCreationInputTokens += entry.tokens.cache.write
    if (!entry.providerID || !entry.modelID) return
    const key = `${entry.providerID}/${entry.modelID}`
    const target = (committed.modelUsage[key] ??= {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    })
    target.inputTokens += entry.tokens.input
    target.outputTokens += entry.tokens.output
    target.reasoningTokens = (target.reasoningTokens ?? 0) + entry.tokens.reasoning
    target.cacheReadInputTokens = (target.cacheReadInputTokens ?? 0) + entry.tokens.cache.read
    target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + entry.tokens.cache.write
    target.costUsd += entry.cost
  }

  /**
   * Bounds the live map: commits and drops entries that no future result can
   * cover — completed ones (manual compaction summaries, assistants left
   * behind by earlier boundaries) and abandoned ones (turns that died before
   * a result, even mid-flight). Runs at every terminal point (reconcile,
   * compact, stream/command teardown), so only genuinely in-flight entries
   * ever stay live. Totals are unchanged by the sweep.
   */
  private sweepLiveUsage(): void {
    for (const [id, entry] of this.usageLive) {
      if (!entry.completed && !this.abandonedMessageIds.has(id)) continue
      this.commitLiveEntry(entry)
      this.usageLive.delete(id)
    }
  }

  private reconcileUsage(result: ResultMessage, foldedThisTurn: Set<string>): void {
    for (const id of foldedThisTurn) this.usageLive.delete(id)
    foldedThisTurn.clear()
    this.sweepLiveUsage()
    const committed = this.usageCommitted
    committed.turns += result.turns
    committed.totalCostUsd += result.totalCostUsd ?? 0
    if (result.usage) {
      committed.usage.inputTokens += result.usage.inputTokens
      committed.usage.outputTokens += result.usage.outputTokens
      committed.usage.reasoningTokens += result.usage.reasoningTokens ?? 0
      committed.usage.cacheReadInputTokens += result.usage.cacheReadInputTokens ?? 0
      committed.usage.cacheCreationInputTokens += result.usage.cacheCreationInputTokens ?? 0
    }
    for (const [key, item] of Object.entries(result.modelUsage ?? {})) {
      const target = (committed.modelUsage[key] ??= {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      })
      target.inputTokens += item.inputTokens
      target.outputTokens += item.outputTokens
      target.reasoningTokens = (target.reasoningTokens ?? 0) + (item.reasoningTokens ?? 0)
      target.cacheReadInputTokens = (target.cacheReadInputTokens ?? 0) + (item.cacheReadInputTokens ?? 0)
      target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + (item.cacheCreationInputTokens ?? 0)
      target.costUsd += item.costUsd
    }
  }

  /**
   * Submit input and wait for its terminal result.
   * @param prompt - Text, typed turn, or asynchronous turns.
   * @returns The completed result; inspect subtype before using output.
   * @throws If closed, another query is active, or transport fails.
   * @example
   * ```ts
   * const result = await session.send("Summarize the report.")
   * ```
   */
  async send(prompt: PromptInput): Promise<ResultMessage> {
    this.assertOpen()
    const iterator = this.stream(prompt)
    let next = await iterator.next()
    while (!next.done) {
      next = await iterator.next()
    }
    return next.value
  }

  /**
   * Execute a registered slash command in this conversation.
   * @param options - Command name, arguments and optional execution overrides.
   * @returns The terminal command result.
   * @throws If the command is unavailable or another query is active.
   * @example
   * ```ts
   * await session.command("review", "src/client.ts")
   * ```
   */
  async command(
    name: string,
    args = "",
    options?: { agent?: string; model?: ModelId; variant?: string },
  ): Promise<ResultMessage> {
    this.assertOpen()
    const token = this.acquireActiveQuery()
    const ctl = new AbortController()
    const state: StreamState = {
      textByMessage: new Map(),
      reasoningByMessage: new Map(),
      partsByMessage: new Map(),
      partTypes: new Map(),
      userMessages: new Map(),
      pendingUserMessageIds: new Set(),
      emittedUserMessageIds: new Set(),
      emittedToolResults: new Set(),
      emittedToolUses: new Set(),
      emittedTaskStarts: new Set(),
      emittedTaskTerminals: new Set(),
      subagentParents: this.subagentParentLinks,
      ownedMessageIds: new Set(),
      ignoredMessageIds: new Set(this.abandonedMessageIds),
      startedAt: Date.now(),
      includePartialMessages: false,
    }
    let commandError: unknown
    let pendingSessionError: Error | undefined
    let reader: EventReader | undefined
    const bufferedEvents: CognitioEvent[] = []
    const activeTurn = { messageID: createMessageID() }
    const foldedThisTurn = new Set<string>()
    let completed = false
    let commandPosted = false
    let staleIdleDeadline: number | undefined
    state.ownedMessageIds.add(activeTurn.messageID)
    const cleanup = async () => {
      await runCleanupSteps(`failed to clean up command on session ${this.id}`, [
        () => ctl.abort(),
        () => this.releaseActiveQuery(token),
        () => (reader ? settleWithin(reader.return(), CLEANUP_RETURN_GRACE_MS) : undefined),
        () => {
          if (completed) return
          this.rememberAbandonedMessages(activeTurn.messageID, state)
          if (commandPosted && !commandError) this.trackServerAbort()
        },
        () => this.sweepLiveUsage(),
      ])
    }
    const operation = this.registerInFlight(cleanup)

    try {
      const { stream } = await this.ctx.client.event.subscribe(
        { directory: this.directory, workspace: this.workspaceId },
        { signal: ctl.signal, sseMaxRetryAttempts: 1 },
      )
      if (operation.closed) throw this.closedWhileInFlight()
      reader = new EventReader(stream[Symbol.asyncIterator]())
      const connected = await reader.next()
      if (connected.done) {
        if (operation.closed) throw this.closedWhileInFlight()
        throw sdkError("protocol", "Event stream ended before session.result")
      }
      if (connected.value.type !== "server.connected") bufferedEvents.push(connected.value)

      if (operation.closed) throw this.closedWhileInFlight()
      commandPosted = true
      const posted = this.ctx.client.session
        .command({
          sessionID: this.id,
          directory: this.directory,
          workspace: this.workspaceId,
          messageID: activeTurn.messageID,
          command: name,
          arguments: args,
          agent: options?.agent,
          model: options?.model,
          variant: options?.variant,
        })
        .then((result) => assertOk(result, "Failed to send command"))
        .catch((error: unknown) => {
          commandError = error
          ctl.abort()
          throw error
        })
      posted.catch(() => {})

      while (true) {
        const next = bufferedEvents.length
          ? { done: false as const, value: bufferedEvents.shift()! }
          : await reader.next()
        if (next.done) {
          if (operation.closed) throw this.closedWhileInFlight()
          if (commandError) throw commandError
          throw sdkError("protocol", "Event stream ended before session.result")
        }

        const event = next.value
        const sessionID = extractSessionID(event)
        if (sessionID !== undefined && sessionID !== this.id) continue

        if (sessionID === this.id && isSessionResult(event) && !isCurrentTurnResult(event, activeTurn.messageID)) {
          markIgnoredMessage(event, state)
          staleIdleDeadline = Date.now() + STALE_IDLE_GRACE_MS
          continue
        }

        if (sessionID === this.id && isSessionIdle(event)) {
          if (staleIdleDeadline !== undefined && Date.now() <= staleIdleDeadline) {
            staleIdleDeadline = undefined
            continue
          }
          staleIdleDeadline = undefined
          if (pendingSessionError) throw pendingSessionError
          throw sdkError("protocol", "Session became idle before session.result")
        }

        if (
          sessionID === this.id &&
          staleIdleDeadline !== undefined &&
          Date.now() > staleIdleDeadline &&
          isCurrentTurnActivity(event, activeTurn.messageID)
        ) {
          staleIdleDeadline = undefined
        }

        if (sessionID === this.id && isStaleTurnEvent(event, activeTurn.messageID, state)) continue

        if (sessionID === this.id && isSessionError(event)) {
          pendingSessionError = errorFromSessionError(event)
          if (
            !(await bufferUntilOwnTerminalWithin({
              reader,
              bufferedEvents,
              sessionId: this.id,
              ms: POST_ERROR_RESULT_WAIT_MS,
            }))
          ) {
            throw pendingSessionError
          }
          continue
        }

        if (sessionID === this.id) this.foldUsage(event, foldedThisTurn)
        const normalized = normalizeEvent(event, state, sessionID === this.id)
        if (sessionID === this.id && normalized.result) {
          pendingSessionError = undefined
          this.reconcileUsage(normalized.result, foldedThisTurn)
          const staleIdleDeadlineAtResult = staleIdleDeadline
          await drainOwnIdleWithin({
            reader,
            bufferedEvents,
            sessionId: this.id,
            ms: POST_RESULT_IDLE_DRAIN_MS,
            staleIdleDeadline: staleIdleDeadlineAtResult,
          })
          staleIdleDeadline = undefined
          await posted
          completed = true
          return normalized.result
        }
      }
    } catch (error) {
      if (operation.closed) throw this.closedWhileInFlight()
      if (commandError) throw commandError
      throw error
    } finally {
      await operation.release()
    }
  }

  /**
   * Submit input and yield normalized messages until the terminal result.
   * @param prompt - Text, typed turn, or asynchronous turns.
   * @param options - Partial-message and cancellation settings.
   * @returns An async generator of messages with a terminal return value.
   * @throws Closed/conflicting session or transport failures.
   * @example
   * ```ts
   * for await (const message of session.stream("Hello")) console.log(message.type)
   * ```
   */
  async *stream(prompt: PromptInput, options?: StreamOptions): AsyncGenerator<AgentMessage, ResultMessage> {
    this.assertOpen()
    const token = this.acquireActiveQuery()
    const ctl = new AbortController()
    const singleTurn = !isAsyncIterable(prompt)
    const state: StreamState = {
      textByMessage: new Map(),
      reasoningByMessage: new Map(),
      partsByMessage: new Map(),
      partTypes: new Map(),
      userMessages: new Map(),
      pendingUserMessageIds: new Set(),
      emittedUserMessageIds: new Set(),
      emittedToolResults: new Set(),
      emittedToolUses: new Set(),
      emittedTaskStarts: new Set(),
      emittedTaskTerminals: new Set(),
      subagentParents: this.subagentParentLinks,
      ownedMessageIds: new Set(),
      ignoredMessageIds: new Set(this.abandonedMessageIds),
      startedAt: Date.now(),
      includePartialMessages: options?.includePartialMessages === true,
    }
    let promptError: unknown
    let reader: EventReader | undefined
    const bufferedEvents: CognitioEvent[] = []
    let pendingSessionError: Error | undefined
    let activeTurn: { messageID: string } | undefined
    let promptPosted = false
    let turns: AsyncIterator<PromptTurn> | undefined
    let staleIdleDeadline: number | undefined
    let foldedThisTurn = new Set<string>()
    const cleanup = async () => {
      await runCleanupSteps(`failed to clean up stream on session ${this.id}`, [
        () => ctl.abort(),
        () => this.releaseActiveQuery(token),
        () => (reader ? settleWithin(reader.return(), CLEANUP_RETURN_GRACE_MS) : undefined),
        () => {
          if (!activeTurn) return
          this.rememberAbandonedMessages(activeTurn.messageID, state)
          if (promptPosted && !promptError) this.trackServerAbort()
        },
        () => this.sweepLiveUsage(),
        () => returnIteratorWithin(turns, CLEANUP_RETURN_GRACE_MS),
      ])
    }
    const operation = this.registerInFlight(cleanup)

    try {
      const { stream } = await this.ctx.client.event.subscribe(
        { directory: this.directory, workspace: this.workspaceId },
        { signal: ctl.signal, sseMaxRetryAttempts: 1 },
      )
      if (operation.closed) throw this.closedWhileInFlight()
      reader = new EventReader(stream[Symbol.asyncIterator]())
      const connected = await reader.next()
      if (connected.done) {
        if (operation.closed) throw this.closedWhileInFlight()
        throw sdkError("protocol", "Event stream ended before session.result")
      }
      if (connected.value.type !== "server.connected") bufferedEvents.push(connected.value)

      let finalResult: ResultMessage | undefined
      turns = promptTurns(prompt)[Symbol.asyncIterator]()
      let nextTurn = await turns.next()
      while (!nextTurn.done) {
        if (operation.closed) throw this.closedWhileInFlight()
        activeTurn = { messageID: createMessageID() }
        promptPosted = true
        foldedThisTurn = new Set()
        state.ownedMessageIds.add(activeTurn.messageID)
        const sent = this.promptAsyncTurn(nextTurn.value, activeTurn.messageID).catch((error: unknown) => {
          promptError = error
          ctl.abort()
          throw error
        })
        sent.catch(() => {})

        while (true) {
          const next = bufferedEvents.length
            ? { done: false as const, value: bufferedEvents.shift()! }
            : await reader.next()
          if (!next) throw sdkError("protocol", "Session became idle before session.result")
          if (next.done) {
            if (operation.closed) throw this.closedWhileInFlight()
            if (promptError) throw promptError
            throw sdkError("protocol", "Event stream ended before session.result")
          }

          const event = next.value
          const sessionID = extractSessionID(event)
          if (sessionID !== undefined && sessionID !== this.id) continue

          if (sessionID === this.id && isSessionResult(event) && !isCurrentTurnResult(event, activeTurn.messageID)) {
            markIgnoredMessage(event, state)
            staleIdleDeadline = Date.now() + STALE_IDLE_GRACE_MS
            continue
          }

          if (sessionID === this.id && isSessionIdle(event)) {
            if (staleIdleDeadline !== undefined && Date.now() <= staleIdleDeadline) {
              staleIdleDeadline = undefined
              continue
            }
            staleIdleDeadline = undefined
            if (pendingSessionError) throw pendingSessionError
            throw sdkError("protocol", "Session became idle before session.result")
          }

          if (
            sessionID === this.id &&
            staleIdleDeadline !== undefined &&
            Date.now() > staleIdleDeadline &&
            isCurrentTurnActivity(event, activeTurn.messageID)
          ) {
            staleIdleDeadline = undefined
          }

          if (sessionID === this.id && isStaleTurnEvent(event, activeTurn.messageID, state)) {
            continue
          }

          if (sessionID === this.id && isSessionError(event)) {
            pendingSessionError = errorFromSessionError(event)
            if (
              !(await bufferUntilOwnTerminalWithin({
                reader,
                bufferedEvents,
                sessionId: this.id,
                ms: POST_ERROR_RESULT_WAIT_MS,
              }))
            ) {
              throw pendingSessionError
            }
            continue
          }

          if (sessionID === this.id) this.foldUsage(event, foldedThisTurn)
          const normalized = normalizeEvent(event, state, sessionID === this.id)
          for (const message of normalized.messages) {
            yield message
          }

          if (sessionID === this.id && normalized.result) {
            pendingSessionError = undefined
            finalResult = normalized.result
            this.reconcileUsage(normalized.result, foldedThisTurn)
            const staleIdleDeadlineAtResult = staleIdleDeadline
            await drainOwnIdleWithin({
              reader,
              bufferedEvents,
              sessionId: this.id,
              ms: POST_RESULT_IDLE_DRAIN_MS,
              staleIdleDeadline: staleIdleDeadlineAtResult,
            })
            staleIdleDeadline = undefined
            activeTurn = undefined
            promptPosted = false
            if (singleTurn) await operation.release()
            yield { type: "result", result: normalized.result, text: normalized.result.text, raw: event }
            nextTurn = await turns.next()
            if (operation.closed && !nextTurn.done) throw this.closedWhileInFlight()
            break
          }
        }
      }

      if (!finalResult) throw sdkError("protocol", "Prompt stream completed without a session.result")
      return finalResult
    } catch (error) {
      if (operation.closed) throw this.closedWhileInFlight()
      if (promptError) throw promptError
      if (!ctl.signal.aborted) throw error
      throw error
    } finally {
      await operation.release()
    }
  }

  /**
   * Interrupt the active turn and its pending callback work.
   * @returns Completion of the abort request.
   * @throws Transport errors.
   * @example
   * ```ts
   * await session.interrupt()
   * ```
   */
  async interrupt(): Promise<void> {
    await this.abort()
  }

  /**
   * Alias of interrupt for cancelling the active turn.
   * @returns Completion of the abort request.
   * @throws Transport errors.
   * @example
   * ```ts
   * await session.abort()
   * ```
   */
  async abort(): Promise<void> {
    const result = await this.ctx.client.session.abort({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
    })
    assertOk(result, "Failed to abort session")
  }

  /**
   * Change authorization mode for subsequent session work.
   * @param _mode - New runtime permission mode.
   * @returns Completion after the runtime accepts the policy.
   * @throws Invalid mode or transport errors.
   * @example
   * ```ts
   * await session.setPermissionMode("dontAsk")
   * ```
   */
  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    this.assertOpen()
    const result = await this.ctx.client.session.runtimeConfig.patch({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      runtimeConfig: {
        permissionMode: _mode,
      },
    })
    assertOk(result, "Failed to set permission mode")
  }

  /**
   * Select the model for subsequent turns.
   * @param model - Provider/model identifier.
   * @returns Completion after runtime configuration is updated.
   * @throws Invalid model identifiers or transport errors.
   * @example
   * ```ts
   * await session.setModel("anthropic/claude-sonnet-4-5")
   * ```
   */
  async setModel(model: ModelId): Promise<void> {
    this.assertOpen()
    const result = await this.ctx.client.session.runtimeConfig.patch({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      runtimeConfig: {
        model: parseModel(model),
      },
    })
    assertOk(result, "Failed to set model")
  }

  /**
   * Replace the complete session-scoped agent definition map.
   * @param agents - Every agent definition that should remain available.
   * @returns Completion after the replacement is accepted.
   * @throws Invalid definitions or transport errors.
   * @example
   * ```ts
   * await session.setAgents({ reviewer: { prompt: "Review correctness." } })
   * ```
   */
  async setAgents(agents: Record<string, AgentDefinition>): Promise<void> {
    this.assertOpen()
    const result = await this.ctx.client.session.runtimeConfig.patch({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      runtimeConfig: normalizeRuntimeConfig({ agents }),
    })
    assertOk(result, "Failed to set agents")
  }

  /**
   * Update the persisted conversation title.
   * @param title - New title.
   * @returns Completion after metadata is updated.
   * @throws Transport errors.
   * @example
   * ```ts
   * await session.rename("Release review")
   * ```
   */
  async rename(title: string): Promise<void> {
    this.assertOpen()
    const result = await this.ctx.client.session.update({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      title,
    })
    assertOk(result, "Failed to rename session")
    this.ctx.session = result.data
  }

  /**
   * Add a tag without duplicating existing tags.
   * @param tag - Tag text, trimmed by the SDK.
   * @returns Completion after tags are updated.
   * @throws Transport errors.
   * @example
   * ```ts
   * await session.tag("review")
   * ```
   */
  async tag(tag: string): Promise<void> {
    this.assertOpen()
    const session = await this.loadSession()
    await this.setTags([...(session.tags ?? []), tag])
  }

  /**
   * Remove a tag while retaining the others.
   * @param tag - Tag to remove.
   * @returns Completion after tags are updated.
   * @throws Transport errors.
   * @example
   * ```ts
   * await session.untag("review")
   * ```
   */
  async untag(tag: string): Promise<void> {
    this.assertOpen()
    const session = await this.loadSession()
    await this.setTags((session.tags ?? []).filter((item) => item !== tag.trim()))
  }

  /**
   * Capture workspace file state at the current transcript boundary.
   * @param label - Optional human-readable label.
   * @returns A session-owned checkpoint handle.
   * @throws Snapshot or transport errors.
   * @example
   * ```ts
   * const checkpoint = await session.checkpoint("before-change")
   * ```
   */
  async checkpoint(label?: string): Promise<CheckpointHandle> {
    this.assertOpen()
    const result = await this.ctx.client.session.checkpoint({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      label,
    })
    assertOk(result, "Failed to create checkpoint")
    return checkpointFromInfo(result.data)
  }

  /**
   * List checkpoint handles owned by this session.
   * @returns Persisted checkpoint metadata.
   * @throws Transport errors.
   * @example
   * ```ts
   * const checkpoints = await session.listCheckpoints()
   * ```
   */
  async listCheckpoints(): Promise<CheckpointHandle[]> {
    const result = await this.ctx.client.session.checkpoints({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
    })
    assertOk(result, "Failed to list checkpoints")
    return result.data.map(checkpointFromInfo)
  }

  /**
   * Restore eligible workspace files to a session checkpoint. The transcript is not rolled back; external side effects are not undone.
   * @param checkpointId - Checkpoint owned by this session.
   * @returns The affected files and checkpoint identity.
   * @throws Invalid checkpoint, restore or transport errors.
   * @example
   * ```ts
   * await session.rewind(checkpoint.id)
   * ```
   */
  async rewind(checkpointId: string): Promise<RewindResult> {
    this.assertOpen()
    const result = await this.ctx.client.session.rewind({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      sessionRewindInput: { checkpointID: checkpointId },
    })
    assertOk(result, "Failed to rewind session")
    return {
      checkpointId: result.data.checkpointID,
      affectedFiles: result.data.affectedFiles,
    }
  }

  /**
   * Summarize conversation history and return the committed compaction boundary.
   * @param options - Optional model and additional instructions for the summary.
   * @returns Compaction identity, preserved messages, token count, and summary text.
   */
  async compact(options?: { model?: ModelId; customInstructions?: string }): Promise<CompactResult> {
    this.assertOpen()
    const token = this.acquireActiveQuery()
    const ctl = new AbortController()
    let reader: EventReader | undefined
    let summarizeError: unknown
    const folded = new Set<string>()
    let succeeded = false
    let summarizePosted = false
    const cleanup = async () => {
      await runCleanupSteps(`failed to clean up compaction on session ${this.id}`, [
        () => ctl.abort(),
        () => this.releaseActiveQuery(token),
        () => (reader ? settleWithin(reader.return(), CLEANUP_RETURN_GRACE_MS) : undefined),
        () => {
          if (succeeded) return
          for (const id of folded) this.abandonedMessageIds.add(id)
          if (summarizePosted) this.trackServerAbort()
        },
        () => this.sweepLiveUsage(),
      ])
    }
    const operation = this.registerInFlight(cleanup)

    try {
      const model = options?.model
        ? parseModel(options.model)
        : parseModel((await this.getAppliedSettings()).model ?? missingEffectiveModel())
      if (operation.closed) throw this.closedWhileInFlight()
      const { stream } = await this.ctx.client.event.subscribe(
        { directory: this.directory, workspace: this.workspaceId },
        { signal: ctl.signal, sseMaxRetryAttempts: 1 },
      )
      if (operation.closed) throw this.closedWhileInFlight()
      reader = new EventReader(stream[Symbol.asyncIterator]())
      const connected = await reader.next()
      if (connected.done) {
        if (operation.closed) throw this.closedWhileInFlight()
        throw sdkError("protocol", "Event stream ended before compact boundary")
      }
      if (operation.closed) throw this.closedWhileInFlight()
      summarizePosted = true
      const summarized = this.ctx.client.session.summarize({
        sessionID: this.id,
        directory: this.directory,
        workspace: this.workspaceId,
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
        ...(options?.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
      })
      summarized.then(
        (result) => {
          try {
            assertOk(result, "Failed to compact session")
          } catch (error) {
            summarizeError = error
            ctl.abort()
          }
        },
        (error: unknown) => {
          summarizeError = error
          ctl.abort()
        },
      )
      summarized.catch(() => {})

      while (true) {
        const next = await reader.next()
        if (next.done) {
          if (operation.closed) throw this.closedWhileInFlight()
          if (summarizeError) throw summarizeError
          throw sdkError("protocol", "Event stream ended before compact boundary")
        }
        if (extractSessionID(next.value) !== this.id) continue
        // Compaction produces a summary assistant message with real cost;
        // fold it so session.usage covers manual compaction too. There is no
        // session.result to reconcile against — the finally block sweeps the
        // entry straight into the committed aggregate (folded ids are marked
        // abandoned first when compaction fails, so a summary caught
        // mid-flight cannot leak a permanent live entry).
        this.foldUsage(next.value, folded)
        if (next.value.type === "system.compact_boundary") {
          const result = compactResultFromBoundary(next.value)
          if (boundaryTrigger(next.value) !== "manual") continue
          assertOk(await summarized, "Failed to compact session")
          succeeded = true
          return result
        }
        if (isSessionError(next.value)) throw errorFromSessionError(next.value)
        if (next.value.type === "session.result") {
          if (next.value.properties.subtype !== "success") throw errorFromSessionResult(next.value)
          assertOk(await summarized, "Failed to compact session")
          throw sdkError("protocol", "Session compact completed without compact boundary")
        }
        if (isSessionIdle(next.value)) throw sdkError("protocol", "Session compact completed without compact boundary")
      }
    } catch (error) {
      if (operation.closed) throw this.closedWhileInFlight()
      if (summarizeError) throw summarizeError
      throw error
    } finally {
      await operation.release()
    }
  }

  /**
   * Read the effective runtime policy and registered capabilities.
   * @returns A normalized settings snapshot without callback implementations.
   * @throws Transport errors.
   * @example
   * ```ts
   * console.log((await session.getAppliedSettings()).settingSources)
   * ```
   */
  async getAppliedSettings(): Promise<AppliedSettings> {
    const result = await this.ctx.client.session.runtimeConfig.get({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
    })
    assertOk(result, "Failed to get applied settings")
    const effective = result.data.effective as typeof result.data.effective & {
      tools?: { allowed?: string[]; disallowed?: string[] }
      canUseTool?: { registered?: boolean }
      hooks?: Record<string, { count?: number }>
      permissionMode?: PermissionMode
      autoPermissionClassifierModel?: { providerID: string; modelID: string }
      agents?: Record<string, unknown>
      skills?: AppliedSettings["skills"]
      commands?: AppliedSettings["commands"]
      plugins?: AppliedSettings["plugins"]
      systemPrompt?: AppliedSettings["systemPrompt"]
      appendSystemPrompt?: { length?: number }
      settingSources?: AppliedSettings["settingSources"]
    }
    // The server reports the SDK-injected neutral base prompt as a plain
    // custom prompt; detect it via the stored config blob so resumed handles
    // report mode "neutral" too. After a server restart the stored config is
    // gone and this degrades to "default" by design.
    const stored = result.data.runtimeConfig as { systemPrompt?: unknown } | undefined
    const systemPrompt =
      effective.systemPrompt && stored?.systemPrompt === NEUTRAL_BASE_PROMPT
        ? { ...effective.systemPrompt, mode: "neutral" as const }
        : effective.systemPrompt
    return {
      sessionId: this.id,
      effort: result.data.runtimeConfig.effort,
      thinkingConfig: result.data.runtimeConfig.thinkingConfig as AppliedSettings["thinkingConfig"],
      checkpointing: result.data.runtimeConfig.checkpointing,
      backgroundTaskPolicy: result.data.runtimeConfig.backgroundTaskPolicy as AppliedSettings["backgroundTaskPolicy"],
      compaction: (result.data.runtimeConfig as RuntimeConfig).compaction,
      includeEnvironment: (result.data.runtimeConfig as RuntimeConfig).includeEnvironment,
      model: modelToString(effective.model),
      maxTurns: effective.maxTurns,
      maxBudgetUsd: effective.maxBudgetUsd,
      permissionMode: effective.permissionMode,
      systemPrompt,
      appendSystemPrompt:
        effective.appendSystemPrompt?.length === undefined
          ? undefined
          : { length: effective.appendSystemPrompt.length },
      settingSources: effective.settingSources ?? ["user", "project", "local"],
      canUseTool: effective.canUseTool ? { registered: effective.canUseTool.registered === true } : undefined,
      hookCounts: effective.hooks
        ? Object.fromEntries(Object.entries(effective.hooks).map(([event, item]) => [event, item.count ?? 0]))
        : undefined,
      autoPermissionClassifierModel: modelToString(effective.autoPermissionClassifierModel),
      tools: {
        allowed: effective.tools?.allowed ?? [],
        disallowed: effective.tools?.disallowed ?? [],
      },
      registeredHooks: (effective.hooks ? Object.keys(effective.hooks) : []) as AppliedSettings["registeredHooks"],
      agents: effective.agents ? Object.keys(effective.agents) : [],
      skills: effective.skills ?? [],
      commands: effective.commands ?? [],
      plugins: effective.plugins ?? [],
    }
  }

  /**
   * Read the current persisted todo list.
   * @returns Todo entries in runtime order.
   * @throws Transport errors.
   * @example
   * ```ts
   * console.log(await session.getTodos())
   * ```
   */
  async getTodos(): Promise<TodoItem[]> {
    const result = await this.ctx.client.session.todo({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
    })
    assertOk(result, "Failed to get todos")
    return result.data
  }

  /**
   * Watch current todo snapshots until cancellation or stream closure.
   * @param options - Optional abort signal.
   * @returns An async generator of todo lists.
   * @throws Transport errors.
   * @example
   * ```ts
   * for await (const todos of session.todos({ signal })) console.log(todos)
   * ```
   */
  async *todos(options?: { signal?: AbortSignal }): AsyncGenerator<TodoItem[]> {
    this.assertOpen()
    const ctl = new AbortController()
    const abort = () => ctl.abort()
    if (options?.signal?.aborted) ctl.abort()
    options?.signal?.addEventListener("abort", abort, { once: true })
    let reader: EventReader | undefined
    const cleanup = async () => {
      await runCleanupSteps(`failed to clean up todo stream on session ${this.id}`, [
        () => options?.signal?.removeEventListener("abort", abort),
        () => ctl.abort(),
        () => (reader ? settleWithin(reader.return(), CLEANUP_RETURN_GRACE_MS) : undefined),
      ])
    }
    const operation = this.registerInFlight(cleanup)

    try {
      const { stream } = await this.ctx.client.event.subscribe(
        { directory: this.directory, workspace: this.workspaceId },
        { signal: ctl.signal, sseMaxRetryAttempts: 1 },
      )
      if (operation.closed) return
      reader = new EventReader(stream[Symbol.asyncIterator]())
      const connected = await reader.next()
      if (connected.done) throw sdkError("protocol", "Event stream ended before server.connected")
      if (operation.closed) return
      let lastTodos = await this.getTodos()
      if (operation.closed) return
      yield lastTodos

      while (true) {
        const next = await reader.next()
        if (next.done) return
        if (!isTodoUpdateForSession(next.value, this.id)) continue
        if (sameTodos(lastTodos, next.value.properties.todos)) continue
        lastTodos = next.value.properties.todos
        yield lastTodos
      }
    } catch (error) {
      if (ctl.signal.aborted) return
      throw error
    } finally {
      await operation.release()
    }
  }

  /**
   * Read persisted conversation messages normalized to the SDK message union.
   * @returns Stored transcript messages, including supported tool and attachment parts.
   * @throws Transport errors.
   * @example
   * ```ts
   * const history = await session.messages()
   * ```
   */
  async messages(): Promise<AgentMessage[]> {
    const result = await this.ctx.client.session.messages({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      view: "active",
    })
    assertOk(result, "Failed to get messages")
    return result.data.map(messageFromTranscript)
  }

  /**
   * Release everything this handle owns, in a deterministic order.
   *
   * In-flight per-call work (stream/command/compact/todos) is torn down first,
   * then the control dispatcher, then SDK-hosted MCP servers. The server-side
   * session is not deleted — reattach later with `sessions.resume(id)`.
   *
   * Bounded by construction, because `close()` is what you call when you want
   * to stop waiting: a consumer-owned generator's `finally` gets a short grace
   * period, and an abandoned turn's abort request is awaited for at most about
   * a second so an unreachable server cannot wedge teardown. Against a
   * responsive server it settles in well under 100 ms.
   *
   * Idempotent: concurrent and repeated calls share one teardown.
   *
   * @returns A promise that settles once every owned resource is handled.
   * @throws When one or more teardown stages fail; several are combined in an `AggregateError`.
   * @example
   * ```ts
   * await session.close()
   * ```
   */
  close(): Promise<void> {
    this.closePromise ??= this.closeOnce()
    return this.closePromise
  }

  /** @internal */
  onClosed(listener: () => void): () => void {
    if (this.closeFinished) {
      listener()
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  private async closeOnce(): Promise<void> {
    this.closed = true
    const errors: unknown[] = []
    const pending = Array.from(this.inFlight)
    this.inFlight.clear()
    pending.forEach((operation) => {
      operation.closed = true
    })
    errors.push(...(await collectTaskErrors(pending.map((operation) => operation.cleanup))))
    const pendingServerAborts = Array.from(this.pendingServerAborts)
    pendingServerAborts.forEach((abort) => this.pendingServerAborts.delete(abort))
    errors.push(...this.serverAbortErrors.splice(0))
    // Bounded: an unreachable server must not wedge close(). Aborts that do not
    // land in time stay handled by trackServerAbort, so nothing becomes an
    // unhandled rejection — we just stop reporting their outcome.
    const drained = await resultsWithin(Promise.allSettled(pendingServerAborts), SERVER_ABORT_DRAIN_MS)
    errors.push(...(drained ?? []).flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
    errors.push(...(await collectTaskErrors([() => this.dispatcher.stop()])))
    errors.push(
      ...(await collectTaskErrors([
        async () => {
          if (this.hasSdkOwnedMcpServers()) await this.clearSdkOwnedMcpServers()
        },
      ])),
    )
    errors.push(...(await collectTaskErrors([() => stopSdkMcpHosts(this.ctx.sdkMcpHosts ?? [])])))
    errors.push(...(await collectTaskErrors([() => this.ctx.onClose?.(this.id, this)])))
    this.closeFinished = true
    const listeners = Array.from(this.closeListeners)
    this.closeListeners.clear()
    errors.push(...(await collectTaskErrors(listeners.map((listener) => () => listener()))))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `failed to close session ${this.id}`)
  }

  private async promptAsyncTurn(turn: PromptTurn, messageID: string): Promise<void> {
    const format = normalizeOutputFormat(this.ctx.runtimeConfig?.outputFormat)
    const result = await this.ctx.client.session.promptAsync({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      messageID,
      ...(format ? { format } : {}),
      ...serializePromptTurn(turn),
    })
    assertNoError(result, "Failed to stream prompt")
  }

  private registerInFlight(teardown: () => Promise<void>): InFlightOperation {
    let ran: Promise<void> | undefined
    const operation: InFlightOperation = {
      closed: false,
      cleanup: () => (ran ??= teardown()),
      release: () => {
        const pending = operation.cleanup()
        void pending.then(
          () => this.inFlight.delete(operation),
          () => this.inFlight.delete(operation),
        )
        return pending
      },
    }
    this.inFlight.add(operation)
    return operation
  }

  private trackServerAbort(): void {
    const pending = this.abort()
    this.pendingServerAborts.add(pending)
    void pending.then(
      () => this.pendingServerAborts.delete(pending),
      (error: unknown) => {
        if (!this.pendingServerAborts.delete(pending)) return
        this.serverAbortErrors.push(error)
      },
    )
  }

  private assertOpen(): void {
    if (!this.closed) return
    throw sdkError("closed", `Session ${this.id} is closed (call sessions.resume("${this.id}") for a fresh handle)`)
  }

  private closedWhileInFlight(): Error {
    return sdkError("closed", `Session ${this.id} was closed while a stream was in flight`)
  }

  private acquireActiveQuery(): symbol {
    if (this.activeQuery) {
      throw sdkError("session_conflict", `Session ${this.id} already has an active send()/stream()/command() call`)
    }
    const token = Symbol()
    this.activeQuery = token
    return token
  }

  private releaseActiveQuery(token: symbol): void {
    if (this.activeQuery === token) this.activeQuery = undefined
  }

  private rememberAbandonedMessages(messageID: string, state: StreamState): void {
    this.abandonedMessageIds.add(messageID)
    for (const item of state.ownedMessageIds) this.abandonedMessageIds.add(item)
    for (const item of state.textByMessage.keys()) this.abandonedMessageIds.add(item)
    for (const item of state.reasoningByMessage.keys()) this.abandonedMessageIds.add(item)
    for (const item of state.partsByMessage.keys()) this.abandonedMessageIds.add(item)
  }

  private async loadSession(): Promise<CognitioSession> {
    const result = await this.ctx.client.session.get({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
    })
    assertOk(result, "Failed to load session")
    this.ctx.session = result.data
    return result.data
  }

  private async setTags(tags: string[]): Promise<void> {
    const result = await this.ctx.client.session.update({
      sessionID: this.id,
      directory: this.directory,
      workspace: this.workspaceId,
      tags: normalizeTags(tags),
    })
    assertOk(result, "Failed to update session tags")
    this.ctx.session = result.data
  }

  private hasSdkOwnedMcpServers(): boolean {
    return !!this.ctx.sdkMcpHosts?.length || collectDirectSdkMcpServers(this.ctx.runtimeConfig).length > 0
  }

  private async clearSdkOwnedMcpServers(sessionId = this.id): Promise<void> {
    const hosts = this.ctx.sdkMcpHosts ?? []
    const directNames = new Set(collectDirectSdkMcpServers(this.ctx.runtimeConfig).map((server) => server.name))
    const errors: unknown[] = []
    const [loaded] = await Promise.allSettled([
      this.ctx.client.session.runtimeConfig
        .get({
          sessionID: sessionId,
          directory: this.directory,
          workspace: this.workspaceId,
        })
        .then((result) => {
          assertOk(result, `Failed to load runtime config while closing session ${sessionId}`)
          return result.data.runtimeConfig
        }),
    ])
    if (loaded.status === "rejected") errors.push(loaded.reason)
    if (loaded.status === "fulfilled") {
      const currentServers = Array.isArray(loaded.value.sdkMcpServers) ? loaded.value.sdkMcpServers : []
      const currentPlugins = clearSdkOwnedDirectMcpFromInlinePlugins(loaded.value.plugins, directNames)
      errors.push(
        ...(await collectTaskErrors([
          async () => {
            const result = await this.ctx.client.session.runtimeConfig.patch({
              sessionID: sessionId,
              directory: this.directory,
              workspace: this.workspaceId,
              runtimeConfig: {
                sdkMcpServers: currentServers.filter((server) => {
                  if (server.type === "sdk" && server.transport === "direct" && directNames.has(server.name)) {
                    return false
                  }
                  if (
                    server.type === "remote" &&
                    hosts.some((host) => server.name === host.name && server.url === host.url)
                  ) {
                    return false
                  }
                  return true
                }),
                ...(currentPlugins === undefined ? {} : { plugins: currentPlugins }),
              },
            })
            assertOk(result, `Failed to clear SDK-owned MCP servers for session ${sessionId}`)
          },
        ])),
      )
    }
    if (typeof this.ctx.client.session.runtimeConfig.clearMcpScopes === "function") {
      errors.push(
        ...(await collectTaskErrors([
          async () => {
            const result = await this.ctx.client.session.runtimeConfig.clearMcpScopes({
              sessionID: sessionId,
              directory: this.directory,
              workspace: this.workspaceId,
            })
            assertOk(result, `Failed to clear MCP scopes for session ${sessionId}`)
          },
        ])),
      )
    }
    if (typeof this.ctx.client.session.children === "function") {
      const [children] = await Promise.allSettled([
        this.ctx.client.session
          .children({
            sessionID: sessionId,
            directory: this.directory,
            workspace: this.workspaceId,
          })
          .then((result) => {
            assertOk(result, `Failed to list child sessions while closing session ${sessionId}`)
            return result.data
          }),
      ])
      if (children.status === "rejected") errors.push(children.reason)
      if (children.status === "fulfilled") {
        errors.push(
          ...(await collectTaskErrors(children.value.map((child) => () => this.clearSdkOwnedMcpServers(child.id)))),
        )
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, `failed to clear SDK-owned MCP configuration for session ${sessionId}`)
    }
  }
}

async function collectTaskErrors(tasks: Array<() => Promise<void> | void>): Promise<unknown[]> {
  return (await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)))).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  )
}

async function runCleanupSteps(label: string, steps: Array<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) errors.push(...(await collectTaskErrors([step])))
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, label)
}

async function returnIteratorWithin(iterator: AsyncIterator<PromptTurn> | undefined, ms: number): Promise<void> {
  if (!iterator?.return) return
  await settleWithin(
    Promise.resolve()
      .then(() => iterator.return?.(undefined))
      .then(() => {}),
    ms,
  )
}

async function settleWithin(settled: Promise<void>, ms: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    settled.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Await `settled` for at most `ms`, returning `undefined` if it did not finish
 * in time. The timer is always cleared, so a bounded wait never keeps an
 * otherwise-idle process alive.
 */
async function resultsWithin<T>(settled: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms)
    }),
  ])
  if (timer) clearTimeout(timer)
  return result
}

function clearSdkOwnedDirectMcpFromInlinePlugins(
  plugins: CognitioRuntimeConfig["plugins"] | undefined,
  directNames: Set<string>,
): CognitioRuntimeConfig["plugins"] | undefined {
  if (!plugins) return
  return plugins.map((plugin) => {
    if (plugin.type !== "inline" || !plugin.mcpServers?.length) return plugin
    const mcpServers = plugin.mcpServers.filter(
      (server) =>
        !(
          server.type === "sdk" &&
          server.transport === "direct" &&
          directNames.has(`plugin:${plugin.name}:${server.name}`)
        ),
    )
    if (mcpServers.length === plugin.mcpServers.length) return plugin
    const next = { ...plugin }
    if (mcpServers.length) next.mcpServers = mcpServers
    else delete next.mcpServers
    return next
  })
}

function checkpointFromInfo(info: CognitioCheckpoint): CheckpointHandle {
  return {
    id: info.id,
    sessionId: info.sessionID,
    messageId: info.messageID,
    label: info.label,
    source: info.source,
    metadata: info.metadata,
    createdAt: info.time.created,
  }
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)))
}

function isTodoUpdateForSession(
  event: CognitioEvent,
  sessionId: string,
): event is Extract<CognitioEvent, { type: "todo.updated" }> {
  return event.type === "todo.updated" && event.properties.sessionID === sessionId
}

function sameTodos(a: TodoItem[], b: TodoItem[]) {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        item.content === other.content &&
        item.status === other.status &&
        item.priority === other.priority
      )
    })
  )
}

function messageFromTranscript(item: { info: CognitioMessage; parts: CognitioPart[] }): AgentMessage {
  if (item.info.role === "user") {
    return { type: "user", message: item.info, parts: item.parts }
  }
  const text = item.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  const reasoning = item.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("")
  return {
    type: "assistant",
    message: item.info,
    parts: item.parts,
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

function rememberPart(state: StreamState, part: CognitioPart) {
  const parts = state.partsByMessage.get(part.messageID) ?? new Map<string, CognitioPart>()
  parts.set(part.id, part)
  state.partsByMessage.set(part.messageID, parts)
}

function partsForMessage(state: StreamState, messageID: string) {
  const parts = state.partsByMessage.get(messageID)
  if (!parts?.size) return undefined
  return Array.from(parts.values())
}

function textForMessage(state: StreamState, messageID: string): string | undefined {
  const text = (partsForMessage(state, messageID) ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  return text || undefined
}

function rememberUserMessage(state: StreamState, message: CognitioMessage) {
  state.userMessages.set(message.id, message)
  if (!state.emittedUserMessageIds.has(message.id)) state.pendingUserMessageIds.add(message.id)
}

function flushPendingUserMessages(state: StreamState): AgentMessage[] {
  const messages = Array.from(state.pendingUserMessageIds).flatMap((messageID) => {
    const message = state.userMessages.get(messageID)
    if (!message || state.emittedUserMessageIds.has(messageID)) return []
    state.emittedUserMessageIds.add(messageID)
    return [{ type: "user" as const, message, parts: partsForMessage(state, messageID) }]
  })
  state.pendingUserMessageIds.clear()
  return messages
}

function isPendingUserEvent(event: CognitioEvent, state: StreamState) {
  if (event.type === "message.updated") return event.properties.info.role === "user"
  if (event.type === "message.part.updated") return state.pendingUserMessageIds.has(event.properties.part.messageID)
  if (event.type === "message.part.delta") return state.pendingUserMessageIds.has(event.properties.messageID)
  return false
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string | PromptTurn> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

async function* promptTurns(input: PromptInput): AsyncGenerator<PromptTurn> {
  if (isAsyncIterable(input)) {
    for await (const item of input) {
      yield normalizePromptTurn(item)
    }
    return
  }
  yield normalizePromptTurn(input)
}

function normalizePromptTurn(input: string | PromptTurn): PromptTurn {
  if (typeof input === "string") return { text: input }
  if (!input || typeof input !== "object") {
    throw sdkError("protocol", "PromptInput must be a string, a turn object, or an async iterable of turns")
  }
  if (input.text === undefined && input.parts === undefined) {
    throw sdkError("protocol", "Prompt turn must provide `text` or `parts`")
  }
  return input
}

function serializePromptTurn(turn: PromptTurn): { parts: PromptPart[] } {
  const parts = [
    ...(turn.text !== undefined ? [{ type: "text" as const, text: turn.text }] : []),
    ...(turn.parts?.map(sanitizePromptPart) ?? []),
  ]
  if (parts.length === 0) throw sdkError("protocol", "Prompt turn must include at least one part")
  return { parts }
}

function sanitizePromptPart(part: PromptPart): PromptPart {
  switch (part.type) {
    case "text":
      return {
        id: part.id,
        type: "text",
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        time: part.time,
        metadata: part.metadata,
      }
    case "file":
      return {
        id: part.id,
        type: "file",
        mime: part.mime,
        filename: part.filename,
        url: part.url,
        source: part.source,
      }
    case "agent":
      return {
        id: part.id,
        type: "agent",
        name: part.name,
        source: part.source,
      }
    case "subtask":
      return {
        id: part.id,
        type: "subtask",
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
        model: part.model,
        spawnMode: part.spawnMode,
        command: part.command,
      }
  }
}

function isDirectSdkMcpServer(server: NonNullable<RuntimeConfig["sdkMcpServers"]>[number]): server is SdkMcpServer {
  return (server.type === undefined || server.type === "sdk") && server.transport === "direct"
}

function normalizeEvent(
  event: CognitioEvent,
  state: StreamState,
  ownSession: boolean,
): {
  messages: AgentMessage[]
  result?: ResultMessage
} {
  rememberSubagentParent(event, state)
  const withPendingUsers = (messages: AgentMessage[]) => {
    if (!ownSession || isPendingUserEvent(event, state)) return messages
    const pending = flushPendingUserMessages(state)
    return pending.length ? [...pending, ...messages] : messages
  }

  if (event.type === "message.part.delta") {
    if (event.properties.field === "text") {
      const part = state.partsByMessage.get(event.properties.messageID)?.get(event.properties.partID)
      if (part && "text" in part && typeof part.text === "string") {
        rememberPart(state, { ...part, text: part.text + event.properties.delta } as CognitioPart)
      }
      if (state.partTypes.get(event.properties.partID) === "reasoning") {
        state.reasoningByMessage.set(
          event.properties.messageID,
          (state.reasoningByMessage.get(event.properties.messageID) ?? "") + event.properties.delta,
        )
      } else if (part?.type === "text") {
        const text = textForMessage(state, event.properties.messageID)
        if (text === undefined) state.textByMessage.delete(event.properties.messageID)
        else state.textByMessage.set(event.properties.messageID, text)
      } else {
        // Empty stays absent rather than "", so text keeps byte-identity with
        // the assistant message and a text-free turn reports `undefined`.
        const accumulated = (state.textByMessage.get(event.properties.messageID) ?? "") + event.properties.delta
        if (accumulated) state.textByMessage.set(event.properties.messageID, accumulated)
        else state.textByMessage.delete(event.properties.messageID)
      }
    }
    if (!state.includePartialMessages) return { messages: withPendingUsers([]) }
    return {
      messages: withPendingUsers([
        {
          type: "partial",
          messageId: event.properties.messageID,
          partId: event.properties.partID,
          field: event.properties.field,
          delta: event.properties.delta,
          raw: event,
        },
      ]),
    }
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    const messages: AgentMessage[] = []
    state.partTypes.set(part.id, part.type)
    rememberPart(state, part)
    if (part.type === "text") {
      const text = textForMessage(state, part.messageID)
      if (text === undefined) state.textByMessage.delete(part.messageID)
      else state.textByMessage.set(part.messageID, text)
    }
    if (part.type === "reasoning") {
      state.reasoningByMessage.set(part.messageID, part.text)
    }
    if (part.type === "tool") {
      if (part.state.status === "running" && !state.emittedToolUses.has(part.callID)) {
        state.emittedToolUses.add(part.callID)
        messages.push({
          type: "tool.use",
          toolUseId: part.callID,
          name: part.tool,
          input: part.state.input,
          raw: event,
        })
      }
      if (part.state.status === "completed" || part.state.status === "error") {
        const resultKey = `${part.id}:${part.state.status}`
        if (!state.emittedToolResults.has(resultKey)) {
          state.emittedToolResults.add(resultKey)
          if (!state.emittedToolUses.has(part.callID)) {
            state.emittedToolUses.add(part.callID)
            messages.push({
              type: "tool.use",
              toolUseId: part.callID,
              name: part.tool,
              input: part.state.input,
              raw: event,
            })
          }
          if (part.state.status === "completed") {
            messages.push({
              type: "tool.result",
              toolUseId: part.callID,
              output: part.state.output,
              raw: event,
            })
          }
          if (part.state.status === "error") {
            messages.push({
              type: "tool.result",
              toolUseId: part.callID,
              output: { error: part.state.error },
              raw: event,
            })
          }
        }
      }
    }
    if (state.includePartialMessages) messages.push({ type: "part", part, raw: event })
    return { messages: withPendingUsers(messages) }
  }

  if (event.type === "message.updated") {
    const message = event.properties.info
    if (message.role === "user") {
      rememberUserMessage(state, message)
      return { messages: [] }
    }
    if (isCompletedAssistant(message)) {
      return {
        messages: withPendingUsers([
          {
            type: "assistant",
            message,
            parts: partsForMessage(state, message.id),
            text: state.textByMessage.get(message.id),
            reasoning: state.reasoningByMessage.get(message.id),
            raw: event,
          },
        ]),
      }
    }
    return { messages: withPendingUsers([]) }
  }

  if (event.type === "permission.asked") return { messages: withPendingUsers([]) }

  if (isSessionResult(event)) {
    return { messages: withPendingUsers([]), result: resultFromEvent(event, state) }
  }

  if (event.type === "subagent.started") {
    return {
      messages: withPendingUsers([
        {
          type: "subagent.start",
          rootSessionId: event.properties.sessionID,
          parentSessionId: event.properties.parentSessionID,
          childSessionId: event.properties.childSessionID,
          messageId: event.properties.messageID,
          agent: event.properties.agent,
          taskId: event.properties.taskID,
          spawnMode: event.properties.spawnMode,
          toolCallId: event.properties.callID,
          raw: event,
        },
      ]),
    }
  }
  if (event.type === "subagent.progress") {
    return {
      messages: withPendingUsers([
        {
          type: "subagent.progress",
          rootSessionId: event.properties.sessionID,
          parentSessionId: event.properties.parentSessionID,
          childSessionId: event.properties.childSessionID,
          messageId: event.properties.messageID,
          agent: event.properties.agent,
          taskId: event.properties.taskID,
          spawnMode: event.properties.spawnMode,
          status: event.properties.status,
          title: event.properties.title,
          toolCallId: event.properties.callID,
          raw: event,
        },
      ]),
    }
  }
  if (event.type === "subagent.stopped") {
    return {
      messages: withPendingUsers([
        {
          type: "subagent.stop",
          rootSessionId: event.properties.sessionID,
          parentSessionId: event.properties.parentSessionID,
          childSessionId: event.properties.childSessionID,
          messageId: event.properties.messageID,
          agent: event.properties.agent,
          taskId: event.properties.taskID,
          spawnMode: event.properties.spawnMode,
          status: event.properties.status,
          result: event.properties.result,
          error: event.properties.error,
          toolCallId: event.properties.callID,
          raw: event,
        },
      ]),
    }
  }

  if (event.type === "todo.updated") {
    return {
      messages: withPendingUsers([
        { type: "todo.updated", sessionId: event.properties.sessionID, todos: event.properties.todos, raw: event },
      ]),
    }
  }
  if (event.type === "session.checkpoint.created") {
    return {
      messages: withPendingUsers([
        { type: "checkpoint.created", checkpoint: checkpointFromInfo(event.properties.checkpoint), raw: event },
      ]),
    }
  }
  if (event.type === "session.rewound") {
    return {
      messages: withPendingUsers([
        {
          type: "session.rewound",
          checkpointId: event.properties.checkpointID,
          affectedFiles: event.properties.affectedFiles,
          raw: event,
        },
      ]),
    }
  }

  if (event.type === "system.compact_boundary")
    return { messages: withPendingUsers([systemCompactBoundaryMessage(event)]) }

  if (event.type === "session.rate_limit_hit") {
    // Rate-limit events have no messageID, so child provenance is their only
    // stale-turn signal. Unknown children fail closed once a turn was
    // abandoned; otherwise a missed start could leak into the next stream.
    if (isStaleSubagentActivity(event.properties.sessionID, event.properties.activeSessionID, state)) {
      return { messages: withPendingUsers([]) }
    }
    return {
      messages: withPendingUsers([
        {
          type: "rate_limit",
          sessionId: event.properties.sessionID,
          activeSessionId: event.properties.activeSessionID,
          provider: event.properties.provider,
          model: event.properties.model,
          attempt: event.properties.attempt,
          retryAfterSeconds: event.properties.retryAfterSeconds,
          message: event.properties.message,
          raw: event,
        },
      ]),
    }
  }

  if (
    event.type === "task.started" ||
    event.type === "task.progress" ||
    event.type === "task.notification" ||
    event.type === "task.stopped"
  ) {
    const properties = event.properties
    // Stale-turn consistency: drop task events belonging to abandoned turns.
    // For child sessions, walk the complete subagent provenance chain; this
    // also covers nested children and a subagent.started missed at teardown.
    if (state.ignoredMessageIds.has(properties.messageID)) return { messages: withPendingUsers([]) }
    if (isStaleSubagentActivity(properties.sessionID, properties.activeSessionID, state)) {
      return { messages: withPendingUsers([]) }
    }
    const base = {
      sessionId: properties.sessionID,
      activeSessionId: properties.activeSessionID,
      taskId: properties.taskID,
      messageId: properties.messageID,
      partId: properties.partID,
      tool: properties.tool,
      agent: properties.agent,
      raw: event,
    }
    // Dedup keys are composite: providers with sequential call IDs (call_1,
    // call_2, ...) reuse the same ID across child sessions, across turns of
    // one stream, and even across steps of one turn — partID (globally
    // ascending server-side) disambiguates all of those.
    const taskKey = `${properties.activeSessionID}:${properties.partID}:${properties.taskID}`
    if (event.type === "task.started") {
      // Defensive dedup: exactly one start and one terminal per task, and
      // nothing after the terminal (including a late start).
      if (state.emittedTaskStarts.has(taskKey) || state.emittedTaskTerminals.has(taskKey)) {
        return { messages: withPendingUsers([]) }
      }
      state.emittedTaskStarts.add(taskKey)
      return { messages: withPendingUsers([{ type: "task.started", ...base }]) }
    }
    if (state.emittedTaskTerminals.has(taskKey)) return { messages: withPendingUsers([]) }
    if (event.type === "task.progress") {
      return {
        messages: withPendingUsers([
          {
            type: "task.progress",
            ...base,
            title: event.properties.title,
            elapsedMs: event.properties.elapsedMs,
          },
        ]),
      }
    }
    if (event.type === "task.notification") {
      return {
        messages: withPendingUsers([
          {
            type: "task.notification",
            ...base,
            kind: event.properties.kind,
            elapsedMs: event.properties.elapsedMs,
            message: event.properties.message,
          },
        ]),
      }
    }
    state.emittedTaskTerminals.add(taskKey)
    return {
      messages: withPendingUsers([
        {
          type: "task.stopped",
          ...base,
          status: event.properties.status,
          durationMs: event.properties.durationMs,
          title: event.properties.title,
          error: event.properties.error,
        },
      ]),
    }
  }

  if (event.type === "control.request" || event.type === "control.cancelled") return { messages: withPendingUsers([]) }
  if (ownSession) return { messages: withPendingUsers([{ type: "raw", event }]) }
  return { messages: [{ type: "system", subtype: event.type, raw: event }] }
}

function isCompletedAssistant(message: CognitioMessage): boolean {
  return message.role === "assistant" && (!!message.time.completed || !!message.finish || !!message.error)
}

function isSessionError(event: CognitioEvent): event is Extract<CognitioEvent, { type: "session.error" }> {
  return event.type === "session.error"
}

function errorFromSessionError(event: Extract<CognitioEvent, { type: "session.error" }>): Error {
  const error = event.properties.error
  const message =
    error && typeof error === "object" && "data" in error
      ? (error.data as { message?: unknown } | undefined)?.message
      : undefined
  return sdkError(
    "protocol",
    `Session errored before session.result: ${typeof message === "string" ? message : "unknown error"}`,
  )
}

function errorFromSessionResult(event: Extract<CognitioEvent, { type: "session.result" }>): Error {
  return sdkError(
    "protocol",
    `Session compact failed before compact boundary: ${
      event.properties.error?.message ?? event.properties.stopReason ?? event.properties.subtype
    }`,
  )
}

function missingEffectiveModel(): never {
  throw sdkError("protocol", "Cannot compact session without an effective model")
}

function compactResultFromBoundary(event: Extract<CognitioEvent, { type: "system.compact_boundary" }>): CompactResult {
  const properties = event.properties as {
    compactionId?: unknown
    preCompactTokenCount?: unknown
    preservedMessageIds?: unknown
    summaryText?: unknown
  }
  if (
    typeof properties.compactionId !== "string" ||
    typeof properties.preCompactTokenCount !== "number" ||
    !isStringArray(properties.preservedMessageIds)
  ) {
    throw sdkError(
      "protocol",
      "Session.compact() requires Phase 6 compact boundary fields; upgrade the cognitio server",
    )
  }
  return {
    compactionId: properties.compactionId,
    preCompactTokenCount: properties.preCompactTokenCount,
    preservedMessageIds: properties.preservedMessageIds,
    ...(typeof properties.summaryText === "string" ? { summaryText: properties.summaryText } : {}),
  }
}

function boundaryTrigger(
  event: Extract<CognitioEvent, { type: "system.compact_boundary" }>,
): "auto" | "manual" | undefined {
  const trigger = (event.properties as { trigger?: unknown }).trigger
  if (trigger === "auto" || trigger === "manual") return trigger
}

function systemCompactBoundaryMessage(
  event: Extract<CognitioEvent, { type: "system.compact_boundary" }>,
): AgentMessage {
  const properties = event.properties as {
    trigger?: unknown
    preCompactTokenCount?: unknown
    compactionId?: unknown
    preservedMessageIds?: unknown
    summaryText?: unknown
  }
  return {
    type: "system",
    subtype: "system.compact_boundary",
    ...(properties.trigger === "auto" || properties.trigger === "manual" ? { trigger: properties.trigger } : {}),
    ...(typeof properties.preCompactTokenCount === "number"
      ? { preCompactTokenCount: properties.preCompactTokenCount }
      : {}),
    ...(typeof properties.compactionId === "string" ? { compactionId: properties.compactionId } : {}),
    ...(isStringArray(properties.preservedMessageIds) ? { preservedMessageIds: properties.preservedMessageIds } : {}),
    ...(typeof properties.summaryText === "string" ? { summaryText: properties.summaryText } : {}),
    raw: event,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function resultFromEvent(event: CognitioEvent, state: StreamState): ResultMessage {
  if (event.type !== "session.result") throw sdkError("protocol", "Expected session.result event")
  return {
    subtype: event.properties.subtype,
    sessionId: event.properties.sessionID,
    messageId: event.properties.messageID,
    parentMessageId: event.properties.parentMessageID,
    stopReason: event.properties.stopReason,
    text:
      (event.properties as { finalText?: string }).finalText ??
      (event.properties.messageID ? state.textByMessage.get(event.properties.messageID) : undefined),
    turns: event.properties.numTurns ?? 0,
    durationMs: Date.now() - state.startedAt,
    totalCostUsd: event.properties.totalCostUsd,
    usage: event.properties.usage ? usageFromTokens(event.properties.usage, event.properties.modelUsage) : undefined,
    modelUsage: modelUsageFromEvent(event.properties.modelUsage),
    structuredOutput: event.properties.structuredOutput,
    error: event.properties.error
      ? { message: event.properties.error.message, cause: event.properties.error }
      : undefined,
  }
}

function usageFromTokens(
  tokens: NonNullable<Extract<CognitioEvent, { type: "session.result" }>["properties"]["usage"]>,
  modelUsage: Extract<CognitioEvent, { type: "session.result" }>["properties"]["modelUsage"],
): UsageSummary {
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    cacheReadInputTokens: tokens.cache.read,
    cacheCreationInputTokens: tokens.cache.write,
    perModel: modelUsage
      ? Object.fromEntries(
          Object.entries(modelUsage).map(([model, item]) => [
            model,
            {
              inputTokens: item.tokens.input,
              outputTokens: item.tokens.output,
              reasoningTokens: item.tokens.reasoning,
              cacheReadInputTokens: item.tokens.cache.read,
              cacheCreationInputTokens: item.tokens.cache.write,
            },
          ]),
        )
      : undefined,
  }
}

function modelUsageFromEvent(
  modelUsage: Extract<CognitioEvent, { type: "session.result" }>["properties"]["modelUsage"],
): ResultMessage["modelUsage"] {
  if (!modelUsage) return
  return Object.fromEntries(
    Object.entries(modelUsage).map(([model, item]) => [
      model,
      {
        inputTokens: item.tokens.input,
        outputTokens: item.tokens.output,
        reasoningTokens: item.tokens.reasoning,
        cacheReadInputTokens: item.tokens.cache.read,
        cacheCreationInputTokens: item.tokens.cache.write,
        costUsd: item.cost,
      },
    ]),
  )
}

function modelToString(model: { providerID: string; modelID: string } | undefined): string | undefined {
  if (!model) return
  return `${model.providerID}/${model.modelID}`
}

function createMessageID(): string {
  // Keep SDK-created IDs in the server's ascending format for older servers and
  // for readable transcript ordering. Current cognitio runLoop logic uses
  // transcript ordering rather than ID lexicographic comparisons.
  const ts = Date.now()
  if (ts !== lastMessageTimestamp) {
    lastMessageTimestamp = ts
    messageCounter = 0
  }
  messageCounter = (messageCounter + 1) & 0xfff
  const packed = (BigInt(ts) << 12n) | BigInt(messageCounter)
  const mask48 = (1n << 48n) - 1n
  const timeHex = (packed & mask48).toString(16).padStart(12, "0")
  const random = Math.random().toString(36).slice(2, 16).padEnd(14, "0")
  return `msg_${timeHex}${random}`
}

function isCurrentTurnResult(event: CognitioEvent, messageID: string): boolean {
  if (event.type !== "session.result") return false
  return event.properties.parentMessageID === messageID
}

function markIgnoredMessage(event: CognitioEvent, state: StreamState): void {
  if (event.type !== "session.result") return
  if (event.properties.messageID) state.ignoredMessageIds.add(event.properties.messageID)
}

function rememberSubagentParent(event: CognitioEvent, state: StreamState): void {
  if (event.type !== "subagent.started" && event.type !== "subagent.progress" && event.type !== "subagent.stopped") {
    return
  }
  state.subagentParents.set(event.properties.childSessionID, {
    parentSessionID: event.properties.parentSessionID,
    messageID: event.properties.messageID,
  })
}

function isStaleSubagentActivity(
  rootSessionID: string,
  activeSessionID: string,
  state: StreamState,
  seen = new Set<string>(),
): boolean {
  if (activeSessionID === rootSessionID) return false
  if (seen.has(activeSessionID)) return true
  const parent = state.subagentParents.get(activeSessionID)
  // There is nothing to suppress until a turn is abandoned. After that,
  // missing provenance is unsafe: it may be the child whose start was queued
  // behind the event on which the previous consumer broke.
  if (!parent) return state.ignoredMessageIds.size > 0
  if (state.ignoredMessageIds.has(parent.messageID)) return true
  return isStaleSubagentActivity(rootSessionID, parent.parentSessionID, state, new Set(seen).add(activeSessionID))
}

function isStaleTurnEvent(event: CognitioEvent, messageID: string, state: StreamState): boolean {
  if (event.type === "message.updated") {
    const message = event.properties.info
    if (message.role === "user") {
      if (message.id === messageID) {
        state.ownedMessageIds.add(message.id)
        return false
      }
      state.ignoredMessageIds.add(message.id)
      return true
    }
    if (
      message.parentMessageID === messageID ||
      message.parentID === messageID ||
      state.ownedMessageIds.has(message.id)
    ) {
      state.ownedMessageIds.add(message.id)
      return false
    }
    state.ignoredMessageIds.add(message.id)
    return true
  }

  if (event.type === "message.part.delta") {
    if (state.ignoredMessageIds.has(event.properties.messageID)) return true
    return false
  }

  if (event.type === "message.part.updated") {
    if (state.ignoredMessageIds.has(event.properties.part.messageID)) return true
    return false
  }

  if (event.type === "permission.asked") {
    const messageID = event.properties.tool?.messageID
    return typeof messageID === "string" && state.ignoredMessageIds.has(messageID)
  }

  if (event.type === "subagent.started" || event.type === "subagent.progress" || event.type === "subagent.stopped") {
    // Record every lifecycle event before filtering. A progress/stop can
    // recover provenance when subagent.started was lost during teardown.
    rememberSubagentParent(event, state)
    if (isStaleSubagentActivity(event.properties.sessionID, event.properties.childSessionID, state)) return true
    if (event.properties.messageID === messageID || state.ownedMessageIds.has(event.properties.messageID)) {
      state.ownedMessageIds.add(event.properties.messageID)
      return false
    }
    return state.ignoredMessageIds.has(event.properties.messageID)
  }

  return false
}

function isCurrentTurnActivity(event: CognitioEvent, messageID: string): boolean {
  if (event.type === "message.updated") {
    const message = event.properties.info
    if (message.role === "user") return message.id === messageID
    return message.parentMessageID === messageID || message.parentID === messageID
  }
  if (event.type === "session.status") return event.properties.status.type === "busy"
  return false
}
