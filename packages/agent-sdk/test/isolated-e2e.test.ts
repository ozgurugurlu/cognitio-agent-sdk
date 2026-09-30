import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createCognitioClient } from "../src/internal/runtime-client/index.js"
import {
  Agent,
  createAgentClient,
  createSdkMcpServer,
  defineTool,
  NEUTRAL_BASE_PROMPT,
  type CognitioConfig,
} from "../src/index.js"
import { reserveLocalPort } from "./port.js"
import { sourceRuntimeArgs } from "./source-runtime.js"

/**
 * MANDATORY deterministic isolated-spawn E2E (plan K7): spawns the REAL repo
 * server from source through the SDK's hermetic transport and proves that the
 * two isolation layers (SDK env composition + server COGNITIO_ISOLATED gates +
 * session-level settingSources/neutral defaults) work together. Always runs —
 * no env-flag gating; no network (models snapshot bundled, fake local LLM,
 * the provider npm package resolves from the repo's static import map).
 */

// PATH shim that runs the real server with its package's source settings,
// even when spawned from a scratch directory in a history-free public export.
function withSourceCognitioBin() {
  const binDir = mkdtempSync(join(tmpdir(), "agent-sdk-source-bin-"))
  const wrapper = join(binDir, "cognitio")
  const previousPath = process.env.PATH
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${[process.execPath, ...sourceRuntimeArgs].map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ")} "$@"\n`,
  )
  chmodSync(wrapper, 0o755)
  process.env.PATH = `${binDir}:${previousPath ?? ""}`
  return {
    // Every spawn below pins this explicitly rather than relying on the PATH
    // entry. Two reasons, both required: an installed platform package would
    // otherwise shadow the shim, and the post-readiness compatibility check
    // only runs for SDK-chosen binaries — a source build reports "local", not
    // the paired runtime version, so a PATH-resolved shim would be rejected.
    // PATH is still set so anything that shells out to `cognitio` finds it.
    path: wrapper,
    cleanup() {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(binDir, { recursive: true, force: true })
    },
  }
}

// Minimal OpenAI-compatible mock that records every request body.
function startFakeLlm() {
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        requests.push(await req.json())
        const chunk = (delta: Record<string, unknown>, finish?: string) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
          })}\n\n`
        const body =
          chunk({ role: "assistant", content: "" }) + chunk({ content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n"
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    reset: () => requests.splice(0),
    stop: () => server.stop(true),
  }
}

const isTitleRequest = (input: unknown) => JSON.stringify(input).includes("Generate a title for this conversation")

function requestToolNames(input: unknown) {
  if (!input || typeof input !== "object" || !("tools" in input) || !Array.isArray(input.tools)) return []
  return input.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return []
    if ("name" in tool && typeof tool.name === "string") return [tool.name]
    if (
      "function" in tool &&
      tool.function &&
      typeof tool.function === "object" &&
      "name" in tool.function &&
      typeof tool.function.name === "string"
    ) {
      return [tool.function.name]
    }
    return []
  })
}

function providerConfig(llmUrl: string): CognitioConfig {
  return {
    model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            limit: { context: 100000, output: 10000 },
          },
        },
        options: { apiKey: "test-key", baseURL: llmUrl },
      },
    },
  } as CognitioConfig
}

const DECOY_MARKERS = [
  "PROJECT_AGENTS_MARKER",
  "GLOBAL_AGENTS_MARKER",
  "PROJ_SKILL_MARKER",
  "<available_skills>",
  "DECOY_AGENT_MARKER",
  "DECOY_JSON_AGENT_MARKER",
]
const CODING_TOKENS = [
  "interactive CLI tool that helps users with software engineering",
  "the best coding agent on the planet",
]

let project: string
let decoyGlobalDir: string
let controlHome: string
let bin: ReturnType<typeof withSourceCognitioBin>
let llm: ReturnType<typeof startFakeLlm>

beforeAll(() => {
  // Module-level hook runs even when the describe is skipped; skip its POSIX
  // shim/LLM setup on win32 to match the skipped suite.
  if (process.platform === "win32") return
  // Poisoned host world, independent of the test process env: a decoy project
  // plus a decoy "global" config dir handed only to the control spawn.
  project = realpathSync(mkdtempSync(join(tmpdir(), "agent-sdk-e2e-project-")))
  writeFileSync(join(project, "AGENTS.md"), "PROJECT_AGENTS_MARKER\n")
  mkdirSync(join(project, ".cognitio", "skill", "proj-skill"), { recursive: true })
  writeFileSync(
    join(project, ".cognitio", "skill", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: PROJ_SKILL_MARKER\n---\n\nProject skill body.\n",
  )
  mkdirSync(join(project, ".cognitio", "agent"), { recursive: true })
  writeFileSync(
    join(project, ".cognitio", "agent", "decoy-agent.md"),
    "---\ndescription: DECOY_AGENT_MARKER\nmode: subagent\n---\nDecoy agent prompt\n",
  )
  writeFileSync(
    join(project, "cognitio.json"),
    JSON.stringify({
      $schema: "https://example.invalid/config.schema.json",
      command: { "decoy-cmd": { template: "decoy body", description: "DECOY_CMD_MARKER" } },
      agent: {
        "decoy-json-agent": {
          prompt: "DECOY_JSON_AGENT_MARKER",
          description: "DECOY_JSON_AGENT_MARKER",
          mode: "subagent",
        },
      },
    }),
  )

  decoyGlobalDir = mkdtempSync(join(tmpdir(), "agent-sdk-e2e-global-"))
  writeFileSync(join(decoyGlobalDir, "AGENTS.md"), "GLOBAL_AGENTS_MARKER\n")

  controlHome = mkdtempSync(join(tmpdir(), "agent-sdk-e2e-home-"))

  bin = withSourceCognitioBin()
  llm = startFakeLlm()
})

afterAll(() => {
  llm?.stop()
  bin?.cleanup()
  for (const dir of [project, decoyGlobalDir, controlHome]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// Runs on every POSIX CI run (no env gate). Skipped on win32: the server shim
// is a `#!/bin/sh` wrapper and the PATH join uses ":"; a Windows variant would
// need a .cmd shim. The two isolation layers are still exercised on the
// ubuntu CI matrix.
describe.skipIf(process.platform === "win32")(
  "cognitio-agent-sdk — mandatory isolated E2E (real server from source)",
  () => {
    test("a separate official MCP client uses an HTTP host already connected to the real runtime", async () => {
      const client = await createAgentClient({
        directory: project,
        spawn: {
          binaryPath: bin.path,
          port: 0,
          timeout: 60000,
          isolated: true,
          config: providerConfig(llm.url),
          env: { COGNITIO_DISABLE_MODELS_FETCH: "1" },
        },
      })
      const external = new McpClient({ name: "separate-content-client", version: "1" })
      const signals: AbortSignal[] = []
      try {
        llm.reset()
        const session = await client.sessions.create({
          runtimeConfig: {
            sdkMcpServers: [
              createSdkMcpServer({
                name: "handbook",
                transport: "http",
                tools: [
                  defineTool({
                    name: "owner",
                    inputSchema: { type: "object" },
                    execute: (_, context) => {
                      signals.push(context.signal)
                      return context.sessionId
                    },
                  }),
                ],
                resources: [
                  {
                    name: "policy",
                    uri: "handbook://policy",
                    read: (context) => ({ contents: [{ uri: "handbook://policy", text: context.sessionId }] }),
                  },
                ],
                prompts: [
                  {
                    name: "review",
                    get: (_, context) => ({
                      messages: [{ role: "user", content: { type: "text", text: context.sessionId } }],
                    }),
                  },
                ],
              }),
            ],
          },
        })
        // The real runtime must already have initialized and used its MCP
        // connection before the independent public-protocol client connects.
        expect((await session.send("hello")).subtype).toBe("success")
        expect(
          llm.requests.flatMap(requestToolNames).some((name) => name.includes("handbook") && name.includes("owner")),
        ).toBe(true)
        const lowLevel = createCognitioClient({ baseUrl: client.baseUrl, directory: project })
        const config = await lowLevel.session.runtimeConfig.get({ sessionID: session.id })
        const descriptor = config.data?.runtimeConfig.sdkMcpServers?.find((server) => server.name === "handbook")
        if (!descriptor || descriptor.type !== "remote")
          throw new Error("Runtime did not receive the owned HTTP MCP host")
        await external.connect(new StreamableHTTPClientTransport(new URL(descriptor.url)))
        expect((await external.listTools()).tools.map((tool) => tool.name)).toEqual(["owner"])
        expect((await external.callTool({ name: "owner" })).content).toEqual([{ type: "text", text: session.id }])
        expect((await external.listResources()).resources[0]?.uri).toBe("handbook://policy")
        expect((await external.readResource({ uri: "handbook://policy" })).contents[0]).toMatchObject({
          text: session.id,
        })
        expect((await external.listPrompts()).prompts[0]?.name).toBe("review")
        expect((await external.getPrompt({ name: "review" })).messages[0]?.content).toEqual({
          type: "text",
          text: session.id,
        })
        // The second initialize must not replace or invalidate the first one.
        llm.reset()
        expect((await session.send("hello again")).subtype).toBe("success")
        expect(
          llm.requests.flatMap(requestToolNames).some((name) => name.includes("handbook") && name.includes("owner")),
        ).toBe(true)
        await session.close()
        expect(signals).toHaveLength(1)
        expect(signals[0]!.aborted).toBe(true)
        await expect(external.listResources()).rejects.toThrow()
        await expect(fetch(descriptor.url)).rejects.toThrow()
      } finally {
        await external.close()
        await client.close()
      }
    }, 60000)

    test("isolated spawn: neutral prompt, zero decoys, scratch world", async () => {
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-e2e-scratch-"))
      const port = await reserveLocalPort()
      try {
        llm.reset()
        const client = await createAgentClient({
          directory: project,
          spawn: {
            port,
            binaryPath: bin.path,
            hostname: "127.0.0.1",
            timeout: 60000,
            isolated: true,
            scratchDir: scratchParent,
            config: providerConfig(llm.url),
            env: { COGNITIO_DISABLE_MODELS_FETCH: "1" },
          },
        })
        try {
          const scratch = join(scratchParent, readdirSync(scratchParent)[0]!)

          const session = await client.sessions.create({ cwd: project, title: "Isolated E2E" })
          const result = await session.send("hello")
          expect(result.subtype).toBe("success")

          const captured = llm.requests.filter((request) => !isTitleRequest(request))
          expect(captured.length).toBeGreaterThan(0)
          const body = JSON.stringify(captured)
          expect(body).toContain(NEUTRAL_BASE_PROMPT)
          for (const marker of DECOY_MARKERS) expect(body).not.toContain(marker)
          for (const token of CODING_TOKENS) expect(body).not.toContain(token)

          const applied = await session.getAppliedSettings()
          expect(applied.settingSources).toEqual([])
          expect(applied.systemPrompt?.mode).toBe("neutral")

          const lowLevel = createCognitioClient({ baseUrl: client.baseUrl, directory: project })
          const skills = await lowLevel.session.skills({ sessionID: session.id, directory: project })
          expect(skills.data).toEqual([])
          const commands = await lowLevel.session.commands({ sessionID: session.id, directory: project })
          const commandNames = (commands.data as Array<{ name: string }>).map((command) => command.name)
          expect(commandNames).toContain("init")
          expect(commandNames).not.toContain("decoy-cmd")
          expect(commandNames).not.toContain("proj-skill")

          // XDG redirect proof: the server persisted its state under the scratch.
          expect(readdirSync(join(scratch, "xdg", "data")).length).toBeGreaterThan(0)
        } finally {
          await client.close()
        }
        expect(readdirSync(scratchParent)).toEqual([])
      } finally {
        rmSync(scratchParent, { recursive: true, force: true })
      }
    }, 120000)

    test("Agent facade: one dedicated server, fresh runs, neutral profile, tool policy, and explicit escape hatch", async () => {
      const scratchParent = mkdtempSync(join(tmpdir(), "agent-sdk-facade-e2e-scratch-"))
      const agent = new Agent({
        model: "test/test-model",
        cwd: project,
        spawn: {
          port: await reserveLocalPort(),
          binaryPath: bin.path,
          scratchDir: scratchParent,
          config: providerConfig(llm.url),
          env: { COGNITIO_DISABLE_MODELS_FETCH: "1" },
        },
      })
      try {
        llm.reset()
        const client = await agent.client()
        expect(readdirSync(scratchParent)).toHaveLength(1)

        const first = await agent.run("hello from facade")
        expect(first).toMatchObject({ subtype: "success", text: "ok", isError: false })
        const firstSession = await client.sessions.get(first.sessionId)
        try {
          const applied = await firstSession.getAppliedSettings()
          expect(applied.settingSources).toEqual([])
          expect(applied.systemPrompt?.mode).toBe("neutral")
          expect(applied.tools.disallowed).toEqual(["question", "todowrite", "skill"])
        } finally {
          await firstSession.close()
        }

        const inference = llm.requests.filter((request) => !isTitleRequest(request))
        expect(inference).toHaveLength(1)
        expect(llm.requests.filter(isTitleRequest)).toEqual([])
        const firstBody = JSON.stringify(inference[0])
        expect(firstBody).toContain(NEUTRAL_BASE_PROMPT)
        for (const marker of DECOY_MARKERS) expect(firstBody).not.toContain(marker)
        for (const token of CODING_TOKENS) expect(firstBody).not.toContain(token)
        const defaultTools = requestToolNames(inference[0])
        // D-P13-5 leaves all eight of these open by default; webfetch (network
        // egress) and task (subagent spawning) are the two an isolated,
        // settingSources-free session would be most likely to silently drop.
        for (const tool of ["bash", "read", "glob", "grep", "edit", "write", "webfetch", "task"]) {
          expect(defaultTools).toContain(tool)
        }
        for (const tool of ["question", "todowrite", "skill"]) expect(defaultTools).not.toContain(tool)

        const lowLevel = createCognitioClient({ baseUrl: client.baseUrl, directory: project })
        const agents = await lowLevel.app.agents({ directory: project })
        const agentNames = (agents.data as Array<{ name: string }>).map((item) => item.name)
        expect(agentNames).not.toContain("title")

        const second = await agent.run("hello again")
        expect(second).toMatchObject({ subtype: "success", text: "ok", isError: false })
        expect(new Set([first.sessionId, second.sessionId]).size).toBe(2)
        expect(llm.requests.filter((request) => !isTitleRequest(request))).toHaveLength(2)
        expect(llm.requests.filter(isTitleRequest)).toEqual([])
        expect(readdirSync(scratchParent)).toHaveLength(1)
      } finally {
        await agent.close().catch(() => {})
      }
      expect(readdirSync(scratchParent)).toEqual([])

      const permissive = new Agent({
        model: "test/test-model",
        cwd: project,
        disallowedTools: [],
        spawn: {
          port: await reserveLocalPort(),
          binaryPath: bin.path,
          scratchDir: scratchParent,
          config: providerConfig(llm.url),
          env: { COGNITIO_DISABLE_MODELS_FETCH: "1" },
        },
      })
      try {
        llm.reset()
        const result = await permissive.run("show the question tool")
        expect(result).toMatchObject({ subtype: "success", text: "ok", isError: false })
        const inference = llm.requests.filter((request) => !isTitleRequest(request))
        expect(inference).toHaveLength(1)
        expect(requestToolNames(inference[0])).toContain("question")
        expect(readdirSync(scratchParent)).toHaveLength(1)
      } finally {
        await permissive.close().catch(() => {})
      }
      expect(readdirSync(scratchParent)).toEqual([])
      rmSync(scratchParent, { recursive: true, force: true })
    }, 180000)

    test("non-isolated control spawn: the same decoys are visible", async () => {
      const port = await reserveLocalPort()
      llm.reset()
      const client = await createAgentClient({
        directory: project,
        spawn: {
          port,
          binaryPath: bin.path,
          hostname: "127.0.0.1",
          timeout: 60000,
          config: providerConfig(llm.url),
          isolated: false,
          // Deterministic fake host world for the control run: never touch the
          // developer's real home; hand it the decoy global dir explicitly.
          env: {
            HOME: controlHome,
            XDG_CONFIG_HOME: join(controlHome, ".config"),
            XDG_DATA_HOME: join(controlHome, ".local", "share"),
            XDG_CACHE_HOME: join(controlHome, ".cache"),
            XDG_STATE_HOME: join(controlHome, ".local", "state"),
            COGNITIO_CONFIG_DIR: decoyGlobalDir,
            COGNITIO_DISABLE_MODELS_FETCH: "1",
            COGNITIO_DISABLE_AUTOUPDATE: "1",
          },
        },
      })
      try {
        const session = await client.sessions.create({
          cwd: project,
          title: "Control E2E",
          runtimeConfig: {
            systemPrompt: { type: "preset", preset: "default" },
            settingSources: ["user", "project", "local"],
          },
        })
        const result = await session.send("hello")
        expect(result.subtype).toBe("success")

        const captured = llm.requests.filter((request) => !isTitleRequest(request))
        const body = JSON.stringify(captured)
        expect(body).toContain("PROJECT_AGENTS_MARKER")
        expect(body).toContain("GLOBAL_AGENTS_MARKER")
        expect(body).toContain("PROJ_SKILL_MARKER")
        expect(body).toContain("<available_skills>")
        expect(body).toContain("DECOY_AGENT_MARKER")
        expect(CODING_TOKENS.some((token) => body.includes(token))).toBe(true)
      } finally {
        await client.close()
      }
    }, 120000)
  },
)
