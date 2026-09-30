import { Agent, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const config = exampleOptions(options)
  // A resumed session keeps its original directory. Select cwd when creating
  // the session, rather than applying a new directory through Agent.resume().
  const agent = new Agent({ ...config, cwd: undefined, directory: undefined, disallowedTools: ["*"] })
  try {
    const session = await agent.createSession({ title: "Example conversation", cwd: config.cwd ?? config.directory })
    await session.send("EXAMPLE_SESSION: Remember that the project uses PostgreSQL.")
    const id = session.id
    await session.close()
    const resumed = await agent.resume(id)
    await resumed.rename("Database planning")
    await resumed.tag("example")
    const result = await resumed.send("EXAMPLE_RESUME: Which database did I name?")
    return { result, id: resumed.id, messages: await resumed.messages() }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
