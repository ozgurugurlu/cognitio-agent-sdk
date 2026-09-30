import { Agent, defineOutputFormat } from "cognitio-agent-sdk"
import { z } from "zod"

const model = process.env.COGNITIO_MODEL?.trim() || "openai/gpt-4.1-mini"
const credential = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[model.split("/")[0]]
if (!model.includes("/")) throw new Error("Set COGNITIO_MODEL to a provider/model identifier.")
if (credential && (!process.env[credential]?.trim() || process.env[credential] === "replace_with_your_key")) {
  throw new Error(`Set ${credential} in .env or your shell before running this example.`)
}
const providerEnv = Object.fromEntries(
  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    .filter((name) => process.env[name]?.trim())
    .map((name) => [name, process.env[name]]),
)

const contactSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  company: z.string().min(1),
})
// Keep the model-facing email schema simple; validate the actual address below.
const modelSchema = contactSchema.extend({
  email: z.string().describe("Email address exactly as written in the input"),
})
const agent = new Agent({
  model,
  instructions: "Extract only information present in the supplied text.",
  settingSources: [],
  includeEnvironment: false,
  allowedTools: ["StructuredOutput"],
  outputFormat: defineOutputFormat(modelSchema, { maxRetries: 1 }),
  maxTurns: 3,
  maxBudgetUsd: 0.03,
  spawn: {
    isolated: true,
    port: 0,
    autoCleanup: true,
    env: { ...providerEnv, COGNITIO_DISABLE_AUTOUPDATE: "1", COGNITIO_DISABLE_LSP_DOWNLOAD: "1" },
    config: { plugin: [], lsp: false, formatter: false, agent: { title: { disable: true } } },
  },
})

try {
  const result = await agent.run("Extract this contact: Mina Patel works at Acme Labs. Email: mina@example.com.", {
    signal: AbortSignal.timeout(90_000),
  })
  if (result.isError || result.subtype !== "success") {
    throw new Error(`Extraction failed: ${result.subtype}: ${result.error?.message ?? "No error details"}`)
  }
  const contact = contactSchema.parse(result.structuredOutput)
  console.log(JSON.stringify(contact, null, 2))
} finally {
  await agent.close()
}
