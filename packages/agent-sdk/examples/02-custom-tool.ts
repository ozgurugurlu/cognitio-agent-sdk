import { Agent, defineTool, type AgentOptions } from "cognitio-agent-sdk"
import { z } from "zod"
import { exampleOptions, runExample } from "./support/options.js"

export async function run(options: AgentOptions = {}) {
  const calls: Array<{ a: number; b: number }> = []
  const schema = z.object({ a: z.number(), b: z.number() })
  const add = defineTool({
    name: "add",
    description: "Add two numbers.",
    inputSchema: schema,
    execute(args: unknown) {
      // The schema is advertised to the model; validate again at the effect boundary.
      const input = schema.parse(args)
      calls.push(input)
      return { sum: input.a + input.b }
    },
  })
  const agent = new Agent({ ...exampleOptions(options), tools: [add], allowedTools: ["sdk_add"] })
  try {
    return { result: await agent.run("EXAMPLE_CUSTOM_TOOL: Use add to calculate 2 + 3."), calls }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
