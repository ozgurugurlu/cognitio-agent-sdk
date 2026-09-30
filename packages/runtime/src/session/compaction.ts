import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { SessionCheckpoint } from "./checkpoint"
import { Plugin } from "@/plugin"
import { HookBridge } from "./hook-bridge"
import { Config } from "@/config"
import { NotFoundError } from "@/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context } from "effect"
import { EffectLogger, InstanceState } from "@/effect"
import { isOverflow as overflow, usable } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import type { RuntimeConfig } from "./runtime-config"
import { resolveHelperSystemPrompt } from "./system-prompt"

const log = EffectLogger.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
  Boundary: BusEvent.define(
    "system.compact_boundary",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod.optional(),
      checkpointId: z.string().optional(),
      auto: z.boolean(),
      overflow: z.boolean(),
      tailStartMessageID: MessageID.zod.optional(),
      trigger: z.enum(["auto", "manual"]).optional(),
      preCompactTokenCount: z.number().int().nonnegative().optional(),
      compactionId: MessageID.zod.optional(),
      preservedMessageIds: z.array(MessageID.zod).optional(),
      summaryText: z.string().optional(),
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function preservedTailIDs(input: { messages: MessageV2.WithParts[]; tailStartMessageID?: MessageID }) {
  if (!input.tailStartMessageID) return []
  const index = input.messages.findIndex((message) => message.info.id === input.tailStartMessageID)
  if (index === -1) return []
  return input.messages.slice(index).map((message) => message.info.id)
}

function additionalInstructions(...items: Array<string | undefined>) {
  const text = items.filter((item): item is string => typeof item === "string" && item.length > 0).join("\n\n")
  if (!text) return []
  return [`Additional Instructions:\n${text}`]
}

function postCompactPayload(input: {
  trigger: "auto" | "manual"
  auto: boolean
  overflow?: boolean
  result: "continue" | "stop"
  compactionId?: MessageID
  preCompactTokenCount: number
  preservedMessageIds: MessageID[]
}) {
  return {
    trigger: input.trigger,
    auto: input.auto,
    overflow: input.overflow,
    result: input.result,
    ...(input.compactionId !== undefined ? { compactionId: input.compactionId } : {}),
    preCompactTokenCount: input.preCompactTokenCount,
    preservedMessageIds: input.preservedMessageIds,
  }
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    model?: { providerID: ProviderID; modelID: ModelID }
    overflow?: boolean
    runtime?: RuntimeConfig
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
    customInstructions?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const hookRun = HookBridge.run
    const hookNotify = HookBridge.notify

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )
      if (sizes.at(-1)! > budget) {
        yield* log.info("tail fallback", { budget, size: sizes.at(-1) })
        return { head: input.messages, tail_start_id: undefined }
      }

      let total = 0
      let keep: Turn | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const size = sizes[i]
        if (total + size > budget) break
        total += size
        keep = recent[i]
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type === "tool")
            if (part.state.status === "completed") {
              if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
              if (part.state.time.compacted) break loop
              const estimate = Token.estimate(part.state.output)
              total += estimate
              if (total > PRUNE_PROTECT) {
                pruned += estimate
                toPrune.push(part)
              }
            }
        }
      }

      yield* log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      model?: { providerID: ProviderID; modelID: ModelID }
      overflow?: boolean
      runtime?: RuntimeConfig
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* AgentRuntime.get("compaction", input.runtime).pipe(
        Effect.provideService(Agent.Service, agents),
      )
      if (!agent) throw new Error("Compaction agent is not configured")
      const modelRef = input.model ?? agent.model ?? userMessage.model
      const model = yield* provider.getModel(modelRef.providerID, modelRef.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const trigger = input.auto ? "auto" : "manual"
      const preCompactTokenCount = yield* estimate({ messages: history, model })
      const selected = yield* select({
        messages: history,
        cfg,
        model,
      })
      const tailStartMessageID = selected.tail_start_id ?? compactionPart?.tail_start_id
      const preservedMessageIds = preservedTailIDs({ messages: history, tailStartMessageID })
      const preCompactPayload = {
        trigger,
        auto: input.auto,
        overflow: input.overflow,
        messageCount: history.length,
        preCompactTokenCount,
        ...(compactionPart?.customInstructions ? { customInstructions: compactionPart.customInstructions } : {}),
      }
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const prePlugin = yield* plugin.trigger(
        "session.pre_compact",
        { sessionID: input.sessionID, ...preCompactPayload },
        { context: [], prompt: undefined, customInstructions: undefined },
      )
      const preHook = yield* hookRun({
        sessionID: input.sessionID,
        runtime: input.runtime,
        event: "PreCompact",
        target: trigger,
        data: preCompactPayload,
      })
      if (preHook.continue === false) {
        if (compactionPart) {
          yield* session.removePart({
            sessionID: input.sessionID,
            messageID: input.parentID,
            partID: compactionPart.id,
          })
        }
        const postPayload = postCompactPayload({
          trigger,
          auto: input.auto,
          overflow: input.overflow,
          result: "stop",
          preCompactTokenCount,
          preservedMessageIds,
        })
        yield* plugin.trigger("session.post_compact", { sessionID: input.sessionID, ...postPayload }, {})
        yield* hookNotify({
          sessionID: input.sessionID,
          runtime: input.runtime,
          event: "PostCompact",
          target: trigger,
          data: postPayload,
        })
        return "stop"
      }
      const defaultPrompt = `When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`
      const neutralPrompt = defaultPrompt.replace(
        /## Relevant files \/ directories[\s\S]*---$/,
        "## References\n\n[Retain useful sources, identifiers, and references needed to continue the task.]\n---",
      )

      const prompt =
        prePlugin.prompt ??
        compacting.prompt ??
        [
          input.runtime?.compaction?.includeFiles === true ||
          (input.runtime?.compaction?.includeFiles !== false && input.runtime?.systemPrompt === undefined)
            ? defaultPrompt
            : neutralPrompt,
          ...compacting.context,
          ...prePlugin.context,
          ...additionalInstructions(
            compactionPart?.customInstructions,
            prePlugin.customInstructions,
            preHook.customInstructions,
          ),
          ...preHook.systemMessage,
          ...preHook.additionalContext,
        ].join("\n\n")
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        parentMessageID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        runtime: input.runtime,
      })
      const checkpoint =
        (input.runtime?.checkpointing?.enabled ?? input.runtime?.enableFileCheckpointing) === true &&
        input.runtime?.checkpointing?.beforeCompaction !== false
          ? yield* SessionCheckpoint.Service.use((svc) =>
              svc.create({
                sessionID: input.sessionID,
                messageID: input.parentID,
                source: "auto",
                allowBusy: true,
                metadata: { reason: "compaction" },
              }),
            ).pipe(
              Effect.provide(SessionCheckpoint.defaultLayer),
              Effect.catchCause(() =>
                log.warn("compaction checkpoint failed", { sessionID: input.sessionID }).pipe(Effect.as(undefined)),
              ),
            )
          : undefined
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        systemPromptOverride: resolveHelperSystemPrompt(input.runtime ?? {}, agent.prompt),
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            parentMessageID: processor.message.id,
            agent: original.agent,
            model: input.model ?? original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model,
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              parentMessageID: processor.message.id,
              agent: userMessage.agent,
              model: input.model ?? userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const completed = yield* session.findMessage(
          input.sessionID,
          (message) => message.info.id === processor.message.id,
        )
        const summaryText =
          completed._tag === "Some"
            ? completed.value.parts
                .filter((part): part is MessageV2.TextPart => part.type === "text")
                .map((part) => part.text)
                .join("")
            : undefined
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        yield* bus.publish(Event.Boundary, {
          sessionID: input.sessionID,
          messageID: input.parentID,
          partID: compactionPart?.id,
          checkpointId: checkpoint?.id,
          auto: input.auto,
          overflow: input.overflow === true,
          tailStartMessageID,
          trigger,
          preCompactTokenCount,
          compactionId: processor.message.id,
          preservedMessageIds,
          summaryText,
        })
      }
      const postPayload = postCompactPayload({
        trigger,
        auto: input.auto,
        overflow: input.overflow,
        result,
        compactionId: processor.message.id,
        preCompactTokenCount,
        preservedMessageIds,
      })
      yield* plugin.trigger("session.post_compact", { sessionID: input.sessionID, ...postPayload }, {})
      yield* hookNotify({
        sessionID: input.sessionID,
        runtime: input.runtime,
        event: "PostCompact",
        target: trigger,
        data: postPayload,
      })
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
      customInstructions?: string
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        parentMessageID: yield* MessageV2.lookupLastMessageID(input.sessionID),
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    customInstructions: z.string().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
