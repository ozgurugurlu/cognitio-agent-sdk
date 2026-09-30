import { describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { tmpdir } from "../fixture/fixture"

describe("session runtime config service", () => {
  test("fork inherits policy without retaining connection-owned callback descriptors", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(
          Session.Service.use((svc) =>
            svc.create({
              runtimeConfig: {
                maxTurns: 4,
                systemPrompt: "Remember the policy",
                compaction: { auto: false },
                hooks: { PreToolUse: [{ id: "original-client" }] },
                canUseTool: true,
                sdkMcpServers: [
                  { name: "direct", type: "sdk", transport: "direct", tools: [] },
                  {
                    name: "owned-http",
                    type: "remote",
                    url: "http://127.0.0.1:1234/mcp",
                    ownership: "sdk",
                    enabled: false,
                  },
                  { name: "external", type: "remote", url: "http://127.0.0.1:5678/mcp", enabled: false },
                ],
              },
            }),
          ),
        )
        const fork = await AppRuntime.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: session.id })))
        const inherited = await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(fork.id)))
        expect(inherited).toMatchObject({
          maxTurns: 4,
          systemPrompt: "Remember the policy",
          compaction: { auto: false },
        })
        expect(inherited.hooks).toBeUndefined()
        expect(inherited.canUseTool).toBeUndefined()
        expect(inherited.sdkMcpServers).toEqual([
          { name: "external", type: "remote", url: "http://127.0.0.1:5678/mcp", enabled: false },
        ])
        await AppRuntime.runPromise(
          SessionRuntimeConfig.Service.use((svc) => svc.set({ sessionID: fork.id, config: { maxTurns: 2 } })),
        )
        expect(
          (await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(session.id)))).maxTurns,
        ).toBe(4)
      },
    })
  })
  test("validates phase 8 runtime skills, commands, and plugins", () => {
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        skills: [
          {
            name: "docs",
            description: "Use docs",
            content: "Read docs first.",
            allowedTools: ["read"],
          },
        ],
        commands: [
          {
            name: "review",
            template: "Review $ARGUMENTS",
            allowedTools: ["read"],
            disallowedTools: ["bash"],
          },
        ],
        plugins: [
          {
            type: "inline",
            name: "team",
            skills: [{ name: "triage", description: "Triage", content: "Triage issues." }],
            commands: [{ name: "ship", template: "Ship it" }],
          },
          {
            type: "claude",
            path: "/tmp/plugin",
          },
        ],
      }).success,
    ).toBe(true)

    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        skills: [{ name: "x", description: "missing content", content: "" }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        commands: [{ name: "x", template: "" }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        skills: [{ name: "   ", description: "blank name", content: "content" }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        skills: [{ name: "blank-content", description: "blank content", content: "   " }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        commands: [{ name: "blank-template", template: "   " }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        agents: { "   ": { prompt: "blank agent name" } },
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        plugins: [{ type: "inline", name: "   " }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        plugins: [{ type: "claude", path: "   " }],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        skills: [
          { name: "x", description: "one", content: "one" },
          { name: "x", description: "two", content: "two" },
        ],
      }).success,
    ).toBe(false)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        plugins: [
          { type: "inline", name: "p" },
          { type: "inline", name: "p" },
        ],
      }).success,
    ).toBe(false)
  })

  test("validates runtime outputFormat retryCount", () => {
    const defaulted = SessionRuntimeConfig.RuntimeConfig.parse({
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    })
    expect(defaulted.outputFormat?.retryCount).toBe(2)

    const custom = SessionRuntimeConfig.RuntimeConfig.parse({
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
        retryCount: 0,
      },
    })
    expect(custom.outputFormat?.retryCount).toBe(0)

    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
          retryCount: -1,
        },
      }).success,
    ).toBe(false)
  })

  test("validates systemPrompt preset strictly", () => {
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        systemPrompt: { type: "preset", preset: "default" },
      }).success,
    ).toBe(true)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        systemPrompt: { type: "preset", preset: "none" },
      }).success,
    ).toBe(true)
    expect(
      SessionRuntimeConfig.RuntimeConfig.safeParse({
        systemPrompt: { type: "preset", preset: "future" },
      }).success,
    ).toBe(false)
  })

  test("merges shallowly, ignores undefined, and clears on session removal", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({})))
        expect(await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(session.id)))).toEqual({})

        const first = await AppRuntime.runPromise(
          SessionRuntimeConfig.Service.use((svc) =>
            svc.set({
              sessionID: session.id,
              config: {
                maxTurns: 3,
                model: { providerID: "test", modelID: "model-a" },
                allowedTools: ["read"],
              },
            }),
          ),
        )
        expect(first).toEqual({
          maxTurns: 3,
          model: { providerID: "test", modelID: "model-a" },
          allowedTools: ["read"],
        })

        const second = await AppRuntime.runPromise(
          SessionRuntimeConfig.Service.use((svc) =>
            svc.set({
              sessionID: session.id,
              config: {
                model: undefined,
                allowedTools: [],
                appendSystemPrompt: "be strict",
              },
            }),
          ),
        )
        expect(second).toEqual({
          maxTurns: 3,
          model: { providerID: "test", modelID: "model-a" },
          allowedTools: [],
          appendSystemPrompt: "be strict",
        })

        expect(
          await AppRuntime.runPromise(
            SessionRuntimeConfig.Service.use((svc) =>
              svc.set({
                sessionID: session.id,
                config: {
                  maxTurns: 4,
                  unknownField: "ignored",
                } as never,
              }),
            ),
          ),
        ).toEqual({
          maxTurns: 4,
          model: { providerID: "test", modelID: "model-a" },
          allowedTools: [],
          appendSystemPrompt: "be strict",
        })

        const invalid = await AppRuntime.runPromiseExit(
          SessionRuntimeConfig.Service.use((svc) =>
            svc.set({
              sessionID: session.id,
              config: {
                maxTurns: "four",
              } as never,
            }),
          ),
        )
        expect(invalid._tag).toBe("Failure")
        expect(await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(session.id)))).toEqual({
          maxTurns: 4,
          model: { providerID: "test", modelID: "model-a" },
          allowedTools: [],
          appendSystemPrompt: "be strict",
        })

        await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(session.id)))
        expect(await AppRuntime.runPromise(SessionRuntimeConfig.Service.use((svc) => svc.get(session.id)))).toEqual({})
      },
    })
  })
})
