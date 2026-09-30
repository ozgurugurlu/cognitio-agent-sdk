import { Agent } from "cognitio-agent-sdk"

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

const agent = new Agent({
  model,
  instructions: "Explain things clearly and briefly. Do not call tools.",
  settingSources: [],
  includeEnvironment: false,
  disallowedTools: ["*"],
  maxTurns: 1,
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
  const result = await agent.run("In two short sentences, explain what an agent SDK does.", {
    signal: AbortSignal.timeout(90_000),
  })
  if (result.isError || result.subtype !== "success") throw new Error(`Chat failed: ${result.subtype}`)
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("The model returned no answer.")
  console.log(result.text.trim())
} finally {
  await agent.close()
}
