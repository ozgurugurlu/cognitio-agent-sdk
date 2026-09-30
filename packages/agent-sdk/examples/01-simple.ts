import { Agent, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const agent = new Agent({ ...exampleOptions(options), disallowedTools: ["*"] })
  try {
    return await agent.run("EXAMPLE_SIMPLE: Explain what an agent SDK does in two sentences.")
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
