import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "../../src/agent/runtime"
import type { Agent } from "../../src/agent/agent"

const base: Agent.Info = { name: "child", mode: "subagent", permission: [], options: {} }

const parent = {
  systemPrompt: "NEUTRAL BASE",
  appendSystemPrompt: "APPEND TAIL",
  maxTurns: 5,
}

describe("AgentRuntime.deriveChildRuntime", () => {
  test("drops parent prompt overrides when the child agent has its own prompt", () => {
    const child = AgentRuntime.deriveChildRuntime(parent, { ...base, prompt: "You are a specialist." })
    expect(child.systemPrompt).toBeUndefined()
    expect(child.appendSystemPrompt).toBeUndefined()
    expect(child.maxTurns).toBe(5)
  })

  test("keeps parent prompt overrides for promptless child agents", () => {
    const child = AgentRuntime.deriveChildRuntime(parent, { ...base })
    expect(child.systemPrompt).toBe("NEUTRAL BASE")
    expect(child.appendSystemPrompt).toBe("APPEND TAIL")
  })

  test("materialized runtime agents always drop the parent prompt", () => {
    const agent = AgentRuntime.materialize("helper", { prompt: "Help." })
    const child = AgentRuntime.deriveChildRuntime(parent, agent)
    expect(child.systemPrompt).toBeUndefined()
    expect(child.appendSystemPrompt).toBeUndefined()
  })
})
