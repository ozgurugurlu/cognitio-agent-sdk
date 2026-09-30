import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import type { RuntimeConfig } from "./runtime-config"

/** Resolve portable runtime controls into the provider's native request options. */
export function reasoningOptions(model: Provider.Model, runtime?: Pick<RuntimeConfig, "effort" | "thinkingConfig">) {
  const effort = runtime?.effort
  const variants = model.variants ?? ProviderTransform.variants(model)
  if (effort && !variants[effort]) {
    throw new Error(`Model ${model.providerID}/${model.id} does not support reasoning effort ${effort}`)
  }
  const options: Record<string, unknown> = { ...(effort ? variants[effort] : {}) }
  const thinking = runtime?.thinkingConfig
  if (!thinking) return options
  if (thinking.type !== "disabled" && !model.capabilities.reasoning) {
    throw new Error(`Model ${model.providerID}/${model.id} does not support thinking`)
  }
  if (thinking.type === "enabled" && thinking.budgetTokens >= ProviderTransform.maxOutputTokens(model)) {
    throw new Error("thinkingConfig.budgetTokens must be smaller than the model output limit")
  }
  const npm = model.api.npm
  if (
    npm === "@ai-sdk/anthropic" ||
    npm === "@ai-sdk/google-vertex/anthropic" ||
    (npm === "@ai-sdk/gateway" && model.api.id.includes("anthropic"))
  ) {
    const selected = options.thinking as { type?: string } | undefined
    return {
      ...options,
      thinking: thinking.type === "adaptive" && selected?.type === "adaptive" ? { ...selected, ...thinking } : thinking,
    }
  }
  if (npm === "@ai-sdk/amazon-bedrock" && model.api.id.includes("anthropic")) {
    const selected = options.reasoningConfig as { type?: string } | undefined
    return {
      ...options,
      reasoningConfig:
        thinking.type === "adaptive" && selected?.type === "adaptive" ? { ...selected, ...thinking } : thinking,
    }
  }
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    const selected = options.thinkingConfig as Record<string, unknown> | undefined
    return {
      ...options,
      thinkingConfig: {
        includeThoughts: thinking.type !== "disabled",
        ...(thinking.type === "adaptive" && selected
          ? selected
          : {
              thinkingBudget:
                thinking.type === "enabled" ? thinking.budgetTokens : thinking.type === "disabled" ? 0 : -1,
            }),
      },
    }
  }
  if (npm === "@openrouter/ai-sdk-provider") {
    return {
      ...options,
      reasoning: {
        enabled: thinking.type !== "disabled",
        ...(effort ? { effort } : {}),
        ...(thinking.type === "enabled" ? { max_tokens: thinking.budgetTokens } : {}),
      },
    }
  }
  throw new Error(`Model ${model.providerID}/${model.id} does not support thinkingConfig; use effort when available`)
}
