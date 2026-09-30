import { Agent, defineTool, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const calls: string[] = []
  const config = exampleOptions(options)
  const agent = new Agent({
    ...config,
    permissionMode: "auto",
    autoPermissionClassifierModel: config.model,
    permission: [{ permission: "*", pattern: "*", action: "ask" }],
    // Keep the operation in the ask path; an allowlist grant skips classification.
    tools: [
      defineTool({
        name: "status",
        description: "Read the current service health without changing anything.",
        inputJsonSchema: { type: "object", properties: {} },
        execute: () => {
          calls.push("status")
          return "healthy"
        },
      }),
    ],
  })
  try {
    return { result: await agent.run("EXAMPLE_AUTO: Check the read-only status tool."), calls }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
