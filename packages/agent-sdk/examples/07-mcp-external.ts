import { Agent, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"
import { externalMcp } from "./support/external-mcp.js"

export async function run(options: AgentOptions = {}) {
  const mcp = await externalMcp()
  const agent = new Agent({
    ...exampleOptions(options),
    sdkMcpServers: [{ name: "catalog", type: "remote", transport: "http", url: mcp.url, oauth: false }],
    allowedTools: ["catalog_multiply"],
  })
  try {
    return { result: await agent.run("EXAMPLE_MCP: Use catalog multiply to calculate 6 * 7."), calls: mcp.calls }
  } finally {
    try {
      await agent.close()
    } finally {
      await mcp.close()
    }
  }
}

if (import.meta.main) await runExample(run)
