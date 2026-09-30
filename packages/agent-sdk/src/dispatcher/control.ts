import { sdkError } from "../errors.js"
import type {
  ControlRequest,
  ControlSubtype,
  Event as CognitioEvent,
  CognitioClient,
} from "../internal/runtime-client/index.js"
import type {
  CanUseToolCallback,
  ControlOptions,
  HookEventName,
  HookRegistration,
  HookResult,
  PermissionDecision,
  SdkMcpServer,
} from "../types.js"
import { assertOk } from "../internal/errors.js"
import { extractSessionID } from "../internal/events.js"
import { normalizeHookCallbacks, type LocalHookEntry } from "../internal/runtime-config.js"
import { backoffDelay, sleep, subscribeEvents } from "../transport/sse.js"
import { LocalControlRegistry } from "./registry.js"

const DEFAULT_READY_TIMEOUT_MS = 3_000
const DEFAULT_RECONNECT = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
}
const POLICY_HOOK_EVENTS = new Set<HookEventName>(["PreToolUse", "BeforeShellExecution"])

export interface DispatcherOptions {
  client: CognitioClient
  sessionId: string
  directory: string
  workspaceId?: string
  control?: ControlOptions
  canUseTool?: CanUseToolCallback
  hooks?: HookRegistration
  sdkMcpServers?: SdkMcpServer[]
}

export interface Dispatcher {
  readonly sessionId: string
  start(): Promise<void>
  stop(): Promise<void>
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  return new ControlDispatcher(opts)
}

class ControlDispatcher implements Dispatcher {
  readonly sessionId: string
  private readonly registry = new LocalControlRegistry()
  private readonly reconnect: Required<NonNullable<ControlOptions["reconnect"]>>
  private readonly readyTimeoutMs: number
  private controller: AbortController | undefined
  private ready:
    | {
        promise: Promise<void>
        resolve: () => void
        reject: (error: unknown) => void
        settled: boolean
      }
    | undefined
  private started = false
  private stopped = false
  private runPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private readonly inFlight = new Set<Promise<void>>()
  private readonly hooks: Partial<Record<HookEventName, LocalHookEntry[]>>

  constructor(private readonly opts: DispatcherOptions) {
    this.sessionId = opts.sessionId
    this.hooks = normalizeHookCallbacks(opts.hooks)
    this.readyTimeoutMs = opts.control?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.reconnect = {
      maxAttempts: opts.control?.reconnect?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
      initialDelayMs: opts.control?.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
      maxDelayMs: opts.control?.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    }
  }

  start(): Promise<void> {
    if (this.ready) return this.ready.promise

    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    this.ready = {
      promise: new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      }),
      resolve: resolveReady,
      reject: rejectReady,
      settled: false,
    }

    const timeout = setTimeout(() => {
      this.rejectReady(
        sdkError("transport", `Timed out waiting for control dispatcher readiness for session ${this.sessionId}`),
      )
      void this.stop()
    }, this.readyTimeoutMs)
    this.ready.promise.then(
      () => clearTimeout(timeout),
      () => clearTimeout(timeout),
    )

    this.started = true
    this.stopped = false
    this.runPromise = this.run().catch((error) => {
      this.rejectReady(error)
    })

    return this.ready.promise
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = (async () => {
      if (!this.started) return
      this.stopped = true
      this.controller?.abort()
      this.registry.stop()
      await this.runPromise
      await Promise.all(Array.from(this.inFlight))
    })()
    return this.stopPromise
  }

  private async run(): Promise<void> {
    let attempt = 0
    let readyResolved = false
    let lastError: unknown
    while (!this.stopped) {
      attempt++
      if (attempt > this.reconnect.maxAttempts) break
      this.controller = new AbortController()
      const signal = this.controller.signal

      try {
        const { stream } = await subscribeEvents(this.opts.client, {
          directory: this.opts.directory,
          workspaceId: this.opts.workspaceId,
          signal,
        })

        for await (const event of stream) {
          if (this.stopped || signal.aborted) return
          if (isServerConnected(event)) {
            await this.recoverPending()
            if (!readyResolved) {
              readyResolved = true
              attempt = 0
            }
            this.resolveReady()
            continue
          }
          this.handleEvent(event)
        }
      } catch (error) {
        if (this.stopped || signal.aborted) return
        lastError = error
        if (attempt >= this.reconnect.maxAttempts) {
          this.rejectReady(error)
          return
        }
      }

      if (this.stopped) return
      await sleep(backoffDelay(attempt, this.reconnect), this.controller.signal)
    }
    this.rejectReady(
      lastError ??
        sdkError("transport", `Control dispatcher reconnect attempts exhausted for session ${this.sessionId}`),
    )
  }

  private async recoverPending(): Promise<void> {
    const result = await this.opts.client.session.controlChannel.list({
      sessionID: this.sessionId,
      directory: this.opts.directory,
      workspace: this.opts.workspaceId,
    })
    assertOk(result, "Failed to list pending control requests")
    const requests = Array.isArray(result.data)
      ? result.data
      : Object.values((result.data ?? {}) as Record<string, ControlRequest>)
    requests.forEach((request) => this.dispatchRequest(request))
  }

  private handleEvent(event: CognitioEvent): void {
    if (extractSessionID(event) !== this.sessionId) return
    if (isControlRequest(event)) {
      this.dispatchRequest(event.properties)
      return
    }
    if (isControlCancelled(event)) {
      this.registry.cancel(event.properties.id)
    }
  }

  private dispatchRequest(request: ControlRequest): void {
    const controller = this.registry.add(request.id)
    if (!controller) return
    const task = this.respond(request, controller)
      .catch(() => {
        if (controller.signal.aborted) return
        this.registry.release(request.id)
      })
      .finally(() => {
        this.inFlight.delete(task)
      })
    this.inFlight.add(task)
    void task
  }

  private async respond(request: ControlRequest, controller: AbortController): Promise<void> {
    const response = await this.responseFor(request, controller)
    if (controller.signal.aborted) return
    const result = await this.opts.client.session.controlChannel.response(
      {
        sessionID: this.sessionId,
        directory: this.opts.directory,
        workspace: this.opts.workspaceId,
        controlResponseBody: {
          requestID: request.id,
          subtype: request.subtype,
          response,
        },
      },
      { signal: controller.signal },
    )
    assertOk(result, `Failed to respond to control request ${request.id}`)
    this.registry.complete(request.id)
  }

  private async responseFor(request: ControlRequest, controller: AbortController): Promise<Record<string, unknown>> {
    switch (request.subtype) {
      case "can_use_tool":
        return this.canUseTool(request, controller)
      case "hook_callback":
        return this.hookCallback(request, controller)
      case "elicitation":
        await sleep(1, controller.signal)
        return fallbackResponse(request.subtype)
      case "mcp_message":
        return this.mcpMessage(request, controller)
    }
  }

  private async canUseTool(request: ControlRequest, controller: AbortController): Promise<Record<string, unknown>> {
    if (!this.opts.canUseTool) return { behavior: "deny", message: "No canUseTool callback registered" }
    try {
      const payload = request.payload as Record<string, unknown>
      return (
        normalizeCanUseToolDecision(
          await withStrictTimeout(
            Promise.resolve(
              this.opts.canUseTool(String(payload.toolName ?? payload.tool ?? ""), inputRecord(payload.input), {
                sessionId: activeSessionID(payload, this.sessionId),
                rootSessionId: this.sessionId,
                toolCallId: stringValue(payload.callID) ?? stringValue(payload.toolCallId),
                signal: controller.signal,
              }),
            ),
            requestTimeoutMs(request),
            controller.signal,
          ),
        ) ?? { behavior: "deny", message: "Invalid canUseTool response" }
      )
    } catch (error) {
      return {
        behavior: "deny",
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async hookCallback(request: ControlRequest, controller: AbortController): Promise<Record<string, unknown>> {
    const payload = request.payload as {
      event?: unknown
      descriptors?: unknown
      data?: unknown
      target?: unknown
    }
    if (typeof payload.event !== "string" || !Array.isArray(payload.descriptors)) return { continue: true }
    const event = payload.event as HookEventName
    const local = this.hooks[event] ?? []
    const target = String(payload.target ?? payload.event)
    const descriptors = payload.descriptors
      .filter(isDescriptor)
      .filter((descriptor) => descriptorMatches(descriptor, target))
    const callbacks = descriptors.flatMap((descriptor) => {
      const entry = local.find((item) => item.id === descriptor.id)
      if (!entry) return []
      if (!matches(entry, target)) return []
      return [{ descriptor, entry }]
    })
    const missingCallback = descriptors.some(
      (descriptor) => !callbacks.some((callback) => callback.descriptor.id === descriptor.id),
    )
    if (missingCallback && POLICY_HOOK_EVENTS.has(event)) {
      return {
        continue: false,
        stopReason: `No local hook callback registered for ${event}`,
        permissionDecision: {
          behavior: "deny",
          message: `No local hook callback registered for ${event}`,
        },
      }
    }
    if (callbacks.length === 0) return { continue: true }
    const data = inputRecord(payload.data)
    const results = await Promise.all(
      callbacks.map((item) =>
        callHook(
          item.entry,
          {
            event,
            sessionId: activeSessionID(payload as Record<string, unknown>, this.sessionId),
            rootSessionId: this.sessionId,
            toolCallId:
              stringValue((payload as Record<string, unknown>).callID) ??
              stringValue((payload as Record<string, unknown>).toolCallId) ??
              stringValue(data.callID) ??
              stringValue(data.toolCallId),
            signal: controller.signal,
            data,
          },
          controller.signal,
        ),
      ),
    )
    return aggregateHooks(results)
  }

  private async mcpMessage(request: ControlRequest, controller: AbortController): Promise<Record<string, unknown>> {
    const payload = request.payload as Record<string, unknown>
    const server = this.opts.sdkMcpServers?.find((item) => item.name === payload.server && item.transport === "direct")
    const tool = server?.tools.find((item) => item.name === payload.tool)
    if (!payload.server && !payload.tool) return fallbackResponse("mcp_message")
    if (!server || !tool)
      return { error: `Unknown direct SDK MCP tool: ${String(payload.server)}/${String(payload.tool)}` }
    try {
      return toMcpResult(
        await withStrictTimeout(
          Promise.resolve(
            tool.execute(inputRecord(payload.input), {
              sessionId: activeSessionID(payload, this.sessionId),
              rootSessionId: this.sessionId,
              toolCallId: stringValue(payload.toolCallId),
              signal: controller.signal,
            }),
          ),
          requestTimeoutMs(request),
          controller.signal,
        ),
      ) as Record<string, unknown>
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private resolveReady(): void {
    if (!this.ready || this.ready.settled) return
    this.ready.settled = true
    this.ready.resolve()
  }

  private rejectReady(error: unknown): void {
    if (!this.ready || this.ready.settled) return
    this.ready.settled = true
    this.ready.reject(error)
  }
}

function requestTimeoutMs(request: ControlRequest): number {
  return typeof request.timeoutMs === "number" && request.timeoutMs > 0 ? request.timeoutMs : 30_000
}

function normalizeCanUseToolDecision(
  input: PermissionDecision | "allow" | "deny" | "ask" | void,
): Record<string, unknown> | undefined {
  if (input === "allow") return { behavior: "allow" }
  if (input === "deny") return { behavior: "deny" }
  if (input === "ask") return { behavior: "ask" }
  if (!input || typeof input !== "object") return
  if (input.behavior === "allow") {
    return input.updatedInput ? { behavior: "allow", updatedInput: input.updatedInput } : { behavior: "allow" }
  }
  if (input.behavior === "deny")
    return input.message ? { behavior: "deny", message: input.message } : { behavior: "deny" }
  if (input.behavior === "ask") return { behavior: "ask" }
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function activeSessionID(payload: Record<string, unknown>, fallback: string) {
  return stringValue(payload.activeSessionID) ?? fallback
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function toMcpResult(output: unknown) {
  if (isMcpContentResult(output)) return output
  if (typeof output === "string") return { content: [{ type: "text" as const, text: output }] }
  return { content: [{ type: "text" as const, text: output === undefined ? "" : JSON.stringify(output) }] }
}

function isMcpContentResult(
  input: unknown,
): input is Record<string, unknown> & { content: Array<Record<string, unknown>> } {
  return !!input && typeof input === "object" && Array.isArray((input as { content?: unknown }).content)
}

function isDescriptor(input: unknown): input is { id: string; matcher?: string; matcherFlags?: string } {
  return !!input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string"
}

function descriptorMatches(descriptor: { matcher?: string; matcherFlags?: string }, target: string) {
  if (!descriptor.matcher || descriptor.matcher === "*") return true
  try {
    return new RegExp(descriptor.matcher, descriptor.matcherFlags).test(target)
  } catch {
    return descriptor.matcher === target
  }
}

function matches(entry: LocalHookEntry, target: string): boolean {
  if (!entry.matcherSource || entry.matcherSource === "*") return true
  try {
    return new RegExp(entry.matcherSource, entry.matcherFlags).test(target)
  } catch {
    return entry.matcherSource === target
  }
}

async function callHook(
  entry: LocalHookEntry,
  payload: Parameters<LocalHookEntry["callback"]>[0],
  signal: AbortSignal,
) {
  try {
    return await withSoftTimeout(Promise.resolve(entry.callback(payload)), entry.timeoutMs ?? 10_000, signal)
  } catch {
    return undefined
  }
}

function withStrictTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(sdkError("transport", "Control request was cancelled"))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      fn()
    }
    const abort = () => finish(() => reject(sdkError("transport", "Control request was cancelled")))
    const timer = setTimeout(
      () => finish(() => reject(sdkError("transport", "canUseTool callback timed out"))),
      timeoutMs,
    )
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve(value)
    }
    const abort = () => finish(undefined)
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(finish, () => finish(undefined))
  })
}

function aggregateHooks(results: Array<HookResult | void>): Record<string, unknown> {
  const aggregated = results.reduce(
    (acc, result) => {
      if (!result) return acc
      if (result.continue === false) acc.continue = false
      const decision = normalizeHookPermission(result.permissionDecision)
      acc.permissionDecision = mergeHookDecision(acc.permissionDecision, decision)
      if (decision?.behavior === "allow" && decision.updatedInput) {
        acc.updatedInput = { ...acc.updatedInput, ...decision.updatedInput }
      }
      if (result.updatedInput) acc.updatedInput = { ...acc.updatedInput, ...result.updatedInput }
      if (result.updatedToolOutput !== undefined) acc.updatedToolOutput = result.updatedToolOutput
      if (result.additionalContext) acc.additionalContext.push(result.additionalContext)
      if (result.systemMessage) acc.systemMessage.push(result.systemMessage)
      if (result.customInstructions) acc.customInstructions.push(result.customInstructions)
      if (result.initialUserMessage) acc.initialUserMessage = result.initialUserMessage
      if (result.stopReason) acc.stopReason = result.stopReason
      return acc
    },
    {
      continue: true,
      additionalContext: [] as string[],
      systemMessage: [] as string[],
      customInstructions: [] as string[],
    } as {
      continue: boolean
      permissionDecision?: PermissionDecision
      updatedInput?: Record<string, unknown>
      updatedToolOutput?: unknown
      additionalContext: string[]
      systemMessage: string[]
      customInstructions: string[]
      initialUserMessage?: string
      stopReason?: string
    },
  )
  const customInstructions = aggregated.customInstructions.length
    ? aggregated.customInstructions.join("\n\n")
    : undefined
  return {
    continue: aggregated.continue,
    ...(aggregated.permissionDecision ? { permissionDecision: aggregated.permissionDecision } : {}),
    ...(aggregated.updatedInput ? { updatedInput: aggregated.updatedInput } : {}),
    ...(aggregated.updatedToolOutput !== undefined ? { updatedToolOutput: aggregated.updatedToolOutput } : {}),
    additionalContext: aggregated.additionalContext,
    systemMessage: aggregated.systemMessage,
    ...(customInstructions ? { customInstructions } : {}),
    ...(aggregated.initialUserMessage ? { initialUserMessage: aggregated.initialUserMessage } : {}),
    ...(aggregated.stopReason ? { stopReason: aggregated.stopReason } : {}),
  } as unknown as Record<string, unknown>
}

function mergeHookDecision(
  left: PermissionDecision | undefined,
  right: PermissionDecision | undefined,
): PermissionDecision | undefined {
  if (!left) return right
  if (!right) return left
  if (left.behavior === "deny") return left
  if (right.behavior === "deny") return right
  if (left.behavior === "ask") return left
  if (right.behavior === "ask") return right
  return left.updatedInput || right.updatedInput
    ? { behavior: "allow", updatedInput: { ...left.updatedInput, ...right.updatedInput } }
    : { behavior: "allow" }
}

function normalizeHookPermission(
  input: HookResult["permissionDecision"] | "allow" | "deny" | "ask" | undefined,
): PermissionDecision | undefined {
  if (!input) return
  if (input === "allow") return { behavior: "allow" }
  if (input === "deny") return { behavior: "deny" }
  if (input === "ask") return { behavior: "ask" }
  return input
}

function fallbackResponse(subtype: ControlSubtype): Record<string, unknown> {
  switch (subtype) {
    case "can_use_tool":
      return { behavior: "deny", message: "No canUseTool callback registered" }
    case "hook_callback":
      return { continue: true }
    case "elicitation":
      return { behavior: "decline", message: "No elicitation handler registered" }
    case "mcp_message":
      return { error: "No SDK MCP message handler registered" }
  }
}

function isServerConnected(event: CognitioEvent): boolean {
  return event.type === "server.connected"
}

function isControlRequest(event: CognitioEvent): event is Extract<CognitioEvent, { type: "control.request" }> {
  return event.type === "control.request"
}

function isControlCancelled(event: CognitioEvent): event is Extract<CognitioEvent, { type: "control.cancelled" }> {
  return event.type === "control.cancelled"
}
