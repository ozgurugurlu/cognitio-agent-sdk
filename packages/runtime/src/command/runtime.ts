import { Effect } from "effect"
import { PermissionRuleSyntax } from "@/permission/rule-syntax"
import { RuntimePlugin } from "@/plugin/runtime"
import type { SessionRuntimeConfig } from "@/session/runtime-config"
import type { SessionID } from "@/session/schema"
import { Wildcard } from "@/util"
import { Command } from "."

export const list: (
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) => Effect.Effect<Command.Info[], never, Command.Service> = Effect.fn("CommandRuntime.list")(function* (
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) {
  const commands = yield* Command.Service
  const map = new Map<string, Command.Info>(
    (yield* commands.list(runtime?.settingSources)).map((command) => [command.name, command]),
  )
  const plugin = runtime ? yield* RuntimePlugin.materialize(runtime, sessionID) : undefined

  for (const command of plugin?.commands ?? []) {
    map.set(command.name, {
      name: command.name,
      description: command.description,
      agent: command.agent,
      model: command.model,
      source: "command",
      origin: "plugin",
      pluginName: command.pluginName,
      pluginRoot: command.pluginRoot,
      skillDir: command.skillDir,
      template: command.template,
      subtask: command.subtask,
      allowedTools: command.allowedTools,
      disallowedTools: command.disallowedTools,
      hints: Command.hints(command.template),
    })
  }

  for (const skill of plugin?.skills ?? []) {
    if (map.has(skill.name)) continue
    map.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source: "skill",
      origin: "plugin",
      pluginName: skill.pluginName,
      pluginRoot: skill.pluginRoot,
      skillDir: skill.skillDir,
      model: skillModel(skill.model),
      template: skill.content,
      allowedTools: skill.allowedTools,
      hints: [],
    })
  }

  for (const command of runtime?.commands ?? []) {
    map.set(command.name, {
      name: command.name,
      description: command.description,
      agent: command.agent,
      model: command.model,
      source: "command",
      origin: "runtime",
      template: command.template,
      subtask: command.subtask,
      allowedTools: command.allowedTools,
      disallowedTools: command.disallowedTools,
      hints: Command.hints(command.template),
    })
  }

  for (const skill of runtime?.skills ?? []) {
    if (map.has(skill.name)) continue
    map.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source: "skill",
      origin: "runtime",
      model: skillModel(skill.model),
      template: skill.content,
      allowedTools: skill.allowedTools,
      skillDir: skill.baseDir,
      hints: [],
    })
  }

  return Array.from(map.values()).toSorted((a, b) => a.name.localeCompare(b.name))
}) as never

export const get: (
  name: string,
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) => Effect.Effect<Command.Info | undefined, never, Command.Service> = Effect.fn("CommandRuntime.get")(function* (
  name: string,
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  sessionID?: SessionID,
) {
  return (yield* list(runtime, sessionID)).find((command) => command.name === name)
}) as never

export function applyToolPolicy(runtime: SessionRuntimeConfig.RuntimeConfig, command: Command.Info) {
  if (command.allowedTools === undefined && command.disallowedTools === undefined) return runtime
  const allowed = command.allowedTools?.map(PermissionRuleSyntax.parse)
  const parentAllowed = runtime.allowedTools?.map(PermissionRuleSyntax.parse)
  const childAllowed =
    allowed === undefined
      ? parentAllowed?.map(PermissionRuleSyntax.format)
      : allowed.length === 0
        ? []
        : parentAllowed?.length
          ? dedupe(allowed.flatMap((rule) => parentAllowed.flatMap((parent) => intersectRule(parent, rule))))
          : allowed.map(PermissionRuleSyntax.format)
  const denyAll = allowed !== undefined && childAllowed?.length === 0
  const disallowed = dedupe([
    ...(runtime.disallowedTools ?? []).map(normalizeRule),
    ...(command.disallowedTools ?? []).map(normalizeRule),
    ...(denyAll ? ["*"] : []),
  ])

  const next: SessionRuntimeConfig.RuntimeConfig = {
    ...runtime,
    ...(childAllowed === undefined ? {} : { allowedTools: childAllowed }),
  }
  if (disallowed.length) next.disallowedTools = disallowed
  else delete next.disallowedTools
  return next
}

function normalizeRule(rule: string) {
  return PermissionRuleSyntax.format(PermissionRuleSyntax.parse(rule))
}

function intersectRule(
  parent: PermissionRuleSyntax.ToolRuleSyntax,
  child: PermissionRuleSyntax.ToolRuleSyntax,
) {
  const tool = intersectSegment(parent.tool, child.tool)
  const pattern = intersectSegment(parent.pattern ?? "*", child.pattern ?? "*")
  if (!tool || !pattern) return []
  return [PermissionRuleSyntax.format({ raw: child.raw, tool, pattern })]
}

function intersectSegment(parent: string, child: string) {
  if (parent === "*") return child
  if (child === "*") return parent
  if (parent === child) return child
  if (Wildcard.match(child, parent)) return child
  if (Wildcard.match(parent, child)) return parent
}

function dedupe(items: string[]) {
  return Array.from(new Set(items))
}

function skillModel(model: SessionRuntimeConfig.RuntimeSkillDefinition["model"]) {
  if (typeof model === "string") return model
  if (model) return `${model.providerID}/${model.modelID}`
}

export * as CommandRuntime from "./runtime"
