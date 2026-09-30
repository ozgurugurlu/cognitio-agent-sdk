import { Agent, defineAgent, type AgentOptions, type ResultMessage } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const events: string[] = []
  const results: ResultMessage[] = []
  const agent = new Agent({
    ...exampleOptions(options),
    allowedTools: ["task"],
    agents: {
      reviewer: defineAgent({
        description: "Review one sentence for clarity.",
        prompt: "EXAMPLE_REVIEWER: Review the requested sentence and finish with REVIEW_COMPLETE.",
        tools: [],
        permissionMode: "dontAsk",
        steps: 2,
        spawnMode: "fresh",
      }),
    },
  })
  try {
    const stream = agent.stream("EXAMPLE_SUBAGENT: Delegate a review of 'Agents use tools' to reviewer.")
    for await (const message of stream) {
      events.push(message.type)
      if (message.type === "result") results.push(message.result)
    }
    return { result: results.at(-1), events }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
