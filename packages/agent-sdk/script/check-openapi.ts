/**
 * Verifies that the committed `packages/sdk/openapi.json` still matches what
 * the server package would emit today.
 *
 * This is the *other* half of the drift story. `check:client` proves the
 * vendored client matches the committed spec; this proves the committed spec
 * matches the server. Splitting them is deliberate: a route change in
 * `packages/runtime` should fail *this* check, not turn into a mystery
 * failure inside `packages/agent-sdk`'s unit tests. It is therefore **not**
 * wired into `bun test` — it is a CI and close-out guard.
 *
 * `bun dev generate` builds a fresh in-memory Hono app and runs `hono-openapi`
 * over it. No socket is opened and no port is bound, but it does load the whole
 * `packages/runtime` module graph. Measured at ~1.5 s on an M-series laptop.
 * `packages/runtime/src/cli/cmd/generate.ts` already formats its output
 * through prettier, so a byte comparison is meaningful.
 */

import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")
const repoDir = path.resolve(packageDir, "..", "..")
const serverDir = path.join(repoDir, "packages", "runtime")
const specPath = path.join(repoDir, "packages", "sdk", "openapi.json")

export const STALE_SPEC =
  "packages/sdk/openapi.json is stale — run: bun ./packages/sdk/js/script/build.ts && bun ./packages/agent-sdk/script/generate-client.ts"

/** Runs the server package's spec generator and returns its stdout verbatim. */
export function generateSpec(): string {
  const result = spawnSync(
    process.execPath,
    ["run", "--conditions=browser", path.join("src", "index.ts"), "generate"],
    { cwd: serverDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`bun dev generate exited with code ${result.status}\n${result.stderr}`)
  }
  return result.stdout
}

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--")
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  const [live, committed] = [generateSpec(), await readFile(specPath, "utf8")]
  if (live !== committed) throw new Error(STALE_SPEC)
  console.log("packages/sdk/openapi.json matches the server")
}

if (import.meta.main) await main()
