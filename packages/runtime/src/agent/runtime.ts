import { PermissionRuleSyntax } from "@/permission/rule-syntax"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"
import { Agent } from "./agent"
import type { SessionRuntimeConfig } from "@/session/runtime-config"

export type RuntimeResolved = Agent.Info & {
  runtime?: {
    spawnMode?: "fresh" | "inherit"
    tools?: string[]
    disallowedTools?: string[]
    permissionMode?: SessionRuntimeConfig.PermissionMode
    mcpServers?: Array<SessionRuntimeConfig.RuntimeRemoteMcpServer | SessionRuntimeConfig.RuntimeLocalMcpServer>
  }
}

export const get = Effect.fn("AgentRuntime.get")(function* (
  name: string,
  runtime?: Pick<SessionRuntimeConfig.RuntimeConfig, "agents" | "settingSources">,
) {
  const agents = yield* Agent.Service
  const sources = runtime?.settingSources
  const def = runtime?.agents?.[name]
  if (!def) return (yield* agents.get(name, sources)) as RuntimeResolved | undefined
  const base = yield* agents.get(name, sources)
  const general = base ? undefined : yield* agents.get("general", sources)
  return materialize(name, def, base ?? general)
})

export const list = Effect.fn("AgentRuntime.list")(function* (
  runtime?: Pick<SessionRuntimeConfig.RuntimeConfig, "agents" | "settingSources">,
) {
  const agents = yield* Agent.Service
  const base = yield* agents.list(runtime?.settingSources)
  const general = base.find((item) => item.name === "general")
  const map = new Map<string, RuntimeResolved>(base.map((item) => [item.name, item]))
  for (const [name, def] of Object.entries(runtime?.agents ?? {})) {
    map.set(name, materialize(name, def, map.get(name) ?? general))
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
})

/**
 * Session/runtime default-agent selection: source-aware and lenient (an
 * invalid or gated default_agent falls back to build, then to the first
 * visible primary). Sessionless CLI/ACP routes keep Agent.Service.defaultAgent.
 */
export const defaultAgent = Effect.fn("AgentRuntime.defaultAgent")(function* (
  runtime?: Pick<SessionRuntimeConfig.RuntimeConfig, "settingSources">,
) {
  const agents = yield* Agent.Service
  return yield* agents.runtimeDefaultAgent(runtime?.settingSources)
})

export function materialize(
  name: string,
  def: SessionRuntimeConfig.RuntimeAgentDefinition,
  base?: Agent.Info,
): RuntimeResolved {
  return {
    name,
    description: def.description ?? base?.description,
    mode: base?.mode ?? "subagent",
    native: false,
    hidden: base?.hidden,
    color: base?.color,
    topP: base?.topP,
    temperature: def.temperature ?? base?.temperature,
    permission: base?.permission ?? [],
    model: def.model
      ? {
          providerID: ProviderID.make(def.model.providerID),
          modelID: ModelID.make(def.model.modelID),
        }
      : base?.model,
    variant: base?.variant,
    prompt: def.prompt,
    options: base?.options ?? {},
    steps: def.steps ?? base?.steps,
    runtime: {
      ...(def.spawnMode !== undefined ? { spawnMode: def.spawnMode } : {}),
      ...(def.tools !== undefined ? { tools: normalizeRules(def.tools) } : {}),
      ...(def.disallowedTools !== undefined ? { disallowedTools: normalizeRules(def.disallowedTools) } : {}),
      ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
      ...(def.mcpServers !== undefined ? { mcpServers: def.mcpServers } : {}),
    },
  }
}

export function deriveChildRuntime(
  parent: SessionRuntimeConfig.RuntimeConfig,
  agent: RuntimeResolved,
): SessionRuntimeConfig.RuntimeConfig {
  const agentTools = agent.runtime?.tools
  const childAllowed =
    agentTools === undefined
      ? parent.allowedTools
      : agentTools.length === 0
        ? parent.allowedTools
        : intersectAllowed(parent.allowedTools, agentTools)
  const denyAllTools = agentTools !== undefined && (agentTools.length === 0 || childAllowed?.length === 0)
  const childDenied = dedupe([
    ...(parent.disallowedTools ?? []).map(normalizeRule),
    ...(agent.runtime?.disallowedTools ?? []),
    ...(denyAllTools ? ["*"] : []),
  ])
  const sdkMcpServers = dedupeMcpServers([...(parent.sdkMcpServers ?? []), ...(agent.runtime?.mcpServers ?? [])])
  const maxTurns =
    parent.maxTurns === undefined
      ? agent.steps
      : agent.steps === undefined
        ? parent.maxTurns
        : Math.min(parent.maxTurns, agent.steps)

  const next: SessionRuntimeConfig.RuntimeConfig = {
    ...parent,
    ...(agent.model ? { model: { providerID: agent.model.providerID, modelID: agent.model.modelID } } : {}),
    ...(agent.runtime?.permissionMode ? { permissionMode: agent.runtime.permissionMode } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(childAllowed === undefined ? {} : { allowedTools: childAllowed }),
  }
  if (childDenied.length) next.disallowedTools = childDenied
  else delete next.disallowedTools
  if (sdkMcpServers.length) next.sdkMcpServers = sdkMcpServers
  else delete next.sdkMcpServers
  // A child agent with its own prompt keeps that specialist prompt: inheriting
  // the parent's systemPrompt override would wipe it. Promptless children keep
  // the inheritance so they don't fall back to the provider coding prompt.
  if (agent.prompt) {
    delete next.systemPrompt
    delete next.appendSystemPrompt
  }
  return next
}

export function restoreAgentMcpServers(
  runtime: SessionRuntimeConfig.RuntimeConfig,
  agent: RuntimeResolved,
): SessionRuntimeConfig.RuntimeConfig {
  if (!agent.runtime?.mcpServers?.length) return runtime
  return {
    ...runtime,
    sdkMcpServers: dedupeMcpServers([...(runtime.sdkMcpServers ?? []), ...agent.runtime.mcpServers]),
  }
}

function intersectAllowed(parent: string[] | undefined, agent: string[]) {
  const normalized = agent.map(normalizeRule)
  if (!parent?.length) return normalized
  const parentSet = new Set(parent.map(normalizeRule))
  return normalized.filter((rule) => parentSet.has(rule))
}

function normalizeRules(rules: string[]) {
  return rules.map(normalizeRule)
}

function normalizeRule(rule: string) {
  return PermissionRuleSyntax.format(PermissionRuleSyntax.parse(rule))
}

function dedupe(items: string[]) {
  return Array.from(new Set(items))
}

function dedupeMcpServers(servers: SessionRuntimeConfig.RuntimeMcpServer[]) {
  return Array.from(new Map(servers.map((server) => [server.name, server])).values())
}

export * as AgentRuntime from "./runtime"
