import { Effect } from "effect"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import { RuntimePlugin } from "@/plugin/runtime"
import { Skill } from "."
import type { SessionRuntimeConfig } from "@/session/runtime-config"
import type { SessionID } from "@/session/schema"

export type RuntimeResolved = Skill.Info & {
  source?: "file" | "runtime" | "plugin"
  pluginName?: string
  baseDir?: string
  disableModelInvocation?: boolean
  pluginRoot?: string
  skillDir?: string
}

export const list: (
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  agent?: Agent.Info,
  opts?: { includeModelDisabled?: boolean },
  sessionID?: SessionID,
) => Effect.Effect<RuntimeResolved[], never, Skill.Service> = Effect.fn("SkillRuntime.list")(function* (
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  agent?: Agent.Info,
  opts?: { includeModelDisabled?: boolean },
  sessionID?: SessionID,
) {
  const skills = yield* Skill.Service
  const map = new Map<string, RuntimeResolved>(
    (yield* skills.all(runtime?.settingSources)).map((skill) => [skill.name, { ...skill, source: "file" as const }]),
  )
  const plugin = runtime ? yield* RuntimePlugin.materialize(runtime, sessionID) : undefined
  for (const skill of plugin?.skills ?? []) {
    if (map.has(skill.name)) continue
    map.set(skill.name, {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      location: skill.baseDir,
      baseDir: skill.baseDir,
      source: "plugin",
      pluginName: skill.pluginName,
      disableModelInvocation: skill.disableModelInvocation,
      pluginRoot: skill.pluginRoot,
      skillDir: skill.skillDir,
    })
  }
  for (const skill of runtime?.skills ?? []) {
    map.set(skill.name, {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      location: skill.baseDir,
      baseDir: skill.baseDir,
      source: "runtime",
      disableModelInvocation: skill.disableModelInvocation,
      skillDir: skill.baseDir,
    })
  }

  const result = Array.from(map.values())
    .filter((skill) => opts?.includeModelDisabled || skill.disableModelInvocation !== true)
    .filter((skill) => !agent || Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    .toSorted((a, b) => a.name.localeCompare(b.name))
  return result
}) as never

export const get: (
  name: string,
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  agent?: Agent.Info,
  opts?: { includeModelDisabled?: boolean },
  sessionID?: SessionID,
) => Effect.Effect<RuntimeResolved | undefined, never, Skill.Service> = Effect.fn("SkillRuntime.get")(function* (
  name: string,
  runtime?: SessionRuntimeConfig.RuntimeConfig,
  agent?: Agent.Info,
  opts?: { includeModelDisabled?: boolean },
  sessionID?: SessionID,
) {
  return (yield* list(runtime, agent, opts, sessionID)).find((skill) => skill.name === name)
}) as never

export * as SkillRuntime from "./runtime"
