import { Agent, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const agent = new Agent({
    ...exampleOptions(options),
    disallowedTools: ["*"],
    settingSources: [],
    includeEnvironment: false,
    compaction: { auto: false, includeFiles: false },
    backgroundTaskPolicy: { mode: "foreground" },
  })
  try {
    const session = await agent.createSession()
    await session.setPermissionMode("dontAsk")
    return await session.getAppliedSettings()
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
