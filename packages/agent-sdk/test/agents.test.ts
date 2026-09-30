import { describe, expect, test } from "bun:test"
import { Session } from "../src/session.js"
import { createSdkMcpServer, defineAgent, defineTool } from "../src/tools/index.js"
import { normalizeRuntimeConfig } from "../src/internal/runtime-config.js"

describe("cognitio-agent-sdk — Phase 5 agents", () => {
  test("defineAgent validates Phase 5 fields", () => {
    const agent = defineAgent({
      prompt: "Review only.",
      model: "anthropic/claude",
      tools: ["Read"],
      disallowedTools: ["Bash(npm:*)"],
      permissionMode: "dontAsk",
      steps: 2,
      spawnMode: "inherit",
      mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
    })

    expect(agent.spawnMode).toBe("inherit")
    expect(() => defineAgent({ prompt: "" })).toThrow(/prompt/)
    expect(() => defineAgent({ prompt: "x", model: "bad" })).toThrow(/provider\/model/)
    expect(() => defineAgent({ prompt: "x", steps: 0 })).toThrow(/positive integer/)
    expect(() => defineAgent({ prompt: "x", spawnMode: "fork" as never })).toThrow(/spawnMode/)
    expect(() =>
      defineAgent({
        prompt: "x",
        mcpServers: [{ name: "bad", type: "sdk", url: "https://example.com/mcp" } as never],
      }),
    ).toThrow(/remote/)
  })

  test("normalizeRuntimeConfig serializes runtime agents and direct SDK MCP descriptors", () => {
    const direct = createSdkMcpServer({
      name: "local",
      transport: "direct",
      timeout: 1_000,
      tools: [
        defineTool({
          name: "echo",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
          execute: () => "ok",
        }),
      ],
    })

    expect(
      normalizeRuntimeConfig({
        agents: {
          reviewer: {
            prompt: "Review only.",
            model: "anthropic/claude",
            tools: ["Read"],
            disallowedTools: ["Bash(npm:*)"],
            permissionMode: "dontAsk",
            steps: 2,
            spawnMode: "inherit",
            mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
          },
        },
        sdkMcpServers: [direct],
      }),
    ).toMatchObject({
      agents: {
        reviewer: {
          model: { providerID: "anthropic", modelID: "claude" },
          tools: ["read"],
          disallowedTools: ["bash(npm *)"],
          spawnMode: "inherit",
        },
      },
      sdkMcpServers: [
        {
          name: "local",
          type: "sdk",
          transport: "direct",
          timeout: 1_000,
          tools: [{ name: "echo" }],
        },
      ],
    })
  })

  test("normalizeRuntimeConfig maps outputFormat maxRetries to retryCount", () => {
    expect(
      normalizeRuntimeConfig({
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
          maxRetries: 1,
        },
      }),
    ).toEqual({
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        retryCount: 1,
      },
    })
  })

  test("Session.setAgents patches the full agents map", async () => {
    const patches: unknown[] = []
    const session = new Session({
      client: {
        session: {
          runtimeConfig: {
            patch: async (input: unknown) => {
              patches.push(input)
              return { data: {}, error: undefined }
            },
          },
        },
      } as never,
      session: { id: "ses_test", directory: "/tmp/test" } as never,
      directory: "/tmp/test",
      createOptions: undefined,
    })

    await session.setAgents({
      reviewer: defineAgent({ prompt: "Review only.", spawnMode: "fresh" }),
    })

    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      sessionID: "ses_test",
      runtimeConfig: {
        agents: {
          reviewer: {
            prompt: "Review only.",
            spawnMode: "fresh",
          },
        },
      },
    })
  })

  test("normalizeRuntimeConfig validates direct SDK MCP tools", () => {
    expect(() =>
      normalizeRuntimeConfig({
        sdkMcpServers: [
          {
            name: "local",
            transport: "direct",
            tools: [{ name: "", inputSchema: { type: "object" }, execute: () => "ok" }],
          },
        ],
      }),
    ).toThrow(/name/)

    expect(() =>
      normalizeRuntimeConfig({
        sdkMcpServers: [
          {
            name: "local",
            transport: "direct",
            tools: [{ name: "echo", inputSchema: { type: "object" }, execute: undefined as never }],
          },
        ],
      }),
    ).toThrow(/execute/)
  })

  test("Session.close clears direct SDK MCP descriptors from child sessions", async () => {
    const direct = createSdkMcpServer({
      name: "local",
      transport: "direct",
      tools: [
        defineTool({
          name: "echo",
          inputSchema: { type: "object", properties: {} },
          execute: () => "ok",
        }),
      ],
    })
    const configs = new Map<string, { sdkMcpServers?: unknown[] }>([
      [
        "ses_root",
        {
          sdkMcpServers: [
            { name: "local", type: "sdk", transport: "direct", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
            { name: "remote", type: "remote", url: "https://example.com/mcp" },
          ],
        },
      ],
      [
        "ses_child",
        {
          sdkMcpServers: [
            { name: "local", type: "sdk", transport: "direct", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
          ],
        },
      ],
    ])
    const patches: Array<{ sessionID: string; runtimeConfig: { sdkMcpServers?: unknown[] } }> = []
    const clears: string[] = []
    const session = new Session({
      client: {
        session: {
          runtimeConfig: {
            get: async (input: { sessionID: string }) => ({
              data: { runtimeConfig: configs.get(input.sessionID) ?? {} },
              error: undefined,
            }),
            patch: async (input: { sessionID: string; runtimeConfig: { sdkMcpServers?: unknown[] } }) => {
              patches.push(input)
              configs.set(input.sessionID, input.runtimeConfig)
              return { data: {}, error: undefined }
            },
            clearMcpScopes: async (input: { sessionID: string }) => {
              clears.push(input.sessionID)
              return { data: true, error: undefined }
            },
          },
          children: async (input: { sessionID: string }) => ({
            data: input.sessionID === "ses_root" ? [{ id: "ses_child" }] : [],
            error: undefined,
          }),
        },
      } as never,
      session: { id: "ses_root", directory: "/tmp/test" } as never,
      directory: "/tmp/test",
      runtimeConfig: { sdkMcpServers: [direct] },
      createOptions: undefined,
    })

    await session.close()

    expect(patches.map((patch) => patch.sessionID).sort()).toEqual(["ses_child", "ses_root"])
    expect(clears.sort()).toEqual(["ses_child", "ses_root"])
    expect(configs.get("ses_root")?.sdkMcpServers).toEqual([{ name: "remote", type: "remote", url: "https://example.com/mcp" }])
    expect(configs.get("ses_child")?.sdkMcpServers).toEqual([])
  })
})
