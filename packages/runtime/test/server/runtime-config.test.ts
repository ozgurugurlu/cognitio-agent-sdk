import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import type { SessionID } from "../../src/session/schema"
import { MessageID, SessionID as SessionIDSchema } from "../../src/session/schema"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((session) => session.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((session) => session.remove(id)))
  },
}

const providerConfig = {
  model: "test/default-model",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "default-model": {
          id: "default-model",
          name: "Default Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
        "agent-model": {
          id: "agent-model",
          name: "Agent Model",
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
}

function effective(input: Record<string, unknown>) {
  return {
    systemPrompt: { mode: "default", hasAppend: false },
    settingSources: ["user", "project", "local"],
    tools: { allowed: [], disallowed: [] },
    agents: {},
    skills: [],
    commands: [],
    plugins: [],
    ...input,
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("runtime config routes", () => {
  test("get, patch, and clear session runtime config", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`
        const mcpScopesRoute = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config/mcp-scopes?directory=${encodeURIComponent(tmp.path)}`

        const initial = await app.request(route(session.id))
        expect(initial.status).toBe(200)
        expect(await initial.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: {},
          effective: effective({
            model: { providerID: "test", modelID: "default-model" },
          }),
        })

        const firstPatch = SessionRuntimeConfig.RuntimeConfig.parse({
          model: { providerID: "test", modelID: "model" },
          systemPrompt: { type: "preset", preset: "none", append: "Preset tail" },
          settingSources: [],
          maxTurns: 3,
          permissionMode: "dontAsk",
          canUseTool: true,
          autoPermissionClassifierModel: { providerID: "test", modelID: "classifier" },
          allowedTools: ["Read", "Bash(npm:*)", "MyServer_MyTool"],
          disallowedTools: ["Write"],
          outputFormat: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
            retryCount: 1,
          },
          hooks: { PreToolUse: [{ id: "pre-bash", matcher: "bash", timeoutMs: 1000 }] },
        })
        const patched = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(firstPatch),
        })
        expect(patched.status).toBe(200)
        expect(await patched.json()).toEqual(firstPatch)

        const afterPatch = await app.request(route(session.id))
        expect(afterPatch.status).toBe(200)
        expect(await afterPatch.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: firstPatch,
          effective: effective({
            model: { providerID: "test", modelID: "model" },
            systemPrompt: { mode: "preset", preset: "none", hasAppend: true },
            settingSources: [],
            maxTurns: 3,
            permissionMode: "dontAsk",
            canUseTool: { registered: true },
            autoPermissionClassifierModel: { providerID: "test", modelID: "classifier" },
            hooks: { PreToolUse: { count: 1 } },
            tools: { allowed: ["read", "bash(npm *)", "MyServer_MyTool"], disallowed: ["write"] },
          }),
        })

        const secondPatch = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appendSystemPrompt: "Be strict",
          }),
        })
        expect(secondPatch.status).toBe(200)
        expect(await secondPatch.json()).toEqual({
          ...firstPatch,
          appendSystemPrompt: "Be strict",
        })

        const afterSecondPatch = await app.request(route(session.id))
        expect(afterSecondPatch.status).toBe(200)
        expect(await afterSecondPatch.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: {
            ...firstPatch,
            appendSystemPrompt: "Be strict",
          },
          effective: effective({
            model: { providerID: "test", modelID: "model" },
            systemPrompt: { mode: "preset", preset: "none", hasAppend: true },
            appendSystemPrompt: { length: 9 },
            settingSources: [],
            maxTurns: 3,
            permissionMode: "dontAsk",
            canUseTool: { registered: true },
            autoPermissionClassifierModel: { providerID: "test", modelID: "classifier" },
            hooks: { PreToolUse: { count: 1 } },
            tools: { allowed: ["read", "bash(npm *)", "MyServer_MyTool"], disallowed: ["write"] },
          }),
        })

        const scopedMcpCleared = await app.request(mcpScopesRoute(session.id), {
          method: "DELETE",
        })
        expect(scopedMcpCleared.status).toBe(200)
        expect(await scopedMcpCleared.json()).toBe(true)

        const afterScopedMcpClear = await app.request(route(session.id))
        expect(afterScopedMcpClear.status).toBe(200)
        expect((await afterScopedMcpClear.json()).runtimeConfig).toEqual({
          ...firstPatch,
          appendSystemPrompt: "Be strict",
        })

        const cleared = await app.request(route(session.id), {
          method: "DELETE",
        })
        expect(cleared.status).toBe(200)
        expect(await cleared.json()).toBe(true)

        const afterClear = await app.request(route(session.id))
        expect(afterClear.status).toBe(200)
        expect(await afterClear.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: {},
          effective: effective({
            model: { providerID: "test", modelID: "default-model" },
          }),
        })

        await svc.remove(session.id)
      },
    })
  })

  test("effective view resolves agent model, runtime model, and maxTurns min", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...providerConfig,
        agent: {
          build: {
            model: "test/agent-model",
            steps: 2,
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        const initial = await app.request(route(session.id))
        expect(initial.status).toBe(200)
        expect(await initial.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: {},
          effective: effective({
            model: { providerID: "test", modelID: "agent-model" },
            maxTurns: 2,
          }),
        })

        const limited = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: 5 }),
        })
        expect(limited.status).toBe(200)

        const afterLimit = await app.request(route(session.id))
        expect(afterLimit.status).toBe(200)
        expect(await afterLimit.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: { maxTurns: 5 },
          effective: effective({
            model: { providerID: "test", modelID: "agent-model" },
            maxTurns: 2,
          }),
        })

        const runtimeModel = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: { providerID: "test", modelID: "default-model" } }),
        })
        expect(runtimeModel.status).toBe(200)

        const afterModel = await app.request(route(session.id))
        expect(afterModel.status).toBe(200)
        expect(await afterModel.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: {
            maxTurns: 5,
            model: { providerID: "test", modelID: "default-model" },
          },
          effective: effective({
            model: { providerID: "test", modelID: "default-model" },
            maxTurns: 2,
          }),
        })

        await svc.remove(session.id)
      },
    })
  })

  test("effective view falls back when the session agent no longer exists", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        await run(
          SessionNs.Service.use((svc) =>
            svc.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "removed-agent",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("agent-model") },
              time: { created: Date.now() },
            } satisfies MessageV2.User),
          ),
        )

        const patched = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: 4 }),
        })
        expect(patched.status).toBe(200)

        const response = await app.request(route(session.id))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          sessionID: session.id,
          runtimeConfig: { maxTurns: 4 },
          effective: effective({
            model: { providerID: "test", modelID: "agent-model" },
            maxTurns: 4,
          }),
        })

        await svc.remove(session.id)
      },
    })
  })

  test("validates runtime agents and exposes effective agent summary", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        const invalid = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agents: { reviewer: { description: "Missing prompt" } } }),
        })
        expect(invalid.status).toBe(400)

        const valid = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agents: {
              reviewer: {
                prompt: "Review only.",
                description: "Runtime reviewer",
                model: { providerID: "test", modelID: "agent-model" },
                tools: ["read", "grep"],
                disallowedTools: ["bash"],
                permissionMode: "dontAsk",
                steps: 2,
                spawnMode: "inherit",
                mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
              },
            },
          }),
        })
        expect(valid.status).toBe(200)

        const response = await app.request(route(session.id))
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.effective.agents).toEqual({
          reviewer: {
            description: "Runtime reviewer",
            spawnMode: "inherit",
            hasModel: true,
            toolCount: 2,
            disallowedToolCount: 1,
            mcpServerCount: 1,
            steps: 2,
          },
        })

        await svc.remove(session.id)
      },
    })
  })

  test("exposes phase 8 skill command and plugin summaries", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        const patched = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skills: [{ name: "runtime-skill", description: "Runtime skill", content: "Use runtime skill." }],
            commands: [{ name: "runtime-command", template: "Use command" }],
            plugins: [
              {
                type: "inline",
                name: "team",
                skills: [{ name: "triage", description: "Triage", content: "Triage issues." }],
                commands: [{ name: "ship", template: "Ship now" }],
                agents: { helper: { prompt: "Help." } },
                hooks: { PreToolUse: [{ id: "pre", matcher: "bash" }] },
                mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
              },
            ],
          }),
        })
        expect(patched.status).toBe(200)

        const response = await app.request(route(session.id))
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.effective.skills).toEqual([
          { name: "runtime-skill", source: "runtime" },
          { name: "team:triage", source: "plugin", pluginName: "team" },
        ])
        expect(body.effective.commands).toEqual([
          { name: "runtime-command", source: "runtime" },
          { name: "runtime-skill", source: "skill" },
          { name: "team:ship", source: "plugin", pluginName: "team" },
          { name: "team:triage", source: "skill", pluginName: "team" },
        ])
        expect(body.effective.plugins).toEqual([
          {
            name: "team",
            source: "inline",
            skillCount: 1,
            commandCount: 1,
            agentCount: 1,
            hookEventCount: 1,
            mcpServerCount: 1,
          },
        ])

        const commands = await app.request(`/session/${session.id}/command?directory=${encodeURIComponent(tmp.path)}`)
        expect(commands.status).toBe(200)
        expect((await commands.json()).map((command: { name: string }) => command.name)).toEqual(
          expect.arrayContaining(["runtime-command", "runtime-skill", "team:ship", "team:triage"]),
        )

        const skills = await app.request(`/session/${session.id}/skill?directory=${encodeURIComponent(tmp.path)}`)
        expect(skills.status).toBe(200)
        expect((await skills.json()).map((skill: { name: string }) => skill.name)).toEqual([
          "runtime-skill",
          "team:triage",
        ])

        await svc.remove(session.id)
      },
    })
  })

  test("rejects create-time invalid plugins before persisting the session", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const route = `/session?directory=${encodeURIComponent(tmp.path)}`

        const missingPlugin = await app.request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runtimeConfig: {
              plugins: [{ type: "claude", path: path.join(tmp.path, "missing-plugin") }],
            },
          }),
        })
        expect(missingPlugin.status).toBe(400)
        expect(await missingPlugin.text()).toContain("Claude plugin manifest not found")
        expect(await (await app.request(route)).json()).toEqual([])

        const firstPlugin = path.join(tmp.path, "first-create-plugin")
        const secondPlugin = path.join(tmp.path, "second-create-plugin")
        await fs.mkdir(path.join(firstPlugin, ".claude-plugin"), { recursive: true })
        await fs.mkdir(path.join(secondPlugin, ".claude-plugin"), { recursive: true })
        await Bun.write(path.join(firstPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dupe" }))
        await Bun.write(path.join(secondPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dupe" }))

        const duplicatePlugins = await app.request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runtimeConfig: {
              plugins: [
                { type: "claude", path: firstPlugin },
                { type: "claude", path: secondPlugin },
              ],
            },
          }),
        })
        expect(duplicatePlugins.status).toBe(400)
        expect(await duplicatePlugins.text()).toContain("Duplicate runtime plugin name")
        expect(await (await app.request(route)).json()).toEqual([])
      },
    })
  })

  test("validates negative runtime-config cases and strips unknown fields", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        const unknownField = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            maxTurns: 5,
            unknownField: "ignored",
          }),
        })
        expect(unknownField.status).toBe(200)
        expect(await unknownField.json()).toEqual({ maxTurns: 5 })

        const emptyArrayOverwrite = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            allowedTools: [],
          }),
        })
        expect(emptyArrayOverwrite.status).toBe(200)
        expect(await emptyArrayOverwrite.json()).toEqual({
          maxTurns: 5,
          allowedTools: [],
        })

        const malformedToolRule = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            allowedTools: ["Bash(npm:*"],
          }),
        })
        expect(malformedToolRule.status).toBe(400)

        const afterMalformedToolRule = await app.request(route(session.id))
        expect(afterMalformedToolRule.status).toBe(200)
        expect((await afterMalformedToolRule.json()).runtimeConfig).toEqual({
          maxTurns: 5,
          allowedTools: [],
        })

        const nullBody = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: null }),
        })
        expect(nullBody.status).toBe(400)

        const wrongType = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: "five" }),
        })
        expect(wrongType.status).toBe(400)

        for (const body of [
          { skills: [{ name: 42, description: "Bad", content: "Bad" }] },
          { skills: [{ name: "bad-disable", description: "Bad", content: "Bad", disableModelInvocation: "yes" }] },
          { commands: [{ name: "bad-subtask", template: "run", subtask: "yes" }] },
          { plugins: [{ type: "claude", path: 42 }] },
        ]) {
          const invalidPhase8 = await app.request(route(session.id), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
          expect(invalidPhase8.status).toBe(400)
        }

        const firstPlugin = path.join(tmp.path, "first-plugin")
        const secondPlugin = path.join(tmp.path, "second-plugin")
        await fs.mkdir(path.join(firstPlugin, ".claude-plugin"), { recursive: true })
        await fs.mkdir(path.join(secondPlugin, ".claude-plugin"), { recursive: true })
        await Bun.write(path.join(firstPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dupe" }))
        await Bun.write(path.join(secondPlugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dupe" }))

        const duplicateLoadedPluginName = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            plugins: [
              { type: "claude", path: firstPlugin },
              { type: "claude", path: secondPlugin },
            ],
          }),
        })
        expect(duplicateLoadedPluginName.status).toBe(400)

        const missingSessionID = SessionIDSchema.descending()
        const missing = await app.request(route(missingSessionID))
        expect(missing.status).toBe(404)

        const missingPatch = await app.request(route(missingSessionID), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: 5 }),
        })
        expect(missingPatch.status).toBe(404)

        const missingDelete = await app.request(route(missingSessionID), {
          method: "DELETE",
        })
        expect(missingDelete.status).toBe(404)

        await svc.remove(session.id)
      },
    })
  })

  test("rejects unknown systemPrompt preset without mutating accepted config", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app
        const route = (sessionID: SessionID) =>
          `/session/${sessionID}/runtime-config?directory=${encodeURIComponent(tmp.path)}`

        const accepted = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxTurns: 5 }),
        })
        expect(accepted.status).toBe(200)

        const invalid = await app.request(route(session.id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ systemPrompt: { type: "preset", preset: "future" } }),
        })
        expect(invalid.status).toBe(400)

        const after = await app.request(route(session.id))
        expect(after.status).toBe(200)
        expect((await after.json()).runtimeConfig).toEqual({ maxTurns: 5 })

        await svc.remove(session.id)
      },
    })
  })
})
