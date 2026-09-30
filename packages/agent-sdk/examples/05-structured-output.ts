import { Agent, defineOutputFormat, type AgentOptions } from "cognitio-agent-sdk"
import { z } from "zod"
import { exampleOptions, runExample } from "./support/options.js"

export const schema = z.object({ summary: z.string(), labels: z.array(z.string()) })

export async function run(options: AgentOptions = {}) {
  const agent = new Agent({
    ...exampleOptions(options),
    allowedTools: ["StructuredOutput"],
    outputFormat: defineOutputFormat(schema, { maxRetries: 2 }),
  })
  try {
    const result = await agent.run("EXAMPLE_STRUCTURED: Summarize: A database migration adds an index.")
    return { result, output: schema.parse(result.structuredOutput) }
  } finally {
    await agent.close()
  }
}

if (import.meta.main) await runExample(run)
