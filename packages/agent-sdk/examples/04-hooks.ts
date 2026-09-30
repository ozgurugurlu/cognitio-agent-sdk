import { Agent, defineTool, PermissionDecision, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const events: string[] = []
  const agent = new Agent({
    ...exampleOptions(options),
    permission: [{ permission: "*", pattern: "*", action: "ask" }],
    // An allowedTools grant settles permission before canUseTool. Leave this
    // operation in the ask path so the application callback decides it.
    tools: [defineTool({ name: "ping", inputJsonSchema: { type: "object", properties: {} }, execute: () => "pong" })],
    canUseTool(name) {
      events.push(`permission:${name}`)
      return name === "sdk_ping" ? PermissionDecision.allow() : PermissionDecision.deny("Only ping is allowed.")
    },
    hooks: {
      PreToolUse: [
        (event) => {
          events.push(event.event)
        },
      ],
      PostToolUse: [
        (event) => {
          events.push(event.event)
        },
      ],
    },
  })
  try {
    return { result: await agent.run("EXAMPLE_HOOKS: Call ping once."), events }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
