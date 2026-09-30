import { Config } from "@/config"
import { Provider } from "@/provider"
import { usable } from "./overflow"
import { SessionCompaction } from "./compaction"
import { Token } from "@/util"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, type SessionID } from "./schema"
import { type ModelID, type ProviderID } from "@/provider/schema"
import * as Session from "./session"

export const copy = Effect.fn("SubagentInherit.copy")(function* (input: {
  parentSessionID: SessionID
  childSessionID: SessionID
  boundaryMessageID?: MessageID
  model?: { providerID: ProviderID; modelID: ModelID }
}) {
  const sessions = yield* Session.Service
  const source = yield* MessageV2.filterCompactedEffect(input.parentSessionID)
  const snapshot = yield* ensureCompactEnough({
    ...input,
    source,
    snapshot: snapshotBeforeBoundary(source, input.boundaryMessageID),
  })
  const idMap = new Map<string, MessageID>()

  for (const message of snapshot) {
    const messageID = MessageID.ascending()
    idMap.set(message.info.id, messageID)
    if (message.info.role === "user") {
      const parentMessageID = message.info.parentMessageID ? idMap.get(message.info.parentMessageID) : undefined
      const { parentMessageID: _parentMessageID, ...rest } = message.info
      yield* sessions.updateMessage({
        ...rest,
        id: messageID,
        sessionID: input.childSessionID,
        ...(parentMessageID ? { parentMessageID } : {}),
      } satisfies MessageV2.User)
    } else {
      const parentID = idMap.get(message.info.parentID)
      if (!parentID) continue
      const parentMessageID = message.info.parentMessageID ? idMap.get(message.info.parentMessageID) : undefined
      const { parentID: _parentID, parentMessageID: _parentMessageID, cost: _cost, tokens: _tokens, ...rest } = message.info
      yield* sessions.updateMessage({
        ...rest,
        id: messageID,
        sessionID: input.childSessionID,
        parentID,
        ...(parentMessageID ? { parentMessageID } : {}),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies MessageV2.Assistant)
    }
    for (const part of message.parts) {
      yield* sessions.updatePart({
        ...part,
        id: PartID.ascending(),
        messageID,
        sessionID: input.childSessionID,
      } as MessageV2.Part)
    }
  }
  return snapshot.length
})

const INHERIT_CONTEXT_RATIO = 0.7

function snapshotBeforeBoundary(source: MessageV2.WithParts[], boundaryMessageID?: MessageID) {
  const boundary = boundaryMessageID ? source.findIndex((message) => message.info.id === boundaryMessageID) : -1
  return (boundary === -1 ? source : source.slice(0, boundary)).flatMap(filterMessage)
}

const ensureCompactEnough = Effect.fn("SubagentInherit.ensureCompactEnough")(function* (input: {
  parentSessionID: SessionID
  boundaryMessageID?: MessageID
  model?: { providerID: ProviderID; modelID: ModelID }
  source: MessageV2.WithParts[]
  snapshot: MessageV2.WithParts[]
}) {
  if (!input.model) return input.snapshot
  const provider = yield* Effect.serviceOption(Provider.Service)
  const compaction = yield* Effect.serviceOption(SessionCompaction.Service)
  if (Option.isNone(provider) || Option.isNone(compaction)) return input.snapshot

  const cfg = yield* Config.Service.use((config) => config.get())
  const model = yield* provider.value.getModel(input.model.providerID, input.model.modelID)
  const limit = Math.floor(usable({ cfg, model }) * INHERIT_CONTEXT_RATIO)
  if (limit === 0) return input.snapshot
  if ((yield* estimate(input.snapshot, model)) <= limit) return input.snapshot

  const boundary = input.boundaryMessageID
    ? input.source.findIndex((message) => message.info.id === input.boundaryMessageID)
    : -1
  const source = boundary === -1 ? input.source : input.source.slice(0, boundary)
  const parent = source.findLast((message) => message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"))
  if (!parent || parent.info.role !== "user") {
    return yield* Effect.fail(new Error("Inherited subagent context is too large and has no user boundary to compact"))
  }
  const sessions = yield* Session.Service
  const compactionPart =
    parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction") ??
    (yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: parent.info.id,
      sessionID: input.parentSessionID,
      type: "compaction",
      auto: false,
      overflow: false,
    }))
  const sourceWithBoundary = source.map((message) =>
    message.info.id === parent.info.id && !message.parts.some((part) => part.type === "compaction")
      ? { ...message, parts: [...message.parts, compactionPart] }
      : message,
  )

  const result = yield* compaction.value.process({
    parentID: parent.info.id,
    messages: sourceWithBoundary,
    sessionID: input.parentSessionID,
    auto: false,
    model: input.model,
  })
  if (result !== "continue") {
    return yield* Effect.fail(new Error("Inherited subagent context is too large and parent compaction failed"))
  }

  const compacted = yield* MessageV2.filterCompactedEffect(input.parentSessionID)
  const snapshot = withCompactionSummary(
    snapshotBeforeBoundary(compacted, input.boundaryMessageID),
    compacted,
    parent.info.id,
  )
  if ((yield* estimate(snapshot, model)) > limit) {
    return yield* Effect.fail(new Error("Inherited subagent context is still too large after compaction"))
  }
  return snapshot
})

const estimate = Effect.fn("SubagentInherit.estimate")(function* (
  messages: MessageV2.WithParts[],
  model: Provider.Model,
) {
  return Token.estimate(JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, model)))
})

function filterMessage(message: MessageV2.WithParts): MessageV2.WithParts[] {
  const parts = message.parts.filter((part) => {
    if (part.type === "retry" || part.type === "compaction" || part.type === "subtask") return false
    if (part.type !== "tool") return true
    return part.state.status === "completed" || part.state.status === "error"
  })
  if (message.info.role === "assistant") {
    const hasUnsafeTool = message.parts.some(
      (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    )
    if (hasUnsafeTool) return []
  }
  if (parts.length === 0) return []
  return [{ info: message.info, parts }]
}

function withCompactionSummary(
  snapshot: MessageV2.WithParts[],
  source: MessageV2.WithParts[],
  compactedParentID: MessageID,
) {
  const existing = new Set(snapshot.map((message) => message.info.id))
  const summaries = source.flatMap((message) => {
    if (message.info.role !== "assistant") return []
    if (!message.info.summary || message.info.parentID !== compactedParentID) return []
    if (existing.has(message.info.id)) return []
    return filterMessage(message)
  })
  if (summaries.length === 0) return snapshot

  const parentIndex = snapshot.findIndex((message) => message.info.id === compactedParentID)
  if (parentIndex === -1) return snapshot

  const result = [...snapshot]
  result.splice(parentIndex + 1, 0, ...summaries)
  return result
}

export * as SubagentInherit from "./subagent-inherit"
