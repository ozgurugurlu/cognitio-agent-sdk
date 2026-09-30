import { describe, expect, test } from "bun:test"
import { reasoningOptions } from "../../src/session/reasoning"
import { RuntimeConfig } from "../../src/session/runtime-config"
import { ProviderTest } from "../fake/provider"

const base = ProviderTest.model()
const model = ProviderTest.model({
  capabilities: { ...base.capabilities, reasoning: true },
  api: { ...base.api, npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5" },
  limit: { ...base.limit, output: 32000 },
  variants: { high: { thinking: { type: "enabled", budgetTokens: 16000 } } },
})

describe("runtime reasoning controls", () => {
  test("effort selects the model's provider variant", () => {
    expect(reasoningOptions(model, { effort: "high" })).toEqual({ thinking: { type: "enabled", budgetTokens: 16000 } })
  })
  test("explicit thinking replaces an effort's thinking budget", () => {
    expect(
      reasoningOptions(model, { effort: "high", thinkingConfig: { type: "enabled", budgetTokens: 2048 } }),
    ).toEqual({ thinking: { type: "enabled", budgetTokens: 2048 } })
  })
  test("disabled thinking overrides reasoning defaults", () => {
    expect(reasoningOptions(model, { thinkingConfig: { type: "disabled" } })).toEqual({
      thinking: { type: "disabled" },
    })
  })
  test("Google receives its native thinking budget", () => {
    expect(
      reasoningOptions(
        { ...model, api: { ...model.api, npm: "@ai-sdk/google" } },
        { thinkingConfig: { type: "enabled", budgetTokens: 2048 } },
      ),
    ).toEqual({ thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } })
  })
  test("adaptive thinking preserves provider-specific effort and presentation fields", () => {
    expect(
      reasoningOptions(
        {
          ...model,
          api: { ...model.api, npm: "@ai-sdk/amazon-bedrock", id: "anthropic.claude-opus-4-7" },
          variants: {
            high: { reasoningConfig: { type: "adaptive", maxReasoningEffort: "high", display: "summarized" } },
          },
        },
        { effort: "high", thinkingConfig: { type: "adaptive" } },
      ),
    ).toEqual({
      reasoningConfig: { type: "adaptive", maxReasoningEffort: "high", display: "summarized" },
    })
    expect(
      reasoningOptions(
        {
          ...model,
          api: { ...model.api, npm: "@ai-sdk/google", id: "gemini-3.1-pro" },
          variants: { high: { thinkingConfig: { thinkingLevel: "high" } } },
        },
        { effort: "high", thinkingConfig: { type: "adaptive" } },
      ),
    ).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
    })
  })
  test("unsupported effort and excessive budgets fail explicitly", () => {
    expect(() => reasoningOptions(model, { effort: "low" })).toThrow("does not support reasoning effort")
    expect(() => reasoningOptions(model, { thinkingConfig: { type: "enabled", budgetTokens: 32000 } })).toThrow(
      "output limit",
    )
  })
  test("runtime policy schemas reject unimplemented detached task modes", () => {
    expect(RuntimeConfig.safeParse({ backgroundTaskPolicy: { mode: "detached" } }).success).toBe(false)
    expect(
      RuntimeConfig.safeParse({
        backgroundTaskPolicy: { mode: "foreground" },
        checkpointing: { enabled: true, beforeCompaction: true },
        compaction: { auto: false },
        includeEnvironment: false,
      }).success,
    ).toBe(true)
    expect(RuntimeConfig.safeParse({ thinkingConfig: { type: "enabled", budgetTokens: 0 } }).success).toBe(false)
  })
})
