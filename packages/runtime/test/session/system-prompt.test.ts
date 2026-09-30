import { describe, expect, test } from "bun:test"
import {
  activeInstructionSources,
  resolveHelperSystemPrompt,
  resolveSystemPrompt,
} from "../../src/session/system-prompt"

describe("SessionSystemPrompt", () => {
  test("internal helpers inherit runtime prompt policy and retain their specialist task", () => {
    expect(
      resolveHelperSystemPrompt(
        { systemPrompt: "Research context", appendSystemPrompt: "Keep citations" },
        "Generate a title",
      ),
    ).toEqual({
      agentPromptOverride: "Research context\n\nGenerate a title",
      appendToFinal: "Keep citations",
    })
    expect(resolveHelperSystemPrompt({ systemPrompt: { type: "preset", preset: "none" } }, "Summarize")).toEqual({
      agentPromptOverride: "Summarize",
    })
    expect(resolveHelperSystemPrompt({}, "Summarize")).toEqual({})
  })
  test("resolves custom, preset, append, and instruction source runtime config", () => {
    expect(resolveSystemPrompt({ systemPrompt: "Custom base" })).toEqual({
      agentPromptOverride: "Custom base",
    })
    expect(resolveSystemPrompt({ systemPrompt: { type: "preset", preset: "none" } })).toEqual({
      agentPromptOverride: "",
    })
    expect(
      resolveSystemPrompt({
        systemPrompt: { type: "preset", preset: "default", append: "Preset tail" },
        appendSystemPrompt: "Global tail",
        settingSources: [],
      }),
    ).toEqual({
      appendToFinal: "Preset tail\n\nGlobal tail",
      instructionSources: [],
    })
    expect(resolveSystemPrompt({ systemPrompt: { type: "preset", preset: "default" } })).toEqual({})
    expect(activeInstructionSources({})).toEqual(["user", "project", "local"])
    expect(activeInstructionSources({ settingSources: ["project"] })).toEqual(["project"])
  })
})
