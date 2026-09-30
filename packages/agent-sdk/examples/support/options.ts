import { shutdown, type AgentOptions } from "cognitio-agent-sdk"

/** Override connection/model options in tests or when embedding an example. */
export function exampleOptions(options: AgentOptions = {}): AgentOptions {
  return {
    model: process.env.COGNITIO_MODEL ?? "anthropic/claude-sonnet-4-5",
    maxTurns: 6,
    ...options,
  }
}

/** CLI entrypoints own global teardown; imported run() functions leave it to their caller. */
export async function runExample(run: () => Promise<unknown>): Promise<void> {
  try {
    console.log(await run())
  } finally {
    await shutdown()
  }
}
