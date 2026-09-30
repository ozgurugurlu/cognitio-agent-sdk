import { sdkError } from "./errors.js"
import type { AgentClient } from "./client.js"
import { NEUTRAL_BASE_PROMPT } from "./internal/neutral-prompt.js"
import { deriveAgentTitle, resolveAgentProfile, type ResolvedAgentProfile } from "./internal/default-profile.js"
import { createAgentStream, type AgentStream } from "./internal/agent-stream.js"
import { acquireCanonicalClient, closeDedicatedClient, createDedicatedClient } from "./internal/shared-client.js"
import { claimFacadeSession } from "./internal/session-ownership.js"
import { assertSupportedRuntimeConfig } from "./internal/runtime-config.js"
import { Session } from "./session.js"
import type {
  ControlOptions,
  ModelId,
  OutputFormatSpec,
  PermissionMode,
  PermissionRuleset,
  PromptInput,
  ResultMessage,
  RuntimeConfig,
  SessionCreateOptions,
  SpawnOptions,
  ToolDefinition,
} from "./types.js"

/**
 * Constructor options for the ergonomic Agent facade.
 *
 * With no connection options, Agent uses one process-global local server with
 * `isolated:true`, `127.0.0.1`, an ephemeral port, a 30-second startup
 * timeout, automatic process cleanup, disabled LSP/formatters/title agent,
 * no setting sources, and `question`, `todowrite`, and `skill` hidden.
 * Supplying a field replaces its default; `settingSources` restores selected
 * discovery and `disallowedTools: []` restores the hidden tools. Supplying an
 * `allowedTools` list drops the facade deny defaults. Re-enabling `question`
 * without a user-input path can hang a headless run. Custom `tools` run in the
 * caller process and are model-visible as `sdk_<sanitized-name>`.
 *
 * Isolation protects config, credentials, and state discovery. It is not an
 * operating-system, filesystem, process, tool, or network sandbox.
 *
 * @example
 * ```ts
 * import { Agent } from "cognitio-agent-sdk"
 *
 * const agent = new Agent({ model: "anthropic/claude-sonnet-4-5", spawn: {} })
 * try {
 *   const result = await agent.run("Summarize this repository.")
 *   console.log(result.text)
 * } finally {
 *   await agent.close() // explicit spawn options give this Agent its own runtime
 * }
 * ```
 */
export interface AgentOptions extends RuntimeConfig {
  /**
   * Direct SDK tools, exposed as `sdk_<sanitized-name>`.
   *
   * They execute in the caller process rather than the isolated server.
   */
  tools?: ToolDefinition[]
  /** Session working directory. */
  cwd?: string
  /** Alias for `cwd`; the two must match when both are supplied. */
  directory?: string
  /** Explicit server-session title. */
  title?: string
  /** Server permission rules, distinct from runtime `permissionMode`. */
  permission?: PermissionRuleset
  /** Attach to an existing server; mutually exclusive with `spawn` and `client`. */
  baseUrl?: string
  /** Remote runtime request headers, including Authorization. Requires baseUrl; incompatible with client or spawn. */
  headers?: Record<string, string>
  /**
   * Dedicated local-server options.
   *
   * Defined scalar values replace facade defaults. `config` is merged by
   * top-level key and, under `agent`, by agent name; a named agent's own
   * object replaces wholesale, so `agent: { title: {…} }` drops the facade's
   * `title.disable` and restores the per-session title model call. Explicit
   * `false`, `""`, and `[]` values are preserved.
   */
  spawn?: SpawnOptions
  /** Borrowed low-level client. Agent and `shutdown()` never close it. */
  client?: AgentClient
  /** Control-channel tuning for a dedicated client. */
  control?: ControlOptions
  /** Workspace id for a dedicated client. */
  workspaceId?: string
  /** Delete sessions created or forked by this Agent on close. Resumed sessions are retained. Defaults to false. */
  deleteSessionsOnClose?: boolean
}

/**
 * Flat per-run overrides.
 *
 * Raw `runtimeConfig` is intentionally not accepted; construct another
 * `Agent` for runtime fields outside this curated set.
 *
 * @example
 * ```ts
 * const result = await agent.run("Review this change.", {
 *   model: "anthropic/claude-sonnet-4-5",
 *   maxTurns: 4,
 * })
 * ```
 */
export interface RunOptions {
  /** Working directory for this fresh session. */
  cwd?: string
  /** Explicit session title; otherwise the prompt's first line is used. */
  title?: string
  /** `provider/model` id for this session. */
  model?: ModelId
  /** Maximum model turns before an `error_max_turns` result. */
  maxTurns?: number
  /** Maximum run cost before an `error_max_budget` result. */
  maxBudgetUsd?: number
  /** Runtime permission behavior for this session. */
  permissionMode?: PermissionMode
  /** Structured-output contract for this session. */
  outputFormat?: OutputFormatSpec
  /** Server permission rules, distinct from `permissionMode`. */
  permission?: PermissionRuleset
  /** Abort the active turn; terminal `error_aborted` still resolves normally. */
  signal?: AbortSignal
}

/**
 * Per-stream overrides.
 *
 * @example
 * ```ts
 * const stream = agent.stream("Explain the diff.", {
 *   includePartialMessages: true,
 * })
 * ```
 */
export interface AgentStreamOptions extends RunOptions {
  /** Yield text/reasoning delta envelopes in addition to assembled messages. */
  includePartialMessages?: boolean
}

/**
 * Options for a long-lived, caller-managed Session.
 *
 * Turn cancellation is intentionally absent; pass a signal to each Session
 * operation instead.
 *
 * @example
 * ```ts
 * const session = await agent.createSession({
 *   title: "Release review",
 *   parentId: "ses_parent",
 * })
 * ```
 */
export interface AgentSessionOptions {
  /** Working directory fixed for the new session. */
  cwd?: string
  /** Explicit session title; defaults to `"Agent session"`. */
  title?: string
  /** `provider/model` id for this session. */
  model?: ModelId
  /** Maximum model turns per operation. */
  maxTurns?: number
  /** Maximum model cost per operation in USD. */
  maxBudgetUsd?: number
  /** Runtime permission behavior for the session. */
  permissionMode?: PermissionMode
  /** Structured-output contract for the session. */
  outputFormat?: OutputFormatSpec
  /** Server permission rules, distinct from `permissionMode`. */
  permission?: PermissionRuleset
  /** Optional parent session id for server-side hierarchy. */
  parentId?: string
}

/**
 * Terminal Agent result. Execution-limit and abort subtypes resolve normally;
 * inspect `isError` rather than relying on rejection.
 *
 * @example
 * ```ts
 * const result = await agent.run("Summarize the repository.")
 * if (result.isError) console.error(result.subtype)
 * else console.log(result.text)
 * ```
 */
export interface RunResult extends ResultMessage {
  /** Final assistant text, or `""` when the terminal message had no text. */
  text: string
  /** Exactly `subtype !== "success"`. */
  isError: boolean
}

export { type AgentStream } from "./internal/agent-stream.js"

/** @internal Facade/query cooperation hook; not exported from the package root. */
export const AGENT_FRESH_STREAM = Symbol("cognitio.agent.fresh-stream")
/** @internal Facade/query cooperation hook; not exported from the package root. */
export const AGENT_SESSION_STREAM = Symbol("cognitio.agent.session-stream")
/** @internal Facade/query cooperation hook; not exported from the package root. */
export const AGENT_VALIDATE_RESUME = Symbol("cognitio.agent.validate-resume")
/** @internal Facade/query cooperation hook; not exported from the package root. */
export const AGENT_VALIDATE_FORK = Symbol("cognitio.agent.validate-fork")

/**
 * High-level facade over the complete low-level Agent SDK.
 *
 * Each `run()` or `stream()` uses a fresh server session. Use
 * `createSession()` for explicit multi-turn state.
 *
 * @example
 * ```ts
 * const agent = new Agent({ model: "anthropic/claude-sonnet-4-5" })
 * const result = await agent.run("Summarize this repository.")
 * await agent.close()
 * ```
 */
export class Agent {
  private readonly profile: ResolvedAgentProfile
  private readonly owner = Symbol("Agent")
  private readonly streams = new Set<AgentStream>()
  private readonly sessions = new Set<Session>()
  private readonly sessionsById = new Map<string, Session>()
  private readonly attachments = new Map<string, Promise<Session>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly createdSessions = new Map<string, AgentClient>()
  private readonly deleteSessionsOnClose: boolean
  private dedicatedCreation: Promise<AgentClient> | undefined
  private closed = false
  private closePromise: Promise<void> | undefined

  /**
   * Validate and create an Agent facade without starting a server.
   *
   * @param options - Facade, runtime, and connection options.
   * @throws When options conflict, a model id is malformed, or runtime config is unsupported.
   * @example
   * ```ts
   * const agent = new Agent({
   *   instructions: "You are a release reviewer.",
   *   disallowedTools: [],
   * })
   * ```
   */
  constructor(options?: AgentOptions) {
    this.profile = resolveAgentProfile(options)
    this.deleteSessionsOnClose = options?.deleteSessionsOnClose === true
  }

  /**
   * Run a prompt in a fresh session.
   *
   * Error result subtypes resolve with `isError:true`; setup and transport
   * failures reject.
   *
   * @param prompt - One prompt or an asynchronous sequence of turns.
   * @param options - Flat per-run overrides.
   * @returns The final turn result with required `text` and `isError`.
   * @throws When the Agent is closed or setup/transport fails.
   * @example
   * ```ts
   * const result = await agent.run("Review the staged diff.")
   * if (!result.isError) console.log(result.text)
   * ```
   */
  run(prompt: PromptInput, options?: RunOptions): Promise<RunResult> {
    const operation = rejectable(() => {
      this.assertOpen()
      return this.consume(this.stream(prompt, options))
    })
    this.trackOperation(operation)
    return operation
  }

  /**
   * Stream normalized events from a fresh session.
   *
   * Startup is lazy: the session is created by the first `next()`,
   * `sessionId()`, or control call. Early loop exit invokes `return()`; call
   * `close()` explicitly when abandoning a handle outside a loop.
   *
   * @param prompt - One prompt or an asynchronous sequence of turns.
   * @param options - Stream and per-run overrides.
   * @returns A synchronous async-iterator handle with session controls.
   * @throws Synchronously when the Agent is closed or options are invalid.
   * @example
   * ```ts
   * const stream = agent.stream("Explain this repository.")
   * for await (const message of stream) console.log(message.type)
   * ```
   */
  stream(prompt: PromptInput, options?: AgentStreamOptions): AgentStream {
    this.assertOpen()
    return this[AGENT_FRESH_STREAM](prompt, options)
  }

  /** @internal Stream a fresh session; `query()` passes its own teardown hook. */
  [AGENT_FRESH_STREAM](prompt: PromptInput, options?: AgentStreamOptions, onFinish?: () => Promise<void>): AgentStream {
    this.assertOpen()
    const create = this.resolveCreateOptions(prompt, options)
    return this[AGENT_SESSION_STREAM](() => this.createFreshSession(create), prompt, options, onFinish)
  }

  /**
   * Create a long-lived Session for explicit multi-turn work.
   *
   * @param options - Flat session-create overrides. Turn cancellation is not accepted here.
   * @returns A caller-managed Session also owned by this Agent.
   * @throws When the Agent is closed or creation fails.
   * @example
   * ```ts
   * const session = await agent.createSession({ title: "Investigation" })
   * await session.send("Start with the failing test.")
   * ```
   */
  createSession(options?: AgentSessionOptions): Promise<Session> {
    const operation = rejectable(() => {
      this.assertOpen()
      const create = this.resolveCreateOptions(undefined, options)
      return this.createFreshSession({
        ...create,
        ...(options?.parentId !== undefined ? { parentId: options.parentId } : {}),
      })
    })
    this.trackOperation(operation)
    return operation
  }

  /**
   * Attach to an existing server session.
   *
   * Resume preserves stored runtime config and applies explicit constructor
   * overrides before attaching callbacks and tools. Default facade values do
   * not overwrite the stored configuration. Working directory cannot change.
   *
   * @param sessionId - Existing session id on this Agent's server.
   * @returns A live Session owned by this Agent.
   * @throws On unsupported resume fields, ownership conflict, or missing session.
   * @example
   * ```ts
   * const session = await agent.resume("ses_existing")
   * await session.send("Continue.")
   * ```
   */
  resume(sessionId: string): Promise<Session> {
    return rejectable(() => {
      this.assertOpen()
      this[AGENT_VALIDATE_RESUME]()
      const active = this.sessionsById.get(sessionId)
      if (active) return Promise.resolve(active)
      const pending = this.attachments.get(sessionId)
      if (pending) return pending
      const operation = this.attachSession(sessionId)
      this.attachments.set(sessionId, operation)
      operation
        .finally(() => {
          if (this.attachments.get(sessionId) === operation) this.attachments.delete(sessionId)
        })
        .catch(() => {})
      this.trackOperation(operation)
      return operation
    })
  }

  /**
   * Fork a session transcript and apply the full facade profile before its
   * dispatcher starts.
   *
   * Forks inherit the source working directory; a constructor `cwd` or
   * `directory` is therefore rejected.
   *
   * @param sessionId - Source session id.
   * @param options - Optional source message boundary.
   * @returns The configured fork Session.
   * @throws On a cwd override, ownership conflict, or fork/configuration failure.
   * @example
   * ```ts
   * const fork = await agent.fork("ses_source", { messageId: "msg_boundary" })
   * await fork.send("Try another approach.")
   * ```
   */
  fork(sessionId: string, options?: { messageId?: string }): Promise<Session> {
    const operation = rejectable(() => {
      this.assertOpen()
      this[AGENT_VALIDATE_FORK]()
      return this.createFork(sessionId, options)
    })
    this.trackOperation(operation)
    return operation
  }

  /**
   * Access the full low-level client used by this Agent.
   *
   * Mixing low-level active Session handles with facade resume ownership is
   * unsupported. Injected clients remain borrowed.
   *
   * @returns The current low-level client.
   * @throws When the Agent is closed or client creation fails.
   * @example
   * ```ts
   * const sessions = await (await agent.client()).sessions.list()
   * ```
   */
  client(): Promise<AgentClient> {
    const operation = rejectable(() => {
      this.assertOpen()
      return this.getClient().then((client) => {
        this.assertOpen()
        return client
      })
    })
    this.trackOperation(operation)
    return operation
  }

  /**
   * Close every stream and Session owned by this Agent.
   *
   * Dedicated clients are closed. The process-global canonical client
   * survives until `shutdown()`, and injected clients are never closed.
   * Concurrent calls share one teardown promise.
   *
   * @returns A promise that settles after all owned resources are handled.
   * @throws When teardown fails; multiple failures are combined in an `AggregateError`.
   * @example
   * ```ts
   * await agent.close()
   * ```
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeOwnedResources()
    return this.closePromise
  }

  /** @internal Reject a fork this Agent's connection cannot reach, before any request. */
  [AGENT_VALIDATE_FORK](): void {
    assertForkableCreateKeys(this.profile.providedCreateKeys)
    this.assertAttachReachable()
  }

  /** @internal Reject resume options this Agent cannot apply, naming the field. */
  [AGENT_VALIDATE_RESUME](): void {
    const unsupported = this.profile.providedCreateKeys.filter((key) => key === "cwd" || key === "directory")
    const field = unsupported[0]
    if (field) {
      // A fork inherits the source directory, so cwd/directory callers are
      // pointed only at a fresh session rather than at forkSession.
      const remedy =
        field === "cwd" || field === "directory"
          ? "use agent.createSession() for a session with its own directory"
          : "use forkSession: true or agent.createSession() for create-time configuration"
      throw sdkError("configuration", `Cannot apply "${field}" when resuming a session; ${remedy}`)
    }
    this.assertAttachReachable()
  }

  /** @internal Stream over a caller-supplied session factory (fresh, resumed, or forked). */
  [AGENT_SESSION_STREAM](
    startSession: () => Promise<Session>,
    prompt: PromptInput,
    options?: AgentStreamOptions,
    onFinish?: () => Promise<void>,
  ): AgentStream {
    this.assertOpen()
    let stream: AgentStream
    stream = createAgentStream({
      singleTurn: !isAsyncIterable(prompt),
      signal: options?.signal,
      start: async () => {
        const session = await this.trackOperation(startSession())
        if (this.closed) {
          await session.close()
          throw sdkError("closed", "Agent is closed")
        }
        return {
          session,
          iterator: session.stream(prompt, {
            includePartialMessages: options?.includePartialMessages,
          }),
        }
      },
      onUntrack: () => {
        this.streams.delete(stream)
      },
      onFinish,
    })
    this.streams.add(stream)
    return stream
  }

  private async consume(stream: AgentStream): Promise<RunResult> {
    let next = await stream.next()
    while (!next.done) next = await stream.next()
    if (!next.value) {
      // A close racing this run is the overwhelmingly likely cause, and
      // "Agent is closed" says so; the generic message is the last resort.
      this.assertOpen()
      throw sdkError("protocol", "Agent stream completed without a result")
    }
    return {
      ...next.value,
      text: next.value.text ?? "",
      isError: next.value.subtype !== "success",
    }
  }

  private resolveCreateOptions(
    prompt: PromptInput | undefined,
    options: RunOptions | AgentSessionOptions | undefined,
  ): SessionCreateOptions {
    const runtimeConfig: RuntimeConfig = {
      ...(this.profile.create.runtimeConfig ?? {}),
      ...definedRuntimeOverrides(options),
    }
    assertSupportedRuntimeConfig(runtimeConfig)
    return {
      ...(options?.cwd !== undefined || this.profile.create.cwd !== undefined
        ? { cwd: options?.cwd ?? this.profile.create.cwd }
        : {}),
      title: options?.title ?? this.profile.create.title ?? deriveAgentTitle(prompt),
      ...(options?.permission !== undefined || this.profile.create.permission !== undefined
        ? { permission: options?.permission ?? this.profile.create.permission }
        : {}),
      runtimeConfig,
    }
  }

  private async createFreshSession(options: SessionCreateOptions): Promise<Session> {
    const client = await this.getClient()
    this.assertOpen()
    const session = await client.sessions.create(options)
    if (this.deleteSessionsOnClose) this.createdSessions.set(session.id, client)
    return this.ownSession(client, session)
  }

  private async attachSession(sessionId: string): Promise<Session> {
    const client = await this.getClient()
    this.assertOpen()
    const release = claimFacadeSession(client, sessionId, this.owner)
    const runtimeConfig: RuntimeConfig = Object.fromEntries(
      this.profile.providedRuntimeKeys.map((key) => [key, this.profile.create.runtimeConfig?.[key]]),
    )
    if (this.profile.providedCreateKeys.includes("tools"))
      runtimeConfig.sdkMcpServers = this.profile.create.runtimeConfig?.sdkMcpServers ?? []
    const overrides = {
      ...(Object.keys(runtimeConfig).length ? { runtimeConfig } : {}),
      ...(this.profile.create.title !== undefined ? { title: this.profile.create.title } : {}),
      ...(this.profile.create.permission !== undefined ? { permission: this.profile.create.permission } : {}),
    }
    const session = await client.sessions
      .resume(sessionId, Object.keys(overrides).length ? overrides : undefined)
      .catch((error) => {
        release()
        throw withMissingSessionHint(error)
      })
    try {
      this.ownSession(client, session, release)
      this.assertOpen()
      return session
    } catch (error) {
      const cleanup = await session.close().then(
        () => undefined,
        (cleanupError) => cleanupError,
      )
      if (cleanup !== undefined && cleanup !== error) {
        throw new AggregateError([error, cleanup], `Failed to attach and configure session ${sessionId}`)
      }
      throw error
    }
  }

  private async createFork(sessionId: string, options?: { messageId?: string }): Promise<Session> {
    const client = await this.getClient()
    this.assertOpen()
    const base = this.profile.create.runtimeConfig ?? {}
    const runtimeConfig: RuntimeConfig = {
      ...base,
      ...(base.systemPrompt === undefined && base.instructions === undefined
        ? { systemPrompt: NEUTRAL_BASE_PROMPT }
        : {}),
    }
    const session = await client.sessions
      .fork(sessionId, {
        messageId: options?.messageId,
        title: this.profile.create.title ?? "Agent session",
        permission: this.profile.create.permission,
        runtimeConfig,
      })
      .catch((error) => {
        throw withMissingSessionHint(error)
      })
    if (this.deleteSessionsOnClose) this.createdSessions.set(session.id, client)
    return this.ownSession(client, session)
  }

  private ownSession(client: AgentClient, session: Session, existingRelease?: () => void): Session {
    if (this.sessions.has(session)) return session
    const release = existingRelease ?? claimFacadeSession(client, session.id, this.owner)
    this.sessions.add(session)
    this.sessionsById.set(session.id, session)
    session.onClosed(() => {
      this.sessions.delete(session)
      if (this.sessionsById.get(session.id) === session) this.sessionsById.delete(session.id)
      release()
    })
    if (!this.closed) return session
    void session.close()
    throw sdkError("closed", "Agent is closed")
  }

  private getClient(): Promise<AgentClient> {
    if (this.profile.connection.kind === "canonical") return acquireCanonicalClient()
    if (this.profile.connection.kind === "injected") return Promise.resolve(this.profile.connection.client)
    if (!this.dedicatedCreation) {
      // Forget a failed creation so a later call retries, but only if it is
      // still the current one — and attach the handler once, at creation, so
      // repeated calls cannot pile listeners onto a rejected promise.
      const creation = createDedicatedClient(this.profile.connection.options)
      this.dedicatedCreation = creation
      creation.catch(() => {
        if (this.dedicatedCreation === creation) this.dedicatedCreation = undefined
      })
    }
    return this.dedicatedCreation
  }

  private assertAttachReachable(): void {
    if (this.profile.connection.kind !== "dedicated") return
    if (this.dedicatedCreation) return
    if (this.profile.connection.options.baseUrl !== undefined) return
    if (this.profile.connection.options.spawn?.isolated === false) return
    throw sdkError(
      "configuration",
      "Cannot resume or fork from a fresh dedicated isolated server; use the canonical process-global server, baseUrl, or an injected client",
    )
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }

  private assertOpen(): void {
    if (this.closed) throw sdkError("closed", "Agent is closed")
  }

  private async closeOwnedResources(): Promise<void> {
    const errors: unknown[] = []
    const streams = await Promise.allSettled([...this.streams].map((stream) => stream.close()))
    errors.push(...rejections(streams))
    await Promise.allSettled([...this.operations])
    const sessions = await Promise.allSettled([...this.sessions].map((session) => session.close()))
    errors.push(...rejections(sessions))
    this.sessions.clear()
    this.sessionsById.clear()
    const deleted = await Promise.allSettled(
      [...this.createdSessions].map(([id, client]) => client.sessions.delete(id)),
    )
    errors.push(...rejections(deleted))
    this.createdSessions.clear()
    if (this.profile.connection.kind === "dedicated" && this.dedicatedCreation) {
      const client = await this.dedicatedCreation.then(
        (value) => value,
        () => undefined,
      )
      if (client) {
        const closed = await Promise.allSettled([closeDedicatedClient(client)])
        errors.push(...rejections(closed))
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Failed to close Agent")
  }
}

function definedRuntimeOverrides(options: RunOptions | AgentSessionOptions | undefined): RuntimeConfig {
  if (!options) return {}
  return {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.outputFormat !== undefined ? { outputFormat: options.outputFormat } : {}),
  }
}

/**
 * Report a promise-returning method's setup failure as a rejection.
 *
 * `begin` still runs synchronously, so handle registration and memo writes keep
 * their ordering; only a synchronous throw is converted. `stream()` is
 * deliberately excluded — it returns a handle rather than a promise and is
 * documented to throw.
 */
function rejectable<T>(begin: () => Promise<T>): Promise<T> {
  try {
    return begin()
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Reject a working-directory override on a fork, which inherits the source's. */
function assertForkableCreateKeys(providedCreateKeys: string[]): void {
  const cwd = providedCreateKeys.find((key) => key === "cwd" || key === "directory")
  if (!cwd) return
  throw sdkError(
    "configuration",
    `Cannot apply "${cwd}" when forking: Cognitio forks inherit the source session directory. Omit it or create a fresh session.`,
  )
}

/** Add the per-process server hint to a low-level missing-session failure. */
function withMissingSessionHint(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.includes("Failed to locate session")) return error
  return sdkError(
    "transport",
    `${error.message}. The canonical server is process-local and shutdown() ends it; use the canonical client, baseUrl, or an injected client that owns this session.`,
    { cause: error },
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  )
}

function rejections(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.filter((result) => result.status === "rejected").map((result) => result.reason)
}
