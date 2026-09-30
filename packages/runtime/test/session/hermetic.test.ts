import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Global } from "../../src/global"
import { Server } from "../../src/server/server"
import { provideTmpdirServer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

const baseCfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
  model: "test/test-model",
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.COGNITIO_TEST_HOME
      process.env.COGNITIO_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.COGNITIO_TEST_HOME = prev
      }),
  )

const isTitleRequest = (input: unknown) => JSON.stringify(input).includes("Generate a title for this conversation")

const DECOY_MARKERS = [
  "EVIL_SKILL_MARKER",
  "PROJ_SKILL_MARKER",
  // the system-prompt skills section (the bare string also appears in the
  // static skill tool parameter description, which is not a leak)
  "<available_skills>",
  "PROJECT_AGENTS_MARKER",
  "GLOBAL_AGENTS_MARKER",
  "DECOY_AGENT_MARKER",
  "DECOY_JSON_AGENT_MARKER",
]

// Identity phrases of the coding presets a promptless session would receive.
const CODING_TOKENS = [
  "interactive CLI tool that helps users with software engineering",
  "the best coding agent on the planet",
]

describe("session.hermetic", () => {
  it.live(
    "session-level isolation hides host decoys from the model while plain sessions still see them",
    () =>
      Effect.gen(function* () {
        // Fake home with external (.claude) skill decoy.
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(async () => {
          const skillDir = path.join(home.path, ".claude", "skills", "evil-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            "---\nname: evil-skill\ndescription: EVIL_SKILL_MARKER\n---\n\nEvil skill body.\n",
          )
        })

        // User-layer instruction decoy. NB: the plan's poison list also names
        // ~/.claude/CLAUDE.md, but globalFiles() reads it from os.homedir()
        // (NOT COGNITIO_TEST_HOME/Global.Path.config), so it cannot be seeded
        // in-process without writing to the developer's real home. The same
        // user-instruction channel (globalFiles) is exercised here via the
        // redirectable Global.Path.config/AGENTS.md decoy below.
        const globalAgents = path.join(Global.Path.config, "AGENTS.md")
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await fs.mkdir(Global.Path.config, { recursive: true })
            await fs.writeFile(globalAgents, "GLOBAL_AGENTS_MARKER\n")
          }),
          () => Effect.promise(() => fs.rm(globalAgents, { force: true }).catch(() => {})),
        )

        yield* withHome(
          home.path,
          provideTmpdirServer(
            Effect.fnUntraced(function* ({ dir, llm }) {
              yield* Effect.promise(async () => {
                await Bun.write(path.join(dir, "AGENTS.md"), "PROJECT_AGENTS_MARKER\n")
                await Bun.write(
                  path.join(dir, ".cognitio", "skill", "proj-skill", "SKILL.md"),
                  "---\nname: proj-skill\ndescription: PROJ_SKILL_MARKER\n---\n\nProject skill body.\n",
                )
                await Bun.write(
                  path.join(dir, ".cognitio", "agent", "decoy-agent.md"),
                  "---\ndescription: DECOY_AGENT_MARKER\nmode: subagent\n---\nDecoy agent prompt\n",
                )
              })

              const app = Server.Default().app
              const query = `?directory=${encodeURIComponent(dir)}`
              const createSession = (body: object) =>
                Effect.promise(async () => {
                  const res = await app.request(`/session${query}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  })
                  expect(res.status).toBe(200)
                  return (await res.json()) as { id: string }
                })
              const sendMessage = (sessionID: string) =>
                Effect.promise(async () => {
                  const res = await app.request(`/session/${sessionID}/message${query}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agent: "build", parts: [{ type: "text", text: "hello" }] }),
                  })
                  expect(res.status).toBe(200)
                  await res.text()
                })
              const capture = Effect.gen(function* () {
                const inputs = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
                expect(inputs.length).toBeGreaterThan(0)
                return JSON.stringify(inputs)
              })

              // A: hermetic session — neutral prompt, no file-discovered resources.
              const hermetic = yield* createSession({
                title: "Hermetic A",
                runtimeConfig: { systemPrompt: "You are a neutral test agent.", settingSources: [] },
              })
              yield* sendMessage(hermetic.id)
              const bodyA = yield* capture
              expect(bodyA).toContain("You are a neutral test agent.")
              for (const marker of DECOY_MARKERS) expect(bodyA).not.toContain(marker)
              for (const token of CODING_TOKENS) expect(bodyA).not.toContain(token)

              const skillsA = yield* Effect.promise(async () => {
                const res = await app.request(`/session/${hermetic.id}/skill${query}`)
                expect(res.status).toBe(200)
                return (await res.json()) as Array<{ name: string }>
              })
              expect(skillsA).toEqual([])

              const commandsA = yield* Effect.promise(async () => {
                const res = await app.request(`/session/${hermetic.id}/command${query}`)
                expect(res.status).toBe(200)
                return ((await res.json()) as Array<{ name: string }>).map((command) => command.name)
              })
              expect(commandsA).toContain("init")
              expect(commandsA).not.toContain("decoy-cmd")
              expect(commandsA).not.toContain("proj-skill")

              // B: plain session — the same host decoys are all visible.
              yield* llm.reset
              const plain = yield* createSession({ title: "Plain B" })
              yield* sendMessage(plain.id)
              const bodyB = yield* capture
              expect(bodyB).toContain("EVIL_SKILL_MARKER")
              expect(bodyB).toContain("PROJ_SKILL_MARKER")
              expect(bodyB).toContain("<available_skills>")
              expect(bodyB).toContain("PROJECT_AGENTS_MARKER")
              expect(bodyB).toContain("GLOBAL_AGENTS_MARKER")
              expect(bodyB).toContain("DECOY_AGENT_MARKER")
              // JSON-config decoy agent appears in the plain session's task
              // description — proving the hermetic session's absence is real,
              // not vacuous (the marker CAN show up).
              expect(bodyB).toContain("DECOY_JSON_AGENT_MARKER")

              // C: explicit coding preset brings the coding identity back.
              yield* llm.reset
              const preset = yield* createSession({
                title: "Preset C",
                runtimeConfig: { systemPrompt: { type: "preset", preset: "default" } },
              })
              yield* sendMessage(preset.id)
              const bodyC = yield* capture
              expect(CODING_TOKENS.some((token) => bodyC.includes(token))).toBe(true)
            }),
            {
              git: true,
              config: (url) => ({
                ...baseCfg,
                provider: {
                  ...baseCfg.provider,
                  test: {
                    ...baseCfg.provider.test,
                    options: { ...baseCfg.provider.test.options, baseURL: url },
                  },
                },
                command: { "decoy-cmd": { template: "decoy body", description: "DECOY_CMD_MARKER" } },
                agent: {
                  "decoy-json-agent": {
                    prompt: "DECOY_JSON_AGENT_MARKER",
                    description: "DECOY_JSON_AGENT_MARKER",
                    mode: "subagent",
                  },
                },
              }),
            },
          ),
        )
      }),
    60_000,
  )
})
