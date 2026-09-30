// Compile-only: the Tier 1 / Tier 2 / Tier 3 quickstarts published in the Phase
// 13 plan and the README, verbatim. Never executed — `tsgo -p tsconfig.test.json`
// compiles it, so a facade shape change that would break the documented entry
// point fails the typecheck instead of silently drifting from the docs.
import { Agent, defineTool, models, query, shutdown } from "../../src/index.js"

const checkDiff = defineTool({ name: "checkDiff", inputJsonSchema: { type: "object" }, execute: () => "ok" })

export async function tier1() {
  const agent = new Agent({
    model: "anthropic/claude-sonnet-4-5",
    instructions: "You are a release reviewer.",
    tools: [checkDiff],
  })
  const result = await agent.run("Review the staged diff.")
  console.log(result.text, result.totalCostUsd)
  for await (const msg of agent.stream("Second question")) {
    if (msg.type === "result") console.log(msg.text)
  }
  const session = await agent.createSession()
  await session.send("hi")
  await agent.close()
}

export async function tier2() {
  for await (const msg of query({ prompt: "What is 2+2?", options: { model: "anthropic/claude-sonnet-4-5" } })) {
    if (msg.type === "result") console.log(msg.text)
  }
}

export async function tier3() {
  const a: string = models.anthropic("claude-sonnet-4-5")
  new Agent({ model: models.anthropic("claude-sonnet-4-5") })
  await shutdown()
  return a
}
