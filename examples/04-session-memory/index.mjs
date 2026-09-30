import { createAgentClient } from "cognitio-agent-sdk"

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

// This client owns one isolated runtime. Closing a session handle leaves its
// transcript available here; closing this client removes the isolated state.
const client = await createAgentClient({
  spawn: {
    isolated: true,
    port: 0,
    autoCleanup: true,
    env: { ...providerEnv, COGNITIO_DISABLE_AUTOUPDATE: "1", COGNITIO_DISABLE_LSP_DOWNLOAD: "1" },
    config: { plugin: [], lsp: false, formatter: false, agent: { title: { disable: true } } },
  },
})

try {
  const session = await client.sessions.create({
    title: "Database memory example",
    runtimeConfig: {
      model,
      instructions: "Remember facts from this conversation and answer briefly. Do not call tools.",
      settingSources: [],
      includeEnvironment: false,
      disallowedTools: ["*"],
      maxTurns: 1,
      maxBudgetUsd: 0.03,
    },
  })
  const saved = await session.send("Remember that this project uses PostgreSQL. Reply with Saved.", {
    signal: AbortSignal.timeout(90_000),
  })
  if (saved.subtype !== "success") throw new Error(`First turn failed: ${saved.subtype}`)
  const sessionId = session.id
  await session.close()

  const resumed = await client.sessions.resume(sessionId)
  if (resumed.id !== sessionId) throw new Error("The resumed session ID changed.")
  const recalled = await resumed.send("Which database did I name? Reply only with the database name.", {
    signal: AbortSignal.timeout(90_000),
  })
  if (recalled.subtype !== "success") throw new Error(`Recall failed: ${recalled.subtype}`)
  if (typeof recalled.text !== "string" || !recalled.text.toLowerCase().includes("postgresql")) {
    throw new Error("The resumed conversation did not recall PostgreSQL.")
  }
  console.log(`Resumed the same session: ${sessionId}`)
  console.log(`Remembered database: ${recalled.text.trim()}`)
  await resumed.close()
} finally {
  await client.close()
}
