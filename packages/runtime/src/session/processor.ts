import { Cause, Deferred, Effect, Fiber, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Flag } from "@/flag/flag"
import { Agent } from "@/agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionRuntimeConfig } from "./runtime-config"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider"
import { Question } from "@/question"
import { SessionMetrics } from "@/effect/metrics"
import { ControlRequestRegistry } from "@/session/control-registry"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import * as EffectLogger from "@/effect/logger"

const DOOM_LOOP_THRESHOLD = 3
// Minimum gap between task.progress events per tool call. Chatty tools (bash
// streams a metadata update per output chunk) would otherwise flood the bus.
const TASK_PROGRESS_THROTTLE_MS = 500
const TASK_HEARTBEAT_DEFAULT_MS = 10_000
// Task event payloads may be forwarded to dashboards standalone: no raw
// command/prompt/stdout/stack content. Titles are short tool-provided
// summaries (they may contain relative paths or glob patterns) and all text
// fields are truncated.
const TASK_EVENT_TEXT_LIMIT = 256
const elog = EffectLogger.create({ service: "session.processor" })

function taskEventText(value: string | undefined) {
  if (!value) return undefined
  return value.length > TASK_EVENT_TEXT_LIMIT ? value.slice(0, TASK_EVENT_TEXT_LIMIT) : value
}

// Conservative error text for task events: only explicit message strings.
// Arbitrary error shapes would JSON-serialize through errorMessage's fallback
// and could leak tool input/output into the observability channel — omit
// those (the full errorMessage still lands on the tool part / transcript).
function taskEventError(error: unknown) {
  if (typeof error === "string") return taskEventText(error)
  if (error instanceof Error && error.message) return taskEventText(error.message)
  if (isRecord(error) && typeof error.message === "string" && error.message) return taskEventText(error.message)
  return undefined
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  runtime?: SessionRuntimeConfig.RuntimeConfig
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  // Wall-clock execution start stamped on the pending→running transition.
  // Task event timing must come from here — the tool metadata callback
  // rewrites part.state.time.start on every update.
  startedAt?: number
  tool?: string
  lastProgressAt?: number
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@cognitio/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        runtime: input.runtime,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false
      const slog = elog.with({ sessionID: input.sessionID, messageID: input.assistantMessage.id })
      // Observability events are root-routed (same pattern as subagent.*):
      // parent SDK streams filter by root session ID, so child-session tool
      // and rate-limit activity stays visible. Lineage is static for the
      // session's lifetime — resolve once.
      const rootSessionID = ControlRequestRegistry.lineage(input.sessionID).rootSessionID

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const taskEventBase = (toolCallID: string, part: MessageV2.ToolPart) => ({
        sessionID: rootSessionID,
        activeSessionID: ctx.sessionID,
        taskID: toolCallID,
        messageID: part.messageID,
        partID: part.id,
        tool: part.tool,
        agent: ctx.assistantMessage.agent,
      })

      const publishRateLimit = (info: { attempt?: number; retryAfterSeconds?: number; message?: string }) =>
        Effect.gen(function* () {
          yield* bus.publish(Session.Event.RateLimitHit, {
            sessionID: rootSessionID,
            activeSessionID: ctx.sessionID,
            provider: input.model.providerID,
            model: input.model.id,
            attempt: info.attempt,
            retryAfterSeconds: info.retryAfterSeconds,
            message: taskEventText(info.message),
          })
          yield* SessionMetrics.recordRateLimit({ provider: input.model.providerID, sessionID: ctx.sessionID })
          yield* elog.warn("session rate limited", {
            sessionID: ctx.sessionID,
            provider: input.model.providerID,
            model: input.model.id,
            attempt: info.attempt,
            retryAfterSeconds: info.retryAfterSeconds,
          })
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        // Task lifecycle transitions are detected here — the single choke
        // point both the stream's tool-call event and the tool metadata
        // callback flow through. Note the first metadata update can arrive
        // before tool-input-start is drained; readToolCall then finds no
        // record and the update (plus its task event) is dropped —
        // pre-existing race, accepted.
        const previousStatus = match.part.state.status
        const part = yield* session.updatePart(update(match.part))
        const call: ToolCall = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        const now = Date.now()
        if (previousStatus === "pending" && part.state.status === "running") {
          call.startedAt = now
          call.tool = part.tool
          ctx.toolcalls[toolCallID] = call
          yield* bus.publish(Session.Event.TaskStarted, taskEventBase(toolCallID, part))
          yield* elog.info("session task started", { sessionID: ctx.sessionID, tool: part.tool, toolCallID })
          return part
        }
        if (previousStatus === "running" && part.state.status === "running") {
          const throttled = call.lastProgressAt !== undefined && now - call.lastProgressAt < TASK_PROGRESS_THROTTLE_MS
          if (!throttled) {
            call.lastProgressAt = now
            ctx.toolcalls[toolCallID] = call
            yield* bus.publish(Session.Event.TaskProgress, {
              ...taskEventBase(toolCallID, part),
              title: taskEventText(part.state.title),
              elapsedMs: Math.max(0, now - (call.startedAt ?? part.state.time.start)),
            })
            return part
          }
        }
        ctx.toolcalls[toolCallID] = call
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        const end = Date.now()
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end },
            attachments: output.attachments,
          },
        })
        yield* bus.publish(Session.Event.TaskStopped, {
          ...taskEventBase(toolCallID, match.part),
          status: "completed",
          durationMs: Math.max(0, end - (match.call.startedAt ?? match.part.state.time.start)),
          title: taskEventText(output.title),
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        const end = Date.now()
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end },
          },
        })
        yield* bus.publish(Session.Event.TaskStopped, {
          ...taskEventBase(toolCallID, match.part),
          status: "error",
          durationMs: Math.max(0, end - (match.call.startedAt ?? match.part.state.time.start)),
          error: taskEventError(error),
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" }, ctx.runtime)
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* AgentRuntime.get(ctx.assistantMessage.agent, ctx.runtime).pipe(
              Effect.provideService(Agent.Service, agents),
            )
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent?.permission ?? [],
            })
            return
          }

          case "tool-result": {
            yield* completeToolCall(value.toolCallId, value.output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            yield* SessionMetrics.recordModelUsage({
              providerID: ctx.model.providerID,
              modelID: ctx.model.id,
              tokens: usage.tokens,
              cost: usage.cost,
              sessionID: ctx.sessionID,
            })
            // handleEvent is fnUntraced, so this lands on the enclosing
            // SessionProcessor.process span — this request's usage (GenAI
            // semconv: input includes cache, output includes reasoning).
            yield* Effect.annotateCurrentSpan({
              "gen_ai.usage.input_tokens": usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
              "gen_ai.usage.output_tokens": usage.tokens.output + usage.tokens.reasoning,
              "cognitio.usage.cache_read_tokens": usage.tokens.cache.read,
              "cognitio.usage.cache_write_tokens": usage.tokens.cache.write,
              "cognitio.usage.reasoning_tokens": usage.tokens.reasoning,
              "cognitio.cost_usd": usage.cost,
            })
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: yield* snapshot.track(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              ctx.runtime?.compaction?.auto !== false &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return

          default:
            yield* slog.debug("unhandled model event", { event: value.type })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
          // task.stopped is only emitted for calls that actually started
          // (task.started fired) — pending stragglers stay event-less.
          if (part.state.status === "running") {
            yield* bus.publish(Session.Event.TaskStopped, {
              ...taskEventBase(toolCallID, part),
              status: "interrupted",
              durationMs: Math.max(0, end - (match.call.startedAt ?? part.state.time.start)),
            })
          }
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* slog.error("process failed", { errorType: e instanceof Error ? e.name : typeof e })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error) && ctx.runtime?.compaction?.auto !== false) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        // Rate limits the provider marks non-retryable never reach the retry
        // policy — surface them here so consumers still see the event.
        const kind = SessionRetry.kindOf(error)
        if (!aborted && kind?.kind === "rate_limit") {
          yield* publishRateLimit({ message: kind.message })
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
      })

      // Emits task.notification(still_running) for tool calls that have been
      // executing longer than the heartbeat interval, so silent long-running
      // tools stay visible without parsing part updates. One fiber per
      // process() call; it keeps ticking through retry backoff on purpose
      // (tool calls from a failed attempt linger in ctx.toolcalls until the
      // final cleanup, so they still read as running).
      const heartbeat = Effect.fnUntraced(function* () {
        const interval = Flag.COGNITIO_TASK_HEARTBEAT_MS ?? TASK_HEARTBEAT_DEFAULT_MS
        yield* Effect.gen(function* () {
          const now = Date.now()
          for (const [taskID, call] of Object.entries(ctx.toolcalls)) {
            if (call.startedAt === undefined || call.tool === undefined) continue
            const elapsed = now - call.startedAt
            if (elapsed < interval) continue
            yield* bus.publish(Session.Event.TaskNotification, {
              sessionID: rootSessionID,
              activeSessionID: ctx.sessionID,
              taskID,
              messageID: call.messageID,
              partID: call.partID,
              tool: call.tool,
              agent: ctx.assistantMessage.agent,
              kind: "still_running",
              elapsedMs: elapsed,
            })
          }
        }).pipe(Effect.delay(interval), Effect.forever)
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const ticker = yield* heartbeat().pipe(Effect.forkChild)

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            const stream = llm.stream({ ...streamInput, runtime: streamInput.runtime ?? ctx.runtime })

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) =>
                  Effect.gen(function* () {
                    yield* status.set(
                      ctx.sessionID,
                      {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        next: info.next,
                      },
                      ctx.runtime,
                    )
                    if (info.kind === "rate_limit") {
                      yield* publishRateLimit({
                        attempt: info.attempt,
                        retryAfterSeconds: info.delayMs / 1000,
                        message: info.message,
                      })
                    }
                  }),
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        }).pipe(Effect.ensuring(Fiber.interrupt(ticker)))
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
