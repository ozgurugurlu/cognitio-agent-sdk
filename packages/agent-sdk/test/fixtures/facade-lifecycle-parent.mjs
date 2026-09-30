import { writeFileSync } from "node:fs"
import { Agent, query, shutdown } from "../../src/index.ts"

const mode = process.env.FACADE_FIXTURE_MODE
const readyFile = process.env.FACADE_READY_FILE
const scratchDir = process.env.FACADE_SCRATCH_DIR

function writeReady(value) {
  if (!readyFile) throw new Error("FACADE_READY_FILE is required")
  writeFileSync(readyFile, JSON.stringify(value))
}

function listenerCounts() {
  return {
    beforeExit: process.listenerCount("beforeExit"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    newListener: process.listenerCount("newListener"),
    removeListener: process.listenerCount("removeListener"),
  }
}

function markHostSignal() {
  if (!readyFile) throw new Error("FACADE_READY_FILE is required")
  writeFileSync(`${readyFile}.host`, "handled")
}

// Modes that park the event loop so a signal from the test drives teardown.
const signalHoldModes = new Set([
  "owned-sigterm",
  "owned-sigint",
  "wedged-sigterm",
  "settling-second-signal",
  "host-once",
  "host-once-continues",
  "host-later-persistent",
  "host-removed",
])

async function startAgent(options) {
  if (!scratchDir) throw new Error("FACADE_SCRATCH_DIR is required")
  const agent = new Agent({
    spawn: {
      isolated: true,
      scratchDir,
      port: 0,
      timeout: 15_000,
      shutdownTimeout: options?.shutdownTimeout ?? 250,
    },
  })
  const client = await agent.client()
  const pid = Number(await (await fetch(`${client.baseUrl}/debug/pid`)).text())
  return { agent, pid, baseUrl: client.baseUrl }
}

async function main() {
  if (mode === "untouched-query") {
    query({ prompt: "never consumed" })
    writeReady({ mode })
    return
  }

  const baseline = listenerCounts()
  let hold
  if (mode === "host-once") {
    process.once("SIGTERM", () => {
      clearInterval(hold)
      void shutdown()
        .catch(() => {})
        .finally(() => process.exit(23))
    })
  }
  if (mode === "host-once-continues") {
    process.once("SIGTERM", markHostSignal)
  }

  // A grace period far longer than the test's patience keeps the first
  // teardown unsettled while a second signal is delivered.
  const started = await startAgent(mode === "settling-second-signal" ? { shutdownTimeout: 20_000 } : undefined)
  if (mode === "host-later-persistent") {
    let signals = 0
    process.prependListener("SIGTERM", () => {
      signals += 1
      markHostSignal()
      if (signals < 2) return
      clearInterval(hold)
      void shutdown()
        .catch(() => {})
        .finally(() => process.exit(29))
    })
  }
  if (mode === "host-removed") {
    const listener = () => {}
    process.on("SIGTERM", listener)
    process.removeListener("SIGTERM", listener)
  }
  const active = listenerCounts()

  if (mode === "listener-close") {
    await started.agent.close()
    writeReady({ mode, pid: started.pid, baseline, active, after: listenerCounts() })
    return
  }

  writeReady({ mode, pid: started.pid, baseUrl: started.baseUrl, baseline, active })
  if (mode === "before-exit") return
  if (signalHoldModes.has(mode)) {
    hold = setInterval(() => {}, 60_000)
    return
  }
  throw new Error(`unknown fixture mode: ${mode}`)
}

await main()
