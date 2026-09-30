import { Agent, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const baseUrl = options.baseUrl ?? process.env.COGNITIO_BASE_URL
  if (!baseUrl) throw new Error("Set COGNITIO_BASE_URL to an existing runtime URL")
  const agent = new Agent({ ...exampleOptions(options), baseUrl, disallowedTools: ["*"], deleteSessionsOnClose: true })
  try {
    return await agent.run("EXAMPLE_REMOTE: Answer through this remote runtime.")
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
