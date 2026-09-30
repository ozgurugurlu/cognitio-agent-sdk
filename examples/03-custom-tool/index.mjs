import { Agent, defineTool } from "cognitio-agent-sdk"

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

const calculations = []
const multiply = defineTool({
  name: "multiply",
  description: "Multiply two finite numbers and return their product.",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
  execute({ a, b }) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(a * b)) {
      throw new Error("Both inputs and their product must be finite numbers.")
    }
    const calculation = { a, b, product: a * b }
    calculations.push(calculation)
    return calculation
  },
})
const agent = new Agent({
  model,
  instructions: "Use the supplied multiply tool for calculations, then answer briefly with its result.",
  settingSources: [],
  includeEnvironment: false,
  tools: [multiply],
  allowedTools: ["sdk_multiply"],
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
  const result = await agent.run("Use multiply to calculate 6 times 7. Do not calculate it yourself.", {
    signal: AbortSignal.timeout(90_000),
  })
  if (result.isError || result.subtype !== "success") throw new Error(`Calculation failed: ${result.subtype}`)
  const calculation = calculations.find(
    ({ a, b, product }) => ((a === 6 && b === 7) || (a === 7 && b === 6)) && product === 42,
  )
  if (!calculation) throw new Error("The model did not execute multiply with the requested inputs.")
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("The model returned no answer.")
  console.log(`Tool result: ${calculation.a} × ${calculation.b} = ${calculation.product}`)
  console.log(`Assistant: ${result.text.trim()}`)
} finally {
  await agent.close()
}
