import type { SessionRuntimeConfig } from "./runtime-config"

export const SETTING_SOURCES = ["user", "project", "local"] as const
export type InstructionSource = (typeof SETTING_SOURCES)[number]

export interface ResolvedSystemPrompt {
  agentPromptOverride?: string
  appendToFinal?: string
  instructionSources?: InstructionSource[]
}

export function activeInstructionSources(runtime: SessionRuntimeConfig.RuntimeConfig): InstructionSource[] {
  return runtime.settingSources ?? [...SETTING_SOURCES]
}

export function resolveSystemPrompt(runtime: SessionRuntimeConfig.RuntimeConfig): ResolvedSystemPrompt {
  const override = agentPromptOverride(runtime)
  const appendToFinal = [
    typeof runtime.systemPrompt === "object" ? runtime.systemPrompt.append : undefined,
    runtime.appendSystemPrompt,
  ]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join("\n\n")

  return {
    ...(override !== undefined ? { agentPromptOverride: override } : {}),
    ...(appendToFinal ? { appendToFinal } : {}),
    ...(runtime.settingSources !== undefined ? { instructionSources: runtime.settingSources } : {}),
  }
}

/** Keep a helper's narrow task while applying the session's base prompt and append policy. */
export function resolveHelperSystemPrompt(runtime: SessionRuntimeConfig.RuntimeConfig, prompt?: string) {
  const resolved = resolveSystemPrompt(runtime)
  return {
    ...resolved,
    ...(resolved.agentPromptOverride !== undefined
      ? { agentPromptOverride: [resolved.agentPromptOverride, prompt].filter(Boolean).join("\n\n") }
      : {}),
  }
}

function agentPromptOverride(runtime: SessionRuntimeConfig.RuntimeConfig) {
  if (runtime.systemPrompt === undefined) return
  if (typeof runtime.systemPrompt === "string") return runtime.systemPrompt
  switch (runtime.systemPrompt.preset) {
    case "none":
      return ""
    case "default":
      // Explicit fall-through to the agent/provider base prompt.
      return undefined
  }
}

export * as SessionSystemPrompt from "./system-prompt"
