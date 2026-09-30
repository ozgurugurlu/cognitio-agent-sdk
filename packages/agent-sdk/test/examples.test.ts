import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  Agent,
  createAgentClient,
  query,
  shutdown,
  type AgentClient,
  type AgentOptions,
  type CognitioConfig,
  type SpawnOptions,
} from "cognitio-agent-sdk"
import { run as simple } from "../examples/01-simple.js"
import { run as customTool } from "../examples/02-custom-tool.js"
import { run as subagent } from "../examples/03-subagent.js"
import { run as hooks } from "../examples/04-hooks.js"
import { run as structured } from "../examples/05-structured-output.js"
import { run as resume } from "../examples/06-session-resume.js"
import { run as externalMcp } from "../examples/07-mcp-external.js"
import { run as remote } from "../examples/08-remote.js"
import { run as autoPermissions } from "../examples/09-auto-permissions.js"
import { run as appliedSettings } from "../examples/10-applied-settings.js"
import { run as sessionFeatures } from "../examples/11-session-features.js"
import { sourceRuntimeArgs } from "./source-runtime.js"

type ModelRequest = {
  stream?: boolean
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>
  tools?: Array<{ function: { name: string } }>
}

const requests: ModelRequest[] = []
let invalidAdditionInput = false
const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cognitio-examples-")))
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cognitio-examples-scratch-")))

// Only the model endpoint is deterministic. All runtime routes, sessions,
// permissions, hooks, tools, subagents, MCP and persistence execute for real.
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
    const body = (await request.json()) as ModelRequest
    requests.push(body)
    const names = body.tools?.map((tool) => tool.function.name) ?? []
    const text = JSON.stringify(body.messages)
    const latest = body.messages.map((message) => message.role).lastIndexOf("user")
    const used = body.messages.slice(latest + 1).some((message) => message.role === "tool")
    const tool =
      !used && !text.includes("EXAMPLE_REVIEWER")
        ? text.includes("EXAMPLE_CUSTOM_TOOL")
          ? names.find((name) => name === "sdk_add")
          : text.includes("EXAMPLE_HOOKS")
            ? names.find((name) => name === "sdk_ping")
            : text.includes("EXAMPLE_SUBAGENT")
              ? names.find((name) => name === "task")
              : text.includes("EXAMPLE_MCP")
                ? names.find((name) => name.endsWith("_multiply"))
                : text.includes("EXAMPLE_AUTO")
                  ? names.find((name) => name === "sdk_status")
                  : names.includes("StructuredOutput")
                    ? "StructuredOutput"
                    : undefined
        : undefined
    const input =
      tool === "sdk_add"
        ? { a: invalidAdditionInput ? "not a number" : 2, b: 3 }
        : tool?.endsWith("_multiply")
          ? { a: 6, b: 7 }
          : tool === "task"
            ? { description: "Review sentence", prompt: "Review 'Agents use tools'.", subagent_type: "reviewer" }
            : tool === "StructuredOutput"
              ? { summary: "A database migration adds an index.", labels: ["database"] }
              : {}
    const answer = text.includes("Classify whether a tool request")
      ? JSON.stringify({ decision: "allow", confidence: 1, reason: "Read-only status inspection." })
      : text.includes("EXAMPLE_REVIEWER") || text.includes("EXAMPLE_SUBAGENT")
        ? "REVIEW_COMPLETE"
        : text.includes("EXAMPLE_RESUME")
          ? "The project uses PostgreSQL."
          : text.includes("EXAMPLE_MCP")
            ? "42"
            : text.includes("EXAMPLE_CUSTOM_TOOL")
              ? "5"
              : "Cognitio runs agents through a real runtime."
    if (!body.stream)
      return Response.json({
        id: "example-completion",
        object: "chat.completion",
        created: 1,
        model: "example-model",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: `example-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "example-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
      })}\n\n`
    return new Response(
      chunk({ role: "assistant", content: "" }) +
        (tool
          ? chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(input) },
                },
              ],
            })
          : chunk({ content: answer })) +
        chunk({}, tool ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

let client: AgentClient
function options(): AgentOptions {
  return { client, cwd: temporary, model: "examples/example-model" }
}

function runtimeOptions(overrides: SpawnOptions = {}) {
  const config: CognitioConfig = {
    model: "examples/example-model",
    lsp: false,
    formatter: false,
    agent: { title: { disable: true } },
    provider: {
      examples: {
        name: "Deterministic examples provider",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "example-model": {
            name: "Example model",
            tool_call: true,
            limit: { context: 100000, output: 10000 },
            cost: { input: 1, output: 2 },
          },
        },
        options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "local-test-only" },
      },
    },
  }
  return {
    directory: temporary,
    spawn: {
      ...overrides,
      isolated: true,
      port: 0,
      timeout: overrides.timeout ?? 60000,
      scratchDir: overrides.scratchDir ?? scratch,
      config,
      env: {
        ...overrides.env,
        COGNITIO_DISABLE_MODELS_FETCH: "1",
        COGNITIO_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      },
      spawnProcess(request: Parameters<NonNullable<SpawnOptions["spawnProcess"]>>[0]) {
        return spawn(process.execPath, [...sourceRuntimeArgs, ...request.args], {
          env: request.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      },
    },
  }
}

beforeAll(async () => {
  client = await createAgentClient(runtimeOptions())
}, 90000)

afterAll(async () => {
  try {
    await client?.close()
    expect(readdirSync(scratch)).toEqual([])
  } finally {
    await model.stop(true)
    rmSync(temporary, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

describe("documented examples against the real runtime", () => {
  test("01 simple: terminal text and session identity", async () => {
    const firstRequest = requests.length
    const result = await simple(options())
    expect(result).toMatchObject({
      subtype: "success",
      isError: false,
      text: "Cognitio runs agents through a real runtime.",
    })
    expect(result.usage?.inputTokens).toBe(5)
    expect(result.usage?.outputTokens).toBe(3)
    expect(result.totalCostUsd).toBeGreaterThan(0)
    const turns = requests.slice(firstRequest)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.flatMap((request) => request.tools ?? [])).toEqual([])
  }, 30000)

  test("02 tool: validated arguments execute in the caller", async () => {
    const output = await customTool(options())
    expect(output.result.subtype).toBe("success")
    expect(output.result.text).toBe("5")
    expect(output.calls).toEqual([{ a: 2, b: 3 }])
  }, 30000)

  test("02 tool: explicit parsing rejects malformed arguments before side effects", async () => {
    const firstRequest = requests.length
    invalidAdditionInput = true
    try {
      const output = await customTool(options())
      expect(output.calls).toEqual([])
      const toolReplies = requests
        .slice(firstRequest)
        .flatMap((request) => request.messages.filter((message) => message.role === "tool"))
      expect(toolReplies.some((message) => JSON.stringify(message.content).includes("invalid_type"))).toBe(true)
    } finally {
      invalidAdditionInput = false
    }
  }, 30000)

  test("03 subagent: actual child turn and lifecycle events", async () => {
    const output = await subagent(options())
    expect(output.result?.subtype).toBe("success")
    expect(output.events).toContain("subagent.start")
    expect(output.events).toContain("subagent.stop")
    expect(requests.some((request) => JSON.stringify(request.messages).includes("EXAMPLE_REVIEWER"))).toBe(true)
  }, 30000)

  test("04 hooks: permission callback and both tool hooks", async () => {
    const output = await hooks(options())
    expect(output.result.subtype).toBe("success")
    expect(output.events).toContain("PreToolUse")
    expect(output.events).toContain("PostToolUse")
    expect(output.events).toContain("permission:sdk_ping")
  }, 30000)

  test("05 structured output: actual runtime schema tool", async () => {
    const firstRequest = requests.length
    const output = await structured(options())
    expect(output.result.subtype).toBe("success")
    expect(output.output).toEqual({ summary: "A database migration adds an index.", labels: ["database"] })
    const turns = requests.slice(firstRequest)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.every((request) => request.tools?.length === 1)).toBe(true)
    expect(turns.flatMap((request) => request.tools?.map((tool) => tool.function.name) ?? [])).toEqual([
      "StructuredOutput",
    ])
  }, 30000)

  test("06 resume: persisted transcript survives handle close", async () => {
    const output = await resume(options())
    expect(output.result.subtype).toBe("success")
    expect(output.result.sessionId).toBe(output.id)
    expect(output.result.text).toContain("PostgreSQL")
    expect(output.messages.length).toBeGreaterThanOrEqual(4)
  }, 30000)

  test("07 MCP: real HTTP service executes remote tool", async () => {
    const output = await externalMcp(options())
    expect(output.result.subtype).toBe("success")
    expect(output.calls).toEqual([{ a: 6, b: 7 }])
    expect(output.result.text).toBe("42")
  }, 30000)

  test("08 remote: owned remote session is deleted without stopping server", async () => {
    const output = await remote({ baseUrl: client.baseUrl, cwd: temporary, model: "examples/example-model" })
    expect(output.subtype).toBe("success")
    await expect(client.sessions.get(output.sessionId)).rejects.toThrow()
    expect((await fetch(new URL("/global/health", client.baseUrl))).ok).toBe(true)
  }, 30000)

  test("09 auto: real model classification authorizes read-only tool", async () => {
    const output = await autoPermissions(options())
    expect(output.result.subtype).toBe("success")
    expect(output.calls).toEqual(["status"])
    expect(
      requests.some((request) => JSON.stringify(request.messages).includes("Classify whether a tool request")),
    ).toBe(true)
  }, 30000)

  test("10 settings: configured policy is reported by runtime", async () => {
    expect(await appliedSettings(options())).toMatchObject({
      permissionMode: "dontAsk",
      settingSources: [],
      includeEnvironment: false,
      compaction: { auto: false, includeFiles: false },
      backgroundTaskPolicy: { mode: "foreground" },
    })
  }, 30000)

  test("quickstart streaming: public envelope contains nested terminal result", async () => {
    const firstRequest = requests.length
    const messages = []
    for await (const message of query({
      prompt: "EXAMPLE_SIMPLE: Stream a short answer.",
      options: { ...options(), disallowedTools: ["*"], includePartialMessages: true },
    }))
      messages.push(message)
    expect(messages.some((message) => message.type === "partial")).toBe(true)
    expect(messages.find((message) => message.type === "result")).toMatchObject({
      result: { subtype: "success" },
      text: "Cognitio runs agents through a real runtime.",
    })
    const turns = requests.slice(firstRequest)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.flatMap((request) => request.tools ?? [])).toEqual([])
  }, 30000)

  test("11 session features: real rewind, command, fork, plugin and compaction hooks", async () => {
    await expect(sessionFeatures(options())).rejects.toThrow("requires an owned local runtime")
    await expect(sessionFeatures({ baseUrl: client.baseUrl })).rejects.toThrow("requires an owned local runtime")
    const existingScratch = readdirSync(scratch)
    const output = await sessionFeatures({ ...options(), client: undefined, spawn: runtimeOptions().spawn })
    expect(readdirSync(scratch)).toEqual(existingScratch)
    expect((await fetch(new URL("/global/health", client.baseUrl), { signal: AbortSignal.timeout(5000) })).status).toBe(
      200,
    )
    expect(output.restoredText).toBe("original\n")
    expect(output.rewind.affectedFiles.some((file) => file.endsWith("example.txt"))).toBe(true)
    expect(output.command.subtype).toBe("success")
    expect(output.forkId).not.toBe(output.sessionId)
    expect(output.checkpoints.length).toBeGreaterThanOrEqual(2)
    expect(output.summary.compactionId).toBeTruthy()
    expect(output.summary.summaryText).toBeTruthy()
    expect(output.hooks).toEqual(["PreCompact", "PostCompact"])
    expect(output.settings.commands.some((command) => command.name === "review")).toBe(true)
    expect(output.settings.plugins.some((plugin) => plugin.name === "editorial")).toBe(true)
    expect(output.settings.skills.some((skill) => skill.source === "plugin")).toBe(true)
    expect(requests.some((request) => JSON.stringify(request.messages).includes("EXAMPLE_COMPACT_INSTRUCTION"))).toBe(
      true,
    )
    expect(requests.some((request) => JSON.stringify(request.messages).includes("EXAMPLE_HOOK_INSTRUCTION"))).toBe(true)
  }, 90000)
})

// Execute the documented bodies unchanged after importing the public API.
// Only runtime/model connections, nonsecret environment values, and process
// signal delivery are injected; no provider credentials or OS signals escape.
function publishedSnippets(file: string) {
  return [
    ...readFileSync(path.resolve(import.meta.dir, file), "utf8").matchAll(
      /^```(?:js|ts)(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)^```[ \t]*\r?$/gm,
    ),
  ]
    .map((match) => match[1]!)
    .filter((block) => block.includes('from "cognitio-agent-sdk"') && block.includes("await"))
}

async function runPublishedSnippet(
  block: string,
  fixture: {
    connect?: typeof createAgentClient
    env?: Record<string, string>
    signals?: EventEmitter
  } = {},
) {
  const output: unknown[][] = []
  const AgentWithRuntime = class extends Agent {
    constructor(config: AgentOptions) {
      super({ ...config, ...options(), client: config.client ?? client, spawn: undefined, baseUrl: undefined })
    }
  }
  const queryWithRuntime = (input: Parameters<typeof query>[0]) =>
    query({
      ...input,
      options: { ...input.options, ...options(), spawn: undefined, baseUrl: undefined },
    })
  const connect =
    fixture.connect ??
    ((config: Parameters<typeof createAgentClient>[0]) =>
      createAgentClient({ ...config, baseUrl: client.baseUrl, directory: temporary, spawn: undefined }))
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(
    block.replace(/import\s+\{[^}]+\}\s+from\s+["']cognitio-agent-sdk["'];?\s*/g, ""),
  )
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...arguments_: string[]
  ) => (...values: unknown[]) => Promise<unknown>
  const signals = fixture.signals ?? new EventEmitter()
  await new AsyncFunction("Agent", "query", "shutdown", "createAgentClient", "console", "process", body)(
    AgentWithRuntime,
    queryWithRuntime,
    shutdown,
    connect,
    { log: (...values: unknown[]) => output.push(values) },
    {
      env: {
        OPENAI_API_KEY: "local-snippet-test-only",
        ANTHROPIC_API_KEY: "local-snippet-test-only",
        ...fixture.env,
      },
      once: signals.once.bind(signals),
    },
  )
  expect(output.length).toBeGreaterThan(0)
  expect(output.every((values) => values[0] !== undefined)).toBe(true)
  return output
}

for (const [file, count] of [
  ["../../docs/quickstart.mdx", 1],
  ["../../../README.md", 2],
  ["../../docs/migration/claude-agent-sdk.mdx", 1],
] as const) {
  const blocks = publishedSnippets(file)
  // Changing a title or fence must never silently remove a documented example.
  if (blocks.length !== count) throw new Error(`Expected ${count} complete snippets in ${file}, found ${blocks.length}`)
  for (const [index, block] of blocks.entries()) {
    test(`published snippet ${file} #${index + 1}`, async () => {
      const firstRequest = requests.length
      await runPublishedSnippet(block)
      expect(requests.length).toBeGreaterThan(firstRequest)
    }, 30000)
  }
}

const remoteSnippets = publishedSnippets("../../docs/cookbook/remote.mdx")
if (remoteSnippets.length !== 3) throw new Error("Expected the remote owner and both remote client snippets")
for (const authenticated of [false, true]) {
  test(`published remote snippets: owner shutdown and ${authenticated ? "authenticated" : "local"} client`, async () => {
    const ownedScratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cognitio-snippet-owner-")))
    const signals = new EventEmitter()
    const connections: AgentClient[] = []
    const username = "snippet-user"
    const password = "local-snippet-password-only"
    const headers = authenticated
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      : undefined
    let owner: Promise<AgentClient> | undefined
    const connect: typeof createAgentClient = async (config) => {
      if (config?.spawn) {
        if (owner) throw new Error("The owner snippet started more than one runtime")
        owner = createAgentClient(
          runtimeOptions({
            ...config.spawn,
            scratchDir: ownedScratch,
            timeout: 15000,
            env: authenticated ? { COGNITIO_SERVER_USERNAME: username, COGNITIO_SERVER_PASSWORD: password } : {},
          }),
        )
        return owner
      }
      if (!owner) throw new Error("The client snippet ran before its runtime owner")
      const connection = await createAgentClient({
        ...config,
        baseUrl: (await owner).baseUrl,
        directory: temporary,
      })
      connections.push(connection)
      return connection
    }
    const ready = once(signals, "ready", { signal: AbortSignal.timeout(15000) })
    signals.on("newListener", (event) => {
      if (event === "SIGTERM") queueMicrotask(() => signals.emit("ready"))
    })
    const running = runPublishedSnippet(remoteSnippets[0]!, { connect, signals })
    // Observe a startup rejection immediately while waiting for signal handlers.
    running.catch(() => {})
    try {
      await Promise.race([
        ready,
        running.then(() => {
          throw new Error("Owner exited before client connection")
        }),
      ])
      if (!owner) throw new Error("The owner snippet did not start a runtime")
      const host = await owner
      const health = () =>
        fetch(new URL("/global/health", host.baseUrl), { headers, signal: AbortSignal.timeout(5000) })
      expect(readdirSync(ownedScratch)).toHaveLength(1)
      expect((await health()).status).toBe(200)
      if (authenticated) {
        expect(
          (await fetch(new URL("/global/health", host.baseUrl), { signal: AbortSignal.timeout(5000) })).status,
        ).toBe(401)
      }
      const firstRequest = requests.length
      await runPublishedSnippet(remoteSnippets[authenticated ? 2 : 1]!, {
        connect,
        env: {
          COGNITIO_REMOTE_URL: host.baseUrl,
          COGNITIO_REMOTE_USERNAME: username,
          COGNITIO_REMOTE_PASSWORD: password,
        },
      })
      expect(requests.length).toBeGreaterThan(firstRequest)
      expect(connections).toHaveLength(1)
      await expect(connections[0]!.sessions.create()).rejects.toMatchObject({ kind: "closed" })
      // The client snippet closes its handles without taking the host with it.
      expect((await health()).status).toBe(200)
      expect(readdirSync(ownedScratch)).toHaveLength(1)
      expect(signals.emit("SIGTERM")).toBe(true)
      await running
      // These assertions precede defensive test cleanup: the documented finally
      // block itself must have stopped the process and removed its scratch.
      expect(readdirSync(ownedScratch)).toEqual([])
      await expect(health()).rejects.toThrow()
      expect(
        (await fetch(new URL("/global/health", client.baseUrl), { signal: AbortSignal.timeout(5000) })).status,
      ).toBe(200)
    } finally {
      const host = await owner?.catch(() => undefined)
      signals.emit("SIGTERM")
      await Promise.allSettled([...connections.map((connection) => connection.close()), host?.close(), running])
      signals.removeAllListeners()
      rmSync(ownedScratch, { recursive: true, force: true })
    }
  }, 30000)
}

test.skipIf(!process.env.COGNITIO_EXAMPLES_LIVE)(
  "live-provider documented quickstart (explicit opt-in)",
  async () => {
    const agent = new Agent({
      model: process.env.COGNITIO_MODEL ?? "anthropic/claude-sonnet-4-5",
      disallowedTools: ["*"],
      maxTurns: 1,
    })
    try {
      const result = await agent.run("Reply with the word ready.")
      expect(result.subtype).toBe("success")
      expect(result.text.length).toBeGreaterThan(0)
    } finally {
      try {
        await agent.close()
      } finally {
        await shutdown()
      }
    }
  },
  120000,
)
