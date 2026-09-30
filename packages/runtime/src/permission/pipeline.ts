import { Instance } from "@/project/instance"
import { Plugin } from "@/plugin"
import { Global } from "@/global"
import { ControlRequestRegistry } from "@/session/control-registry"
import { HookBridge, type PermissionDecision } from "@/session/hook-bridge"
import type { RuntimeConfig } from "@/session/runtime-config"
import { PermissionID } from "./schema"
import { Permission } from "."
import { PermissionClassifier } from "./classifier"
import { Cause, Effect, Fiber, Option } from "effect"
import path from "path"

const CLASSIFIER_CONFIDENCE = 0.8
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list", "ls", "tool_search"])
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])

type AskChannelResult =
  | { channel: "user"; reply: "once" }
  | { channel: "user"; reply: "reject"; message?: string }
  | { channel: "sdk"; decision: Extract<PermissionDecision, { behavior: "allow" | "deny" }> }

export interface AskInput {
  toolName: string
  toolInput: unknown
  cwd: string
  recentContext?: string
  runtime: RuntimeConfig
  request: Permission.AskInput
}

export interface AskResult {
  updatedInput?: Record<string, unknown>
}

export const ask: (input: AskInput) => Effect.Effect<AskResult, Permission.Error> = Effect.fn(
  "PermissionPipeline.ask",
)(function* (input: AskInput) {
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const requestID = input.request.id ?? PermissionID.ascending()
  const mode = input.runtime.permissionMode ?? "default"
  const baseRequest: Permission.AskInput = {
    ...input.request,
    id: requestID,
  }
  if (mode === "plan") {
    const baseChecked = yield* permission.check(baseRequest)
    if (baseChecked.action === "deny") {
      yield* plugin.trigger("permission.denied", { request: baseRequest, reason: "ruleset" }, {})
      return yield* baseChecked.error
    }
  }
  const request: Permission.AskInput = {
    ...baseRequest,
    ruleset: input.request.ruleset,
    runtimeRuleset:
      mode === "plan"
        ? Permission.merge(input.request.runtimeRuleset ?? [], planRuleset())
        : input.request.runtimeRuleset,
  }

  const checked = yield* permission.check(request)
  if (checked.action === "deny") {
    yield* plugin.trigger("permission.denied", { request, reason: "ruleset" }, {})
    return yield* checked.error
  }
  if (checked.action === "allow") return {}

  const hasPermissionAskHook = yield* plugin
    .list()
    .pipe(Effect.map((hooks) => hooks.some((hook) => typeof hook["permission.ask"] === "function")))
  const pluginDecision: { status: "ask" | "deny" | "allow" } = yield* plugin.trigger(
    "permission.ask",
    request as never,
    { status: "ask" as "ask" | "deny" | "allow" },
  )
  if (pluginDecision.status === "allow") return {}
  if (pluginDecision.status === "deny") {
    yield* plugin.trigger("permission.denied", { request, reason: "plugin" }, {})
    return yield* new Permission.DeniedError({ ruleset: request.ruleset })
  }

  const forceAsk = hasPermissionAskHook && pluginDecision.status === "ask"
  if (!forceAsk && mode === "dontAsk") {
    yield* plugin.trigger("permission.denied", { request, reason: "dontAsk" }, {})
    return yield* new Permission.DeniedError({ ruleset: request.ruleset })
  }
  if (!forceAsk && mode === "bypassPermissions") return {}
  if (!forceAsk && mode === "acceptEdits" && acceptsEdit(input.toolName, request)) return {}
  if (!forceAsk && mode === "auto") {
    const classifier = yield* Effect.serviceOption(PermissionClassifier.Service)
    const classified = Option.isNone(classifier)
      ? { decision: "ask" as const, confidence: 0, reason: "classifier-unavailable" }
      : yield* classifier.value.classify(
        {
          toolName: input.toolName,
          toolInput: input.toolInput,
          sessionID: request.sessionID,
          cwd: input.cwd,
          recentContext: input.recentContext ?? "",
        },
        input.runtime.autoPermissionClassifierModel,
      ).pipe(Effect.catchCause(() => Effect.succeed({ decision: "ask" as const, confidence: 0, reason: "classifier-error" })))
    if (classified.confidence >= CLASSIFIER_CONFIDENCE && classified.decision === "allow") return {}
    if (classified.confidence >= CLASSIFIER_CONFIDENCE && classified.decision === "deny") {
      yield* plugin.trigger("permission.denied", { request, reason: classified.reason }, {})
      return yield* new Permission.CorrectedError({ feedback: classified.reason })
    }
  }

  const result = yield* askChannel(input, request)

  const reply = result.channel === "user" ? result.reply : result.decision.behavior
  const message =
    result.channel === "user" && result.reply === "reject"
      ? result.message
      : result.channel === "sdk" && result.decision.behavior === "deny"
        ? result.decision.message
        : undefined
  yield* HookBridge.notify({
    sessionID: request.sessionID,
    runtime: input.runtime,
    event: "PermissionReplied",
    data: {
      requestID,
      reply,
      ...(message ? { message } : {}),
      toolName: input.toolName,
      channel: result.channel,
    },
    target: input.toolName,
  })
  if (result.channel === "sdk" && result.decision.behavior === "allow") {
    return result.decision.updatedInput ? { updatedInput: result.decision.updatedInput } : {}
  }
  if (result.channel === "sdk" && result.decision.behavior === "deny") {
    yield* plugin.trigger("permission.denied", { request, reason: "canUseTool", message: result.decision.message }, {})
    if (result.decision.message) return yield* new Permission.CorrectedError({ feedback: result.decision.message })
    return yield* new Permission.RejectedError()
  }
  if (result.channel === "user" && result.reply === "reject") {
    if (result.message) return yield* new Permission.CorrectedError({ feedback: result.message })
    return yield* new Permission.RejectedError()
  }
  return {}
}) as never

const askChannel: (input: AskInput, request: Permission.AskInput) => Effect.Effect<AskChannelResult> = Effect.fn(
  "PermissionPipeline.askChannel",
)(function* (input: AskInput, request: Permission.AskInput) {
  if (!input.runtime.canUseTool) return yield* userAsk(input, request)
  const permission = yield* Permission.Service
  const user = yield* userAsk(input, request).pipe(Effect.forkChild)
  const sdk = yield* canUseTool(input, request)
    .pipe(
      Effect.flatMap((decision): Effect.Effect<AskChannelResult> => {
        if (decision.behavior === "ask") return Effect.never
        return Effect.succeed({ channel: "sdk" as const, decision })
      }),
      Effect.forkChild,
    )
  const result = yield* Effect.race(
    Fiber.join(user).pipe(Effect.map((item) => ({ source: "user" as const, item }))),
    Fiber.join(sdk).pipe(Effect.map((item) => ({ source: "sdk" as const, item }))),
  )
  if (result.source === "user") {
    yield* Fiber.interrupt(sdk)
    return result.item
  }
  const sdkResult = result.item as Extract<AskChannelResult, { channel: "sdk" }>
  yield* settleUserAsk(permission, {
    requestID: request.id!,
    reply: sdkResult.decision.behavior === "allow" ? "once" : "reject",
    ...(sdkResult.decision.behavior === "deny" && sdkResult.decision.message ? { message: sdkResult.decision.message } : {}),
  })
  yield* Fiber.interrupt(user)
  return sdkResult
}) as never

const userAsk: (input: AskInput, request: Permission.AskInput) => Effect.Effect<AskChannelResult> = Effect.fn(
  "PermissionPipeline.userAsk",
)(function* (input: AskInput, request: Permission.AskInput) {
  const permission = yield* Permission.Service
  yield* HookBridge.notify({
    sessionID: request.sessionID,
    runtime: input.runtime,
    event: "PermissionAsked",
    data: {
      requestID: request.id,
      permission: request.permission,
      patterns: request.patterns,
      metadata: request.metadata,
      toolName: input.toolName,
      toolInput: input.toolInput,
    },
    target: input.toolName,
  })
  return yield* permission.request(request).pipe(
    Effect.as({ channel: "user" as const, reply: "once" as const }),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      return Effect.succeed({
        channel: "user" as const,
        reply: "reject" as const,
        ...(error instanceof Permission.CorrectedError ? { message: error.feedback } : {}),
      })
    }),
  )
}) as never

const canUseTool: (input: AskInput, request: Permission.AskInput) => Effect.Effect<PermissionDecision> = Effect.fn(
  "PermissionPipeline.canUseTool",
)(function* (input: AskInput, request: Permission.AskInput) {
  const control = yield* Effect.serviceOption(ControlRequestRegistry.Service)
  if (Option.isNone(control)) return { behavior: "ask" as const }
  const response = yield* control.value
    .create({
      sessionID: request.sessionID,
      subtype: "can_use_tool",
      payload: {
        toolName: input.toolName,
        input: input.toolInput,
        permissionID: request.id,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        ...(request.tool ? { messageID: request.tool.messageID, callID: request.tool.callID } : {}),
      },
    })
    .pipe(
      Effect.catchCause((cause): Effect.Effect<PermissionDecision> => {
        const error = Cause.squash(cause)
        if (
          error instanceof ControlRequestRegistry.TimeoutError ||
          error instanceof ControlRequestRegistry.CancelledError ||
          error instanceof ControlRequestRegistry.ShutdownError
        ) {
          return Effect.succeed({ behavior: "ask" } satisfies PermissionDecision)
        }
        return Effect.succeed({
          behavior: "deny" as const,
          message: error instanceof Error ? error.message : String(error),
        } satisfies PermissionDecision)
      }),
    )
  const fallback: PermissionDecision = { behavior: "deny", message: "Invalid canUseTool response" }
  return HookBridge.normalizePermissionDecision(response) ?? fallback
}) as never

function settleUserAsk(permission: Permission.Interface, input: Permission.ReplyInput) {
  return Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (yield* permission.settle(input)) return
      yield* Effect.sleep("5 millis")
    }
  })
}

function acceptsEdit(toolName: string, request: Permission.AskInput) {
  if (READ_ONLY_TOOLS.has(toolName)) return request.permission !== "external_directory"
  if (!EDIT_TOOLS.has(toolName)) return false
  if (request.permission !== "edit") return false
  return (
    request.patterns.length > 0 &&
    request.patterns.every(
      (pattern) =>
        pattern !== "*" &&
        Instance.containsPath(path.isAbsolute(stripGlob(pattern)) ? stripGlob(pattern) : path.resolve(Instance.worktree, stripGlob(pattern))),
    )
  )
}

function stripGlob(pattern: string) {
  const index = pattern.search(/[*?[{]/)
  if (index === -1) return pattern
  return pattern.slice(0, index)
}

function planRuleset(): Permission.Ruleset {
  return Permission.fromConfig({
    question: "allow",
    plan_exit: "allow",
    external_directory: {
      [path.join(Global.Path.data, "plans", "*")]: "allow",
    },
    edit: {
      "*": "deny",
      [path.join(".cognitio", "plans", "*.md")]: "allow",
      [path.relative(Instance.worktree, path.join(Global.Path.data, "plans", "*.md"))]: "allow",
    },
  })
}

export * as PermissionPipeline from "./pipeline"
