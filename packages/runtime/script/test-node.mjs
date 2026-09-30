import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const scratch = await mkdtemp(path.join(os.tmpdir(), "cognitio-node-smoke-"))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"])
  process.env[key] = path.join(scratch, key)
Object.assign(process.env, {
  COGNITIO_TEST_HOME: scratch,
  COGNITIO_ISOLATED: "1",
  COGNITIO_DISABLE_MODELS_FETCH: "1",
  COGNITIO_DISABLE_AUTOUPDATE: "1",
  COGNITIO_DISABLE_LSP_DOWNLOAD: "1",
  COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  COGNITIO_CONFIG_CONTENT: JSON.stringify({
    plugin: [],
    lsp: false,
    formatter: false,
    share: "disabled",
    provider: {
      smoke: {
        npm: "@ai-sdk/openai-compatible",
        name: "Offline smoke provider",
        options: { baseURL: "http://127.0.0.1:9", apiKey: "unused" },
        models: { test: { name: "Smoke", limit: { context: 8192, output: 1024 } } },
      },
    },
  }),
})

let listener
try {
  const api = await import("../dist/node/node.js")
  await api.Log.init({ print: false, level: "ERROR" })
  await api.bootstrap(scratch, async () => assert.equal((await api.Config.get()).share, "disabled"))
  listener = await api.Server.listen({ hostname: "127.0.0.1", port: 0 })
  const health = await fetch(new URL("global/health", listener.url)).then((response) => response.json())
  assert.equal(health.healthy, true)
  const response = await fetch(new URL(`session?directory=${encodeURIComponent(scratch)}`, listener.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Node embedding smoke",
      runtimeConfig: { settingSources: [], maxTurns: 2, model: { providerID: "smoke", modelID: "test" } },
    }),
  })
  const created = await response.json()
  assert.equal(response.status, 200, JSON.stringify(created))
  assert.equal(created.title, "Node embedding smoke")
  const session = new URL(`session/${created.id}?directory=${encodeURIComponent(scratch)}`, listener.url)
  assert.equal((await fetch(session).then((response) => response.json())).id, created.id)
  const config = await fetch(
    new URL(`session/${created.id}/runtime-config?directory=${encodeURIComponent(scratch)}`, listener.url),
  ).then((response) => response.json())
  assert.equal(config.runtimeConfig?.maxTurns, 2, JSON.stringify(config))
  assert.equal((await fetch(session, { method: "DELETE" })).status, 200)
  // Exercise the native SQLite adapter used by desktop migration as well.
  assert.ok(api.Database.Client().$client.prepare("SELECT count(*) AS count FROM session").get())
  await listener.stop(true)
  listener = undefined
  console.log("Node runtime: health, embedded migrations, session create/read/delete, and runtime config passed")
} finally {
  await listener?.stop(true)
  await rm(scratch, { recursive: true, force: true })
}
// Runtime process registries are normally owned by Electron's application exit.
process.exit(0)
