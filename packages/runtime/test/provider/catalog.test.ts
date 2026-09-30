import { expect, test } from "bun:test"
import { parseCatalog } from "../../src/provider/models"
import { tmpdir } from "../fixture/fixture"
import { fileURLToPath } from "node:url"

test("committed provider fixture validates and excludes upstream hosted services", async () => {
  const catalog = parseCatalog(await Bun.file(new URL("../tool/fixtures/models-api.json", import.meta.url)).json())
  expect(Object.keys(catalog).length).toBeGreaterThan(5)
  expect(catalog.cognitio).toBeUndefined()
  expect(catalog.opencode).toBeUndefined()
})

test("invalid pricing and limits are rejected before entering the cache", () => {
  const provider = {
    id: "custom",
    name: "Custom",
    env: [],
    models: {
      broken: {
        id: "broken",
        name: "Broken",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        tool_call: true,
        cost: { input: -1, output: 0 },
        limit: { context: 1000, output: 100 },
      },
    },
  }
  expect(() => parseCatalog({ custom: provider })).toThrow()
  provider.models.broken.cost.input = 0
  provider.models.broken.limit.context = -1
  expect(() => parseCatalog({ custom: provider })).toThrow()
  provider.models.broken.limit.context = 1000
  expect(() =>
    parseCatalog({
      custom: {
        ...provider,
        models: {
          broken: {
            ...provider.models.broken,
            cost: { input: 0, output: 0, context_over_200k: { input: 0, output: -1 } },
          },
        },
      },
    }),
  ).toThrow()
})

test("a validated catalog refresh invalidates an existing provider instance", async () => {
  await using tmp = await tmpdir()
  let price = 1
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/advance") {
        price = 2
        return new Response("ok")
      }
      return Response.json({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            "catalog-test": {
              id: "catalog-test",
              name: "Catalog test",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              tool_call: true,
              cost: { input: price, output: 1 },
              limit: { context: 10000, output: 1000 },
            },
          },
        },
      })
    },
  })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COGNITIO_MODELS_URL: server.url.toString().replace(/\/$/, ""),
    COGNITIO_DISABLE_MODELS_FETCH: "1",
    COGNITIO_ISOLATED: "1",
    OPENAI_API_KEY: "test-only",
    XDG_CACHE_HOME: `${tmp.path}/cache`,
  }
  delete env.COGNITIO_MODELS_PATH
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../fixture/catalog-refresh.ts", import.meta.url)),
      server.url.toString().replace(/\/$/, ""),
      tmp.path,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Catalog refresh probe failed:\n${stdout}\n${stderr}`)
  expect(stdout).toContain("catalog-costs:1,2,3")
}, 15000)
