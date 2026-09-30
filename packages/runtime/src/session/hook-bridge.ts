import { Effect, Option } from "effect"
import { ControlRequestRegistry } from "./control-registry"
import { SessionRuntimeConfig, type HookDescriptor, type HookEventName } from "./runtime-config"
import type { SessionID } from "./schema"
import { RuntimePlugin } from "@/plugin/runtime"

const DEFAULT_HOOK_TIMEOUT_MS = 10_000

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string }
  | { behavior: "ask" }

export interface HookAggregate {
  continue: boolean
  permissionDecision?: PermissionDecision
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: unknown
  additionalContext: string[]
  systemMessage: string[]
  customInstructions?: string
  initialUserMessage?: string
  stopReason?: string
}

export interface HookInput {
  sessionID: SessionID
  event: HookEventName
  data: Record<string, unknown>
  target?: string
  timeoutMs?: number
  runtime?: SessionRuntimeConfig.RuntimeConfig
}

export function empty(): HookAggregate {
  return {
    continue: true,
    additionalContext: [],
    systemMessage: [],
  }
}

export const run: (input: HookInput) => Effect.Effect<HookAggregate> = Effect.fn("HookBridge.run")(function* (
  input: HookInput,
) {
  const runtimeSvc = yield* Effect.serviceOption(SessionRuntimeConfig.Service)
  const control = yield* Effect.serviceOption(ControlRequestRegistry.Service)
  if (Option.isNone(runtimeSvc) || Option.isNone(control)) return empty()
  const runtime = yield* resolveRuntime(input, runtimeSvc.value)
  const descriptors = matchingDescriptors(input, runtime.hooks?.[input.event] ?? [])
  if (descriptors.length === 0) return empty()

  const async = descriptors.filter((descriptor) => descriptor.async === true)
  if (async.length > 0) {
    yield* dispatch({ ...input, descriptors: async }, control.value).pipe(
      Effect.ignore,
      Effect.forkDetach({ startImmediately: true }),
    )
  }

  const blocking = descriptors.filter((descriptor) => descriptor.async !== true)
  if (blocking.length === 0) return empty()

  const response = yield* dispatch({ ...input, descriptors: blocking }, control.value).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (!response) return empty()
  return normalizeAggregate(response)
}) as never

export const notify: (input: HookInput) => Effect.Effect<void> = Effect.fn("HookBridge.notify")(function* (
  input: HookInput,
) {
  const runtimeSvc = yield* Effect.serviceOption(SessionRuntimeConfig.Service)
  const control = yield* Effect.serviceOption(ControlRequestRegistry.Service)
  if (Option.isNone(runtimeSvc) || Option.isNone(control)) return
  const runtime = yield* resolveRuntime(input, runtimeSvc.value)
  const descriptors = matchingDescriptors(input, runtime.hooks?.[input.event] ?? [])
  if (descriptors.length === 0) return
  yield* dispatch({ ...input, descriptors }, control.value).pipe(
    Effect.ignore,
    Effect.forkDetach({ startImmediately: true }),
  )
}) as never

const resolveRuntime = Effect.fn("HookBridge.resolveRuntime")(function* (
  input: HookInput,
  runtimeSvc: { get: (sessionID: SessionID) => Effect.Effect<SessionRuntimeConfig.RuntimeConfig> },
) {
  if (input.runtime) return yield* RuntimePlugin.expand(input.runtime, input.sessionID)
  return yield* runtimeSvc
    .get(input.sessionID)
    .pipe(
      Effect.flatMap((config) => RuntimePlugin.expand(config, input.sessionID)),
      Effect.catchCause(() => Effect.succeed({} as SessionRuntimeConfig.RuntimeConfig)),
    )
})

const dispatch = Effect.fn("HookBridge.dispatch")(function* (
  input: HookInput & { descriptors: HookDescriptor[] },
  control: { create: (input: never) => Effect.Effect<ControlRequestRegistry.ControlPayload, unknown, never> },
) {
  const toolCallID = hookToolCallID(input.data)
  return yield* control.create({
    sessionID: input.sessionID,
    subtype: "hook_callback",
    timeoutMs: input.timeoutMs ?? hookTimeout(input.descriptors),
    payload: {
      event: input.event,
      descriptors: input.descriptors,
      data: input.data,
      ...(toolCallID ? { callID: toolCallID, toolCallId: toolCallID } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
    },
  } as never)
})

function hookTimeout(descriptors: HookDescriptor[]) {
  return Math.max(...descriptors.map((descriptor) => descriptor.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS))
}

function matchingDescriptors(input: HookInput, descriptors: HookDescriptor[]) {
  const target = String(input.target ?? input.event)
  return descriptors.filter((descriptor) => descriptorMatches(descriptor, target))
}

function descriptorMatches(descriptor: HookDescriptor, target: string) {
  if (!descriptor.matcher || descriptor.matcher === "*") return true
  try {
    return new RegExp(descriptor.matcher, descriptor.matcherFlags).test(target)
  } catch {
    return descriptor.matcher === target
  }
}

function hookToolCallID(data: Record<string, unknown>) {
  if (typeof data.callID === "string") return data.callID
  if (typeof data.toolCallId === "string") return data.toolCallId
}

export function normalizePermissionDecision(input: unknown): PermissionDecision | undefined {
  if (input === "allow") return { behavior: "allow" }
  if (input === "deny") return { behavior: "deny" }
  if (input === "ask") return { behavior: "ask" }
  if (!input || typeof input !== "object") return
  const value = input as Record<string, unknown>
  if (value.behavior === "allow") {
    return {
      behavior: "allow",
      ...(isRecord(value.updatedInput) ? { updatedInput: value.updatedInput } : {}),
    }
  }
  if (value.behavior === "deny") {
    return {
      behavior: "deny",
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    }
  }
  if (value.behavior === "ask") return { behavior: "ask" }
}

export function normalizeAggregate(input: unknown): HookAggregate {
  if (Array.isArray(input)) return input.map(normalizeAggregate).reduce(mergeAggregate, empty())
  if (!input || typeof input !== "object") return empty()
  const value = input as Record<string, unknown>
  const decision = normalizePermissionDecision(value.permissionDecision)
  const result = empty()
  if (value.continue === false) result.continue = false
  if (decision) result.permissionDecision = decision
  if (decision?.behavior === "allow" && isRecord(decision.updatedInput)) result.updatedInput = decision.updatedInput
  if (isRecord(value.updatedInput)) result.updatedInput = { ...result.updatedInput, ...value.updatedInput }
  if (value.updatedToolOutput !== undefined) result.updatedToolOutput = value.updatedToolOutput
  if (typeof value.additionalContext === "string") result.additionalContext.push(value.additionalContext)
  if (Array.isArray(value.additionalContext)) result.additionalContext.push(...value.additionalContext.filter(isString))
  if (typeof value.systemMessage === "string") result.systemMessage.push(value.systemMessage)
  if (Array.isArray(value.systemMessage)) result.systemMessage.push(...value.systemMessage.filter(isString))
  const customInstructions = joinText(strings(value.customInstructions))
  if (customInstructions) result.customInstructions = customInstructions
  if (typeof value.initialUserMessage === "string") result.initialUserMessage = value.initialUserMessage
  if (typeof value.stopReason === "string") result.stopReason = value.stopReason
  return result
}

export function mergeAggregate(left: HookAggregate, right: HookAggregate): HookAggregate {
  const decision = mergeDecision(left.permissionDecision, right.permissionDecision)
  const customInstructions = joinText([left.customInstructions, right.customInstructions])
  return {
    continue: left.continue && right.continue,
    ...(decision ? { permissionDecision: decision } : {}),
    ...(left.updatedInput || right.updatedInput
      ? { updatedInput: { ...left.updatedInput, ...right.updatedInput } }
      : {}),
    ...(right.updatedToolOutput !== undefined
      ? { updatedToolOutput: right.updatedToolOutput }
      : left.updatedToolOutput !== undefined
        ? { updatedToolOutput: left.updatedToolOutput }
        : {}),
    additionalContext: [...left.additionalContext, ...right.additionalContext],
    systemMessage: [...left.systemMessage, ...right.systemMessage],
    ...(customInstructions !== undefined ? { customInstructions } : {}),
    ...((right.initialUserMessage ?? left.initialUserMessage)
      ? { initialUserMessage: right.initialUserMessage ?? left.initialUserMessage }
      : {}),
    ...((right.stopReason ?? left.stopReason) ? { stopReason: right.stopReason ?? left.stopReason } : {}),
  }
}

function mergeDecision(left?: PermissionDecision, right?: PermissionDecision): PermissionDecision | undefined {
  if (!left) return right
  if (!right) return left
  if (left.behavior === "deny") return left
  if (right.behavior === "deny") return right
  if (left.behavior === "ask") return left
  if (right.behavior === "ask") return right
  return {
    behavior: "allow",
    ...(left.updatedInput || right.updatedInput
      ? { updatedInput: { ...left.updatedInput, ...right.updatedInput } }
      : {}),
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function strings(value: unknown) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter(isString)
  return []
}

function joinText(value: Array<string | undefined>) {
  const result = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (!result.length) return
  return result.join("\n\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export * as HookBridge from "./hook-bridge"
