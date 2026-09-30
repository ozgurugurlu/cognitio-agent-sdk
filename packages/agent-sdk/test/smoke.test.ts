import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { connect } from "node:net"
import { z } from "zod"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  createAgentClient,
  claudeCompat,
  defineAgent,
  defineCommand,
  defineHook,
  definePlugin,
  defineSkill,
  defineTool,
  defineOutputFormat,
  createSdkMcpServer,
  PermissionDecision,
  NEUTRAL_BASE_PROMPT,
} from "../src/index.js"
import type { AgentMessage, OutputOf } from "../src/index.js"
import { LocalControlRegistry } from "../src/dispatcher/registry.js"
import { startSdkMcpServers, stopSdkMcpHosts } from "../src/tools/mcp-server.js"
import { normalizeToolRule, normalizeToolRules } from "../src/tools/permission-rules.js"
import { requestMessageID, sleep, startMockServer, timeout, waitFor, type MockCognitioServer } from "./mock-server.js"

function runtimeHookDescriptors(mock: MockCognitioServer, sessionId: string, event: string): unknown {
  const hooks = mock.runtimeConfigs.get(sessionId)?.hooks
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return
  return (hooks as Record<string, unknown>)[event]
}

describe("cognitio-agent-sdk — Phase 0 scaffold", () => {
  test("public exports are defined", () => {
    expect(typeof createAgentClient).toBe("function")
    expect(typeof defineTool).toBe("function")
    expect(typeof createSdkMcpServer).toBe("function")
    expect(typeof defineAgent).toBe("function")
    expect(typeof defineHook).toBe("function")
    expect(typeof defineSkill).toBe("function")
    expect(typeof defineCommand).toBe("function")
    expect(typeof definePlugin).toBe("function")
    expect(typeof defineOutputFormat).toBe("function")
    expect(typeof claudeCompat).toBe("function")
  })

  test("defineTool validates required fields and returns the definition", () => {
    const tool = defineTool({
      name: "echo",
      description: "echoes input",
      inputSchema: { type: "object" },
      execute: (input: unknown) => input,
    })
    expect(tool.name).toBe("echo")
    expect(typeof tool.execute).toBe("function")

    const jsonOnly = defineTool({
      name: "json-only",
      inputJsonSchema: { type: "object", properties: {} },
      execute: (input: unknown) => input,
    })
    expect(jsonOnly.inputJsonSchema).toEqual({ type: "object", properties: {} })

    expect(() => defineTool({ name: "", inputSchema: {}, execute: () => null } as never)).toThrow()
    expect(() => defineTool({ name: "x", inputSchema: {}, execute: undefined as unknown as () => void })).toThrow()
  })

  test("defineOutputFormat returns JSON Schema and preserves maxRetries", () => {
    const format = defineOutputFormat(z.object({ ok: z.boolean() }), { maxRetries: 3 })
    const output: OutputOf<typeof format> = { ok: true }

    expect(output.ok).toBe(true)
    expect(format.type).toBe("json_schema")
    expect(format.maxRetries).toBe(3)
    expect(format.schema).toMatchObject({
      type: "object",
      properties: { ok: { type: "boolean" } },
    })
    expect(() => defineOutputFormat({ type: "object" }, { maxRetries: -1 })).toThrow(/maxRetries/)
  })

  test("Phase 8 definition helpers validate skills commands and plugins", () => {
    const skill = defineSkill({
      name: "review",
      description: "Review changes",
      content: "Inspect the current diff.",
      model: "openai/gpt-5.2",
    })
    const command = defineCommand({
      name: "ship",
      description: "Ship the current work",
      template: "Ship $ARGUMENTS",
      allowedTools: ["Read", "Bash(git:*)"],
    })
    const plugin = definePlugin({
      name: "team",
      skills: [skill],
      commands: [command],
    })

    expect(plugin.type).toBe("inline")
    expect(plugin.skills?.[0]).toBe(skill)
    expect(plugin.commands?.[0]).toBe(command)
    expect(claudeCompat("/tmp/claude-plugin")).toEqual({ type: "claude", path: "/tmp/claude-plugin" })
    expect(() => defineSkill({ name: "empty", description: "", content: "x" })).toThrow(/description/)
    expect(() => defineSkill({ name: 42, description: "x", content: "x" } as never)).toThrow(/name/)
    expect(() =>
      defineSkill({ name: "bad-flag", description: "x", content: "x", disableModelInvocation: "yes" } as never),
    ).toThrow(/disableModelInvocation/)
    expect(() => defineCommand({ name: "empty", template: "" })).toThrow(/template/)
    expect(() => defineCommand({ name: "bad-subtask", template: "run", subtask: "yes" } as never)).toThrow(/subtask/)
    expect(() => definePlugin({ name: "", skills: [] })).toThrow(/name/)
    expect(() =>
      definePlugin({
        name: "bad-mcp",
        mcpServers: [
          createSdkMcpServer({
            name: "hosted",
            transport: "http",
            tools: [defineTool({ name: "ping", inputSchema: {}, execute: () => "pong" })],
          }),
        ],
      }),
    ).toThrow(/transport "direct"/)
    expect(() => claudeCompat(42 as never)).toThrow(/path/)
    expect(() => claudeCompat("")).toThrow(/path/)
  })

  test("createSdkMcpServer bundles tools and rejects resources/prompts for Phase 3A", () => {
    const server = createSdkMcpServer({
      name: "my-server",
      tools: [
        defineTool({
          name: "ping",
          inputSchema: {},
          execute: () => "pong",
        }),
      ],
      resources: [],
      prompts: [],
    })
    expect(server.name).toBe("my-server")
    expect(server.tools).toHaveLength(1)
    expect(server.tools[0]!.name).toBe("ping")
    expect(() =>
      createSdkMcpServer({
        name: "resources",
        tools: [],
        resources: [{ name: "docs" } as never],
      }),
    ).toThrow(/resources/)
    expect(() =>
      createSdkMcpServer({
        name: "prompts",
        tools: [],
        prompts: [{ name: "review" } as never],
      }),
    ).toThrow(/prompts/)
  })

  test("SDK tool-rule parser mirrors server normalization and rejects malformed rules", () => {
    expect(normalizeToolRule("Read")).toBe("read")
    expect(normalizeToolRule("Bash(npm:*)")).toBe("bash(npm *)")
    expect(normalizeToolRule("Tool()")).toBe("Tool")
    expect(normalizeToolRule("Tool(*)")).toBe("Tool")
    expect(normalizeToolRule("web_search")).toBe("web_search")
    expect(normalizeToolRule(String.raw`my\(tool\)(a\)b\\c)`)).toBe(String.raw`my\(tool\)(a\)b\\c)`)
    expect(normalizeToolRules([], "allowedTools")).toEqual([])
    expect(() => normalizeToolRule("Bash(npm:*")).toThrow(/missing closing parenthesis/)
    expect(() => normalizeToolRule("Bash)")).toThrow(/unmatched closing parenthesis/)
    expect(() => normalizeToolRules([42 as never], "allowedTools")).toThrow(/must be a string/)
  })

  test("a malformed request target is answered, not fatal", async () => {
    // `new URL(req.url, base)` throws on every one of these, and the throw was
    // synchronous inside the request listener — an uncaughtException in the
    // SDK consumer's own process. `GET //` is the cheapest: node delivers it as
    // `req.url === "//"`, which is a protocol-relative URL with an empty host.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    const materialized = await startSdkMcpServers(
      [
        createSdkMcpServer({
          name: "malformed",
          tools: [
            defineTool({ name: "ping", description: "ping", inputSchema: { type: "object" }, execute: () => "pong" }),
          ],
        }),
      ],
      { sessionId: "ses_malformed" },
    )
    try {
      const url = new URL(materialized.specs[0]!.url)
      for (const target of ["//", "http://", "http://[::1", "//mcp", "///"]) {
        const status = await new Promise<string>((resolve) => {
          const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`)
          })
          let buffer = ""
          socket.on("data", (chunk) => {
            buffer += chunk.toString()
            if (buffer.includes("\r\n")) {
              socket.destroy()
              resolve(buffer.split("\r\n")[0]!)
            }
          })
          socket.on("error", () => resolve("socket error"))
        })
        expect(status, `target ${target}`).toContain("HTTP/1.1")
      }
      // Still alive and still serving.
      const client = new McpClient({ name: "malformed-probe", version: "1.0.0" })
      await client.connect(new StreamableHTTPClientTransport(url))
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ping"])
      await client.close()
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
      await stopSdkMcpHosts(materialized.hosts)
    }
  }, 20000)

  test("a client that dies mid-request neither kills the host process nor wedges the server", async () => {
    // The SDK-hosted MCP server runs in the CONSUMER's process, so a rejected
    // request handler is not a failed tool call — it is their application
    // exiting. `Bun.serve` used to catch that for us; a node:http request
    // listener returns void and node never inspects it, so the handler's
    // rejection is caught explicitly in mcp-server.ts. This pins the invariant
    // from the outside: whichever layer absorbs it, a hostile client must not
    // be able to take the process down or leave the server unable to answer.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    const materialized = await startSdkMcpServers(
      [
        createSdkMcpServer({
          name: "disconnect",
          tools: [
            defineTool({ name: "ping", description: "ping", inputSchema: { type: "object" }, execute: () => "pong" }),
          ],
        }),
      ],
      { sessionId: "ses_disconnect" },
    )
    try {
      const url = new URL(materialized.specs[0]!.url)
      for (let i = 0; i < 5; i++) {
        // Send a POST header, then destroy the socket before the body lands.
        const socket = connect({ host: url.hostname, port: Number(url.port) })
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\ncontent-type: application/json\r\ncontent-length: 999\r\n\r\n{"jso`,
        )
        socket.destroy()
      }
      await sleep(150)
      // Still serving.
      const client = new McpClient({ name: "disconnect-probe", version: "1.0.0" })
      await client.connect(new StreamableHTTPClientTransport(url))
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ping"])
      await client.close()
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
      await stopSdkMcpHosts(materialized.hosts)
    }
  }, 20000)

  test("SDK-hosted MCP server lists tools and calls consumer functions", async () => {
    let seenSession: string | undefined
    const materialized = await startSdkMcpServers(
      [
        createSdkMcpServer({
          name: "local-tools",
          tools: [
            defineTool({
              name: "echo",
              description: "Echo a message",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
              execute: (input: { message: string }, ctx) => {
                seenSession = ctx.sessionId
                return `echo:${input.message}`
              },
              metadata: {
                searchHint: "Echoes messages for tests",
                alwaysLoad: true,
              },
              annotations: {
                readOnly: true,
              },
            }),
            defineTool({
              name: "void_result",
              description: "Returns no content",
              inputJsonSchema: { type: "object", anyOf: [{ type: "object", properties: {} }] },
              execute: () => undefined,
            }),
          ],
        }),
      ],
      { sessionId: "ses_test" },
    )
    const client = new McpClient({ name: "agent-sdk-test", version: "1.0.0" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(materialized.specs[0]!.url)))
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", "void_result"])
      expect(
        (listed.tools.find((tool) => tool.name === "echo") as { _meta?: Record<string, unknown> } | undefined)?._meta,
      ).toEqual({
        "cognitio/searchHint": "Echoes messages for tests",
        "cognitio/alwaysLoad": true,
      })
      expect(listed.tools.find((tool) => tool.name === "echo")?.annotations).toMatchObject({
        readOnlyHint: true,
      })
      expect(listed.tools.find((tool) => tool.name === "void_result")?.inputSchema).toEqual({
        type: "object",
        anyOf: [{ type: "object", properties: {} }],
      })

      const result = await client.callTool({ name: "echo", arguments: { message: "hi" } })
      expect(result.content).toEqual([{ type: "text", text: "echo:hi" }])
      const voidResult = await client.callTool({ name: "void_result", arguments: {} })
      expect(voidResult.content).toEqual([{ type: "text", text: "" }])
      expect(seenSession).toBe("ses_test")
    } finally {
      await client.close().catch(() => {})
      await stopSdkMcpHosts(materialized.hosts)
    }
  })

  test("startSdkMcpServers rejects resources/prompts for SDK-hosted MCP", async () => {
    await expect(
      startSdkMcpServers(
        [
          {
            name: "bad-resources",
            tools: [],
            resources: [{ name: "docs" } as never],
          } as never,
        ],
        { sessionId: "ses_test" },
      ),
    ).rejects.toThrow(/resources/)
    await expect(
      startSdkMcpServers(
        [
          {
            name: "bad-prompts",
            tools: [],
            prompts: [{ name: "review" } as never],
          } as never,
        ],
        { sessionId: "ses_test" },
      ),
    ).rejects.toThrow(/prompts/)
  })

  test("defineAgent requires a prompt", () => {
    const agent = defineAgent({ prompt: "You are helpful." })
    expect(agent.prompt).toBe("You are helpful.")
    expect(() => defineAgent({ prompt: "" })).toThrow()
  })

  test("defineHook: tool hook builds a PreToolUse entry", () => {
    const reg = defineHook("PreToolUse", /bash/, async () => ({ continue: true }))
    expect(reg.PreToolUse).toHaveLength(1)
    expect(reg.PreToolUse?.[0]).toMatchObject({ matcher: /bash/ })
  })

  test("defineHook: tool hook matcher is optional", () => {
    const reg = defineHook("PreToolUse", async () => ({ continue: true }))
    expect(reg.PreToolUse).toHaveLength(1)
    expect(reg.PreToolUse?.[0]).not.toHaveProperty("matcher")
  })

  test("defineHook: lifecycle hook registers a callback", () => {
    const reg = defineHook("SessionStart", async () => {})
    expect(reg.SessionStart).toHaveLength(1)
  })

  test("defineHook: shell hook accepts a matcher", () => {
    const reg = defineHook("BeforeShellExecution", /rm -rf/, async () => ({ continue: false }))
    expect(reg.BeforeShellExecution).toHaveLength(1)
    expect(reg.BeforeShellExecution?.[0]).toMatchObject({ matcher: /rm -rf/ })
  })

  test("defineHook: compaction hooks expose typed payload data", () => {
    const pre = defineHook("PreCompact", async (payload) => {
      const trigger: "auto" | "manual" = payload.data.trigger
      const count: number = payload.data.preCompactTokenCount
      const instructions: string | undefined = payload.data.customInstructions
      return { customInstructions: [trigger, count, instructions].filter(Boolean).join(":") }
    })
    const post = defineHook("PostCompact", async (payload) => {
      const result: "continue" | "stop" = payload.data.result
      const preserved: string[] | undefined = payload.data.preservedMessageIds
      return { additionalContext: `${result}:${preserved?.length ?? 0}` }
    })

    expect(pre.PreCompact).toHaveLength(1)
    expect(post.PostCompact).toHaveLength(1)
  })

  test("compact boundary system messages expose typed metadata", () => {
    const message: AgentMessage = {
      type: "system",
      subtype: "system.compact_boundary",
      compactionId: "msg_compact",
      preCompactTokenCount: 1,
      preservedMessageIds: [],
    }
    const id =
      message.type === "system" && message.subtype === "system.compact_boundary" ? message.compactionId : undefined

    expect(id).toBe("msg_compact")
  })

  test("createAgentClient(remote) builds a client without spawning", async () => {
    const client = await createAgentClient({ baseUrl: "http://127.0.0.1:65535" })
    expect(client.transportKind).toBe("remote")
    expect(client.baseUrl).toBe("http://127.0.0.1:65535")
    expect(typeof client.sessions.create).toBe("function")
    expect(typeof client.sessions.list).toBe("function")
    expect(typeof client.close).toBe("function")
    await client.close()
  })

  test("Session exposes Phase 7 session-management methods", async () => {
    const { Session } = await import("../src/session.js")
    const fakeSession = new Session({
      client: {} as never,
      session: { id: "sess-1", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
    })
    expect(typeof fakeSession.rename).toBe("function")
    expect(typeof fakeSession.tag).toBe("function")
    expect(typeof fakeSession.untag).toBe("function")
    expect(typeof fakeSession.checkpoint).toBe("function")
    expect(typeof fakeSession.listCheckpoints).toBe("function")
    expect(typeof fakeSession.rewind).toBe("function")
    expect(typeof fakeSession.getTodos).toBe("function")
    expect(typeof fakeSession.todos).toBe("function")
    expect(typeof fakeSession.messages).toBe("function")
  })

  test("Session.close clears server sdkMcpServers before stopping local hosts", async () => {
    const { Session } = await import("../src/session.js")
    const calls: string[] = []
    const patches: unknown[] = []
    const runtimeConfig = {
      sdkMcpServers: [
        {
          name: "remote-tools",
          type: "remote",
          url: "https://example.com/mcp",
          enabled: true,
          oauth: false,
        },
        {
          name: "local-tools",
          type: "remote",
          url: "http://127.0.0.1:1234/mcp",
          enabled: true,
          oauth: false,
        },
      ],
    }
    const fakeSession = new Session({
      client: {
        session: {
          runtimeConfig: {
            get: async () => ({
              data: { runtimeConfig, effective: { tools: { allowed: [], disallowed: [] } } },
              error: undefined,
            }),
            patch: async (input: unknown) => {
              calls.push("patch")
              patches.push(input)
              return { data: {}, error: undefined }
            },
            clearMcpScopes: async () => {
              calls.push("clearMcpScopes")
              return { data: true, error: undefined }
            },
          },
        },
      } as never,
      session: { id: "sess-1", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
      sdkMcpHosts: [
        {
          name: "local-tools",
          url: "http://127.0.0.1:1234/mcp",
          stop: async () => {
            calls.push("stop")
          },
        },
      ],
    })

    await fakeSession.close()

    expect(calls).toEqual(["patch", "clearMcpScopes", "stop"])
    expect((patches[0] as { runtimeConfig?: unknown }).runtimeConfig).toEqual({
      sdkMcpServers: [runtimeConfig.sdkMcpServers[0]],
    })
  })

  test("Session.close clears direct SDK MCP servers nested in inline plugins", async () => {
    const { Session } = await import("../src/session.js")
    const patches: unknown[] = []
    const clears: unknown[] = []
    const runtimeConfig = {
      sdkMcpServers: [
        {
          name: "remote-tools",
          type: "remote",
          url: "https://example.com/mcp",
          enabled: true,
          oauth: false,
        },
      ],
      plugins: [
        {
          type: "inline",
          name: "team",
          mcpServers: [
            {
              name: "local-tools",
              type: "sdk",
              transport: "direct",
              tools: [{ name: "echo", inputSchema: { type: "object" } }],
            },
            {
              name: "plugin-remote",
              type: "remote",
              url: "https://example.com/plugin-mcp",
              enabled: true,
              oauth: false,
            },
          ],
        },
      ],
    }
    const fakeSession = new Session({
      client: {
        session: {
          runtimeConfig: {
            get: async () => ({
              data: { runtimeConfig, effective: { tools: { allowed: [], disallowed: [] } } },
              error: undefined,
            }),
            patch: async (input: unknown) => {
              patches.push(input)
              return { data: {}, error: undefined }
            },
            clearMcpScopes: async (input: unknown) => {
              clears.push(input)
              return { data: true, error: undefined }
            },
          },
        },
      } as never,
      session: { id: "sess-1", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
      runtimeConfig: {
        plugins: [
          definePlugin({
            name: "team",
            mcpServers: [
              createSdkMcpServer({
                name: "local-tools",
                transport: "direct",
                tools: [
                  defineTool({
                    name: "echo",
                    inputJsonSchema: { type: "object" },
                    execute: () => "ok",
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    })

    await fakeSession.close()

    expect((patches[0] as { runtimeConfig?: unknown }).runtimeConfig).toEqual({
      sdkMcpServers: [runtimeConfig.sdkMcpServers[0]],
      plugins: [
        {
          type: "inline",
          name: "team",
          mcpServers: [runtimeConfig.plugins[0].mcpServers[1]],
        },
      ],
    })
    expect(clears).toEqual([{ sessionID: "sess-1", directory: "/tmp/fake", workspace: undefined }])
  })

  test("Session.close surfaces every server MCP cleanup failure after finishing later phases", async () => {
    const { Session } = await import("../src/session.js")
    const calls: string[] = []
    const fakeSession = new Session({
      client: {
        session: {
          runtimeConfig: {
            get: async () => ({
              data: {
                runtimeConfig: {
                  sdkMcpServers: [
                    {
                      name: "local-tools",
                      type: "remote",
                      url: "http://127.0.0.1:1234/mcp",
                      enabled: true,
                      oauth: false,
                    },
                  ],
                },
              },
              error: undefined,
            }),
            patch: async () => {
              calls.push("patch")
              throw new Error("patch cleanup failed")
            },
            clearMcpScopes: async () => {
              calls.push("scopes")
              throw new Error("scope cleanup failed")
            },
          },
          children: async () => {
            calls.push("children")
            throw new Error("child cleanup failed")
          },
        },
      } as never,
      session: { id: "sess-cleanup-errors", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
      sdkMcpHosts: [
        {
          name: "local-tools",
          url: "http://127.0.0.1:1234/mcp",
          stop: async () => {
            calls.push("stop")
          },
        },
      ],
      onClose: () => {
        calls.push("onClose")
      },
    })
    fakeSession.onClosed(() => {
      calls.push("listener")
    })

    const error = await fakeSession.close().then(
      () => undefined,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((failure: Error) => failure.message)).toEqual([
      "patch cleanup failed",
      "scope cleanup failed",
      "child cleanup failed",
    ])
    expect(calls).toEqual(["patch", "scopes", "children", "stop", "onClose", "listener"])
  })

  test("Session.close is memoized and always runs onClose after an earlier cleanup failure", async () => {
    const { Session } = await import("../src/session.js")
    let onCloseCalls = 0
    let closeListenerCalls = 0
    const fakeSession = new Session({
      client: {} as never,
      session: { id: "sess-close-memo", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
      onClose: () => {
        onCloseCalls++
      },
    })
    ;(
      fakeSession as unknown as {
        dispatcher: { stop(): Promise<void> }
      }
    ).dispatcher.stop = async () => {
      throw new Error("dispatcher stop failed")
    }
    fakeSession.onClosed(() => {
      closeListenerCalls++
    })

    const first = fakeSession.close()
    const second = fakeSession.close()
    expect(first).toBe(second)
    await expect(first).rejects.toThrow("dispatcher stop failed")
    await expect(second).rejects.toThrow("dispatcher stop failed")
    expect(onCloseCalls).toBe(1)
    expect(closeListenerCalls).toBe(1)
    fakeSession.onClosed(() => {
      closeListenerCalls++
    })
    expect(closeListenerCalls).toBe(2)
  })

  test("Session.close reports tracked server-abort failures without skipping observers", async () => {
    const { Session } = await import("../src/session.js")
    const calls: string[] = []
    const fakeSession = new Session({
      client: {
        session: {
          abort: async () => ({
            data: undefined,
            error: { message: "abort cleanup failed" },
          }),
        },
      } as never,
      session: { id: "sess-abort-error", directory: "/tmp/fake" } as never,
      directory: "/tmp/fake",
      createOptions: undefined,
      onClose: () => {
        calls.push("onClose")
      },
    })
    fakeSession.onClosed(() => {
      calls.push("listener")
    })
    ;(fakeSession as unknown as { trackServerAbort(): void }).trackServerAbort()

    await expect(fakeSession.close()).rejects.toThrow(/Failed to abort session: .*abort cleanup failed/)
    expect(calls).toEqual(["onClose", "listener"])
  })

  test("sessions.create rejects unsupported prompt-adjacent runtimeConfig before issuing a network request", async () => {
    const client = await createAgentClient({ baseUrl: "http://127.0.0.1:65535" })
    try {
      await expect(
        client.sessions.create({
          runtimeConfig: {
            effort: "invalid" as never,
          },
        }),
      ).rejects.toThrow(/effort/)
    } finally {
      await client.close()
    }
  })

  test("LocalControlRegistry intentionally bounds completed replay IDs", () => {
    const registry = new LocalControlRegistry(2)

    expect(registry.cancel("first")).toBe(false)
    expect(registry.add("first")).toBeUndefined()

    expect(registry.cancel("second")).toBe(false)
    expect(registry.cancel("third")).toBe(false)
    expect(registry.add("second")).toBeUndefined()
    expect(registry.add("third")).toBeUndefined()
    expect(registry.add("first")).toBeInstanceOf(AbortController)

    registry.stop()
  })
})

/**
 * Protocol-level smoke tests using a Bun.serve mock of the cognitio HTTP API.
 * The acceptance path (`create → send → stream → abort`) is exercised against
 * a controllable server so each Phase 0 must-fix has a deterministic proof:
 *
 *  - real-time streaming (events arrive before send() resolves)
 *  - per-session event filtering
 *  - per-session cwd propagation to subsequent calls
 *  - error surfacing from the low-level SDK's `{ error }` branch
 *  - SSE connection cleanup when the consumer exits early
 */

describe("cognitio-agent-sdk — protocol smoke (mock server)", () => {
  let mock: MockCognitioServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    if (!mock) return
    await mock.stop()
    mock = undefined as never
  })

  test("client.close runs every session cleanup before failing", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const a = await client.sessions.create({ title: "a" })
    const b = await client.sessions.create({ title: "b" })
    const closed: string[] = []
    // One sibling's cleanup is slow and fails; the other must still complete
    // (Promise.all would abandon it on the first rejection).
    ;(a as unknown as { close: () => Promise<void> }).close = async () => {
      await new Promise((r) => setTimeout(r, 30))
      closed.push("a")
      throw new Error("a boom")
    }
    ;(b as unknown as { close: () => Promise<void> }).close = async () => {
      await new Promise((r) => setTimeout(r, 5))
      closed.push("b")
    }
    await expect(client.close()).rejects.toThrow("a boom")
    expect(closed.sort()).toEqual(["a", "b"])
  })

  test("client.close aggregates multiple session-close failures", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const a = await client.sessions.create({ title: "a" })
    const b = await client.sessions.create({ title: "b" })
    ;(a as unknown as { close: () => Promise<void> }).close = async () => {
      throw new Error("a boom")
    }
    ;(b as unknown as { close: () => Promise<void> }).close = async () => {
      throw new Error("b boom")
    }
    const error = await client.close().then(
      () => undefined,
      (e) => e,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message).sort()).toEqual(["a boom", "b boom"])
  })

  test("sessions.create propagates cwd to Session.directory and subsequent send()", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-cwd" })
      expect(session.directory).toBe("/tmp/agent-sdk-cwd")

      const result = await session.send("hello")

      expect(result.subtype).toBe("success")
      expect(mock.capturedPromptAsync).toHaveLength(1)
      expect(mock.capturedPromptAsync[0]!.directory).toBe("/tmp/agent-sdk-cwd")
      expect(mock.capturedPromptAsync[0]!.sessionID).toBe(session.id)
    } finally {
      await client.close()
    }
  })

  test("Session.command posts slash commands and returns the matching result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-command" })
      mock.setCommandHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-command",
              partID: "text-command",
              field: "text",
              delta: "shipped",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-command",
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const result = await session.command("runtime-ship", "now", {
        agent: "builder",
        model: "openai/gpt-5.2",
        variant: "fast",
      })

      expect(result.subtype).toBe("success")
      expect(result.text).toBe("shipped")
      expect(mock.capturedPromptAsync).toHaveLength(0)
      expect(mock.capturedCommands).toHaveLength(1)
      expect(mock.capturedCommands[0]!.directory).toBe("/tmp/agent-sdk-command")
      expect(mock.capturedCommands[0]!.sessionID).toBe(session.id)
      expect(mock.capturedCommands[0]!.body).toMatchObject({
        command: "runtime-ship",
        arguments: "now",
        agent: "builder",
        model: "openai/gpt-5.2",
        variant: "fast",
      })
      expect(result.parentMessageId).toBe((mock.capturedCommands[0]!.body as { messageID?: string }).messageID)
    } finally {
      await client.close()
    }
  })

  test("Session.command skips stale idle between stale and current command results", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-command-stale-idle" })
      let messageID = ""

      mock.setCommandHandler((req) => {
        messageID = (req.body as { messageID?: string }).messageID ?? ""
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-stale",
              parentMessageID: "msg_stale",
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
        }, 5)
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 10)
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-current",
              parentMessageID: messageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 25)
        return new Response(null, { status: 204 })
      })

      const result = await Promise.race([session.command("runtime-ship", "now"), timeout(750)])
      expect(result).toMatchObject({
        subtype: "success",
        messageId: "assistant-current",
        parentMessageId: messageID,
      })
    } finally {
      await client.close()
    }
  })

  test("session list, continue, delete, rename, tag, untag, and fork use server routes", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-session-admin" })
      await session.rename("phase 7 root")
      await session.tag("phase7")
      await session.tag(" phase7 ")
      await session.tag("review")

      expect(mock.sessions.get(session.id)?.title).toBe("phase 7 root")
      expect(mock.sessions.get(session.id)?.tags).toEqual(["phase7", "review"])

      expect(
        (await client.sessions.list({ cwd: "/tmp/agent-sdk-session-admin", tag: "phase7" })).map((s) => s.id),
      ).toEqual([session.id])

      await session.untag("phase7")
      expect(mock.sessions.get(session.id)?.tags).toEqual(["review"])
      expect(await client.sessions.list({ cwd: "/tmp/agent-sdk-session-admin", tag: "phase7" })).toEqual([])

      const continued = await client.sessions.continue({ cwd: "/tmp/agent-sdk-session-admin" })
      expect(continued.id).toBe(session.id)

      const forked = await client.sessions.fork(session.id)
      expect(forked.directory).toBe(session.directory)
      expect(mock.sessions.get(forked.id)?.parentID).toBe(session.id)

      await client.sessions.delete(forked.id)
      expect(mock.sessions.has(forked.id)).toBe(false)
    } finally {
      await client.close()
    }
  })

  test("session checkpoint, listCheckpoints, and rewind round trip", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-checkpoint" })
      const checkpoint = await session.checkpoint("before edit")
      expect(checkpoint).toMatchObject({
        sessionId: session.id,
        label: "before edit",
        source: "manual",
      })

      expect(await session.listCheckpoints()).toEqual([checkpoint])
      await expect(session.rewind(checkpoint.id)).resolves.toEqual({
        checkpointId: checkpoint.id,
        affectedFiles: ["/tmp/agent-sdk-checkpoint/file.txt"],
      })
    } finally {
      await client.close()
    }
  })

  test("session todos yields initial snapshot and live same-session updates", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-todos" })
      mock.todos.set(session.id, [{ content: "read plan", status: "in_progress", priority: "high" }])

      await expect(session.getTodos()).resolves.toEqual([
        { content: "read plan", status: "in_progress", priority: "high" },
      ])

      const iterator = session.todos()
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: [{ content: "read plan", status: "in_progress" as const, priority: "high" as const }],
      })

      const updated = [{ content: "ship phase", status: "completed" as const, priority: "high" as const }]
      mock.todos.set(session.id, updated)
      mock.emit({ type: "todo.updated", properties: { sessionID: "other", todos: [] } })
      mock.emit({ type: "todo.updated", properties: { sessionID: session.id, todos: updated } })

      await expect(iterator.next()).resolves.toEqual({ done: false, value: updated })
      await iterator.return(undefined)
    } finally {
      await client.close()
    }
  })

  test("session todos does not duplicate a first same-session update before connected", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-todos-race" })
      const updated = [{ content: "race", status: "in_progress" as const, priority: "high" as const }]
      mock.skipNextConnected()
      const iterator = session.todos()
      const first = iterator.next()

      await waitFor(() => (mock.sseConnections() === 2 ? true : undefined))
      mock.todos.set(session.id, updated)
      mock.emit({ type: "todo.updated", properties: { sessionID: session.id, todos: updated } })

      await expect(first).resolves.toEqual({ done: false, value: updated })
      let duplicated = false
      const second = iterator.next().then((value) => {
        duplicated = true
        return value
      })
      await sleep(100)
      expect(duplicated).toBe(false)
      const next = [{ content: "next", status: "completed" as const, priority: "high" as const }]
      mock.todos.set(session.id, next)
      mock.emit({ type: "todo.updated", properties: { sessionID: session.id, todos: next } })
      await expect(second).resolves.toEqual({ done: false, value: next })
      await iterator.return(undefined)
    } finally {
      await client.close()
    }
  })

  test("session todos does not duplicate a first same-session update during initial snapshot", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-todos-connected-race" })
      const updated = [{ content: "connected race", status: "in_progress" as const, priority: "high" as const }]
      mock.setTodoDelay(50)
      const iterator = session.todos()
      const first = iterator.next()

      await waitFor(() => (mock.sseConnections() >= 1 ? true : undefined))
      mock.todos.set(session.id, updated)
      mock.emit({ type: "todo.updated", properties: { sessionID: session.id, todos: updated } })

      await expect(first).resolves.toEqual({ done: false, value: updated })
      let duplicated = false
      const second = iterator.next().then((value) => {
        duplicated = true
        return value
      })
      await sleep(100)
      expect(duplicated).toBe(false)
      const next = [{ content: "next connected", status: "completed" as const, priority: "high" as const }]
      mock.todos.set(session.id, next)
      mock.emit({ type: "todo.updated", properties: { sessionID: session.id, todos: next } })
      await expect(second).resolves.toEqual({ done: false, value: next })
      await iterator.return(undefined)
    } finally {
      mock.setTodoDelay(0)
      await client.close()
    }
  })

  test("Session.close ends every concurrent todos iterator cleanly", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-todos-close" })
      const iterators = [session.todos(), session.todos(), session.todos()]
      const first = await Promise.all(iterators.map((iterator) => iterator.next()))
      expect(first.every((item) => !item.done)).toBe(true)
      const pending = iterators.map((iterator) => iterator.next())

      await session.close()

      await expect(Promise.all(pending)).resolves.toEqual([
        { done: true, value: undefined },
        { done: true, value: undefined },
        { done: true, value: undefined },
      ])
      await waitFor(() => (mock.sseConnections() === 0 ? true : undefined))
    } finally {
      await client.close()
    }
  })

  test("session messages fetches active transcript and normalizes parts", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-messages" })
      mock.transcripts.set(session.id, [
        {
          info: { id: "msg_user", sessionID: session.id, role: "user", time: { created: 1 } },
          parts: [{ id: "prt_user", sessionID: session.id, messageID: "msg_user", type: "text", text: "hello" }],
        },
        {
          info: {
            id: "msg_assistant",
            sessionID: session.id,
            role: "assistant",
            parentID: "msg_user",
            time: { created: 2, completed: 3 },
          },
          parts: [
            { id: "prt_reason", sessionID: session.id, messageID: "msg_assistant", type: "reasoning", text: "think" },
            { id: "prt_text", sessionID: session.id, messageID: "msg_assistant", type: "text", text: "done" },
          ],
        },
      ])

      await expect(session.messages()).resolves.toMatchObject([
        { type: "user", parts: [{ text: "hello" }] },
        { type: "assistant", text: "done", reasoning: "think", parts: [{ text: "think" }, { text: "done" }] },
      ])
    } finally {
      await client.close()
    }
  })

  test("stream normalizes todo, checkpoint, and rewind events", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-event-normalize" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          const checkpoint = {
            id: "chk_stream",
            sessionID: req.sessionID,
            source: "auto",
            time: { created: 1, updated: 1 },
          }
          mock.emit({
            type: "todo.updated",
            properties: { sessionID: req.sessionID, todos: [{ content: "x", status: "pending", priority: "low" }] },
          })
          mock.emit({ type: "session.checkpoint.created", properties: { sessionID: req.sessionID, checkpoint } })
          mock.emit({
            type: "session.rewound",
            properties: { sessionID: req.sessionID, checkpointID: "chk_stream", affectedFiles: ["/tmp/x"] },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const message of session.stream("phase 7")) messages.push(message)

      expect(messages.find((message) => message.type === "todo.updated")).toMatchObject({
        sessionId: session.id,
        todos: [{ content: "x" }],
      })
      expect(messages.find((message) => message.type === "checkpoint.created")).toMatchObject({
        checkpoint: { id: "chk_stream", sessionId: session.id, source: "auto" },
      })
      expect(messages.find((message) => message.type === "session.rewound")).toMatchObject({
        checkpointId: "chk_stream",
        affectedFiles: ["/tmp/x"],
      })
    } finally {
      await client.close()
    }
  })

  test("stream normalizes rate limit and task lifecycle events with dedup", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-observability" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          const task = {
            sessionID: req.sessionID,
            activeSessionID: "ses_child",
            taskID: "call_1",
            messageID: "msg_task",
            partID: "prt_1",
            tool: "bash",
            agent: "build",
          }
          mock.emit({
            type: "session.rate_limit_hit",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: req.sessionID,
              provider: "anthropic",
              model: "claude-opus-4",
              attempt: 1,
              retryAfterSeconds: 1.5,
              message: "Too Many Requests",
            },
          })
          mock.emit({ type: "task.started", properties: task })
          mock.emit({ type: "task.started", properties: task })
          mock.emit({ type: "task.progress", properties: { ...task, title: "running tests", elapsedMs: 1200 } })
          mock.emit({ type: "task.notification", properties: { ...task, kind: "still_running", elapsedMs: 10000 } })
          mock.emit({
            type: "task.stopped",
            properties: { ...task, status: "completed", durationMs: 12000, title: "done" },
          })
          mock.emit({ type: "task.stopped", properties: { ...task, status: "completed", durationMs: 12000 } })
          mock.emit({ type: "task.progress", properties: { ...task, title: "late", elapsedMs: 13000 } })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const message of session.stream("phase 10")) messages.push(message)

      const rateLimit = messages.filter((message) => message.type === "rate_limit")
      expect(rateLimit).toHaveLength(1)
      expect(rateLimit[0]).toMatchObject({
        sessionId: session.id,
        activeSessionId: session.id,
        provider: "anthropic",
        model: "claude-opus-4",
        attempt: 1,
        retryAfterSeconds: 1.5,
        message: "Too Many Requests",
      })

      const started = messages.filter((message) => message.type === "task.started")
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({
        sessionId: session.id,
        activeSessionId: "ses_child",
        taskId: "call_1",
        messageId: "msg_task",
        partId: "prt_1",
        tool: "bash",
        agent: "build",
      })
      const progress = messages.filter((message) => message.type === "task.progress")
      expect(progress).toHaveLength(1)
      expect(progress[0]).toMatchObject({ taskId: "call_1", title: "running tests", elapsedMs: 1200 })
      expect(messages.find((message) => message.type === "task.notification")).toMatchObject({
        taskId: "call_1",
        kind: "still_running",
        elapsedMs: 10000,
      })
      const stopped = messages.filter((message) => message.type === "task.stopped")
      expect(stopped).toHaveLength(1)
      expect(stopped[0]).toMatchObject({ taskId: "call_1", status: "completed", durationMs: 12000, title: "done" })
    } finally {
      await client.close()
    }
  })

  test("session.usage accumulates live and reconciles with terminal results", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-usage" })
      expect(session.usage).toMatchObject({ turns: 0, totalCostUsd: 0 })
      expect(Object.keys(session.usage.modelUsage)).toHaveLength(0)

      const assistant = (id: string, parentID: string, over: Record<string, unknown>) => ({
        id,
        role: "assistant",
        sessionID: session.id,
        parentID,
        parentMessageID: parentID,
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-5.2",
        providerID: "openai",
        time: { created: Date.now() },
        ...over,
      })

      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          const turnID = requestMessageID(req.body) ?? "msg_turn"
          // In-flight update, then the completed overwrite for the same
          // message — fold must not double count.
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: assistant("as_1", turnID, {
                cost: 0.1,
                tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
              }),
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: assistant("as_1", turnID, {
                cost: 0.25,
                tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 7, write: 3 } },
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              }),
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: assistant("as_2", turnID, {
                cost: 0.5,
                tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "claude-opus-4",
                providerID: "anthropic",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              }),
            },
          })
          // Authoritative result includes a subagent child model the live
          // fold never saw.
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "as_2",
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 3,
              totalCostUsd: 1.0,
              usage: { input: 180, output: 39, reasoning: 5, cache: { read: 7, write: 3 } },
              modelUsage: {
                "openai/gpt-5.2": {
                  cost: 0.25,
                  tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 7, write: 3 } },
                },
                "anthropic/claude-opus-4": {
                  cost: 0.5,
                  tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                "anthropic/child-model": {
                  cost: 0.25,
                  tokens: { input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                },
              },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const liveSnapshots: { totalCostUsd: number; models: number }[] = []
      for await (const message of session.stream("usage")) {
        if (message.type === "assistant") {
          liveSnapshots.push({
            totalCostUsd: session.usage.totalCostUsd,
            models: Object.keys(session.usage.modelUsage).length,
          })
        }
      }

      // Live values grew during the stream without double counting the
      // repeated as_1 update.
      expect(liveSnapshots.length).toBeGreaterThanOrEqual(2)
      expect(liveSnapshots[0].totalCostUsd).toBeCloseTo(0.25)
      expect(liveSnapshots[liveSnapshots.length - 1].totalCostUsd).toBeCloseTo(0.75)
      expect(liveSnapshots[liveSnapshots.length - 1].models).toBe(2)

      // After the terminal result the accumulator equals the authoritative
      // totals (child session included) with no double counting.
      expect(session.usage.turns).toBe(3)
      expect(session.usage.totalCostUsd).toBeCloseTo(1.0)
      expect(session.usage.usage).toMatchObject({
        inputTokens: 180,
        outputTokens: 39,
        reasoningTokens: 5,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
      })
      expect(Object.keys(session.usage.modelUsage).sort()).toEqual([
        "anthropic/child-model",
        "anthropic/claude-opus-4",
        "openai/gpt-5.2",
      ])
      expect(session.usage.modelUsage["anthropic/child-model"].costUsd).toBeCloseTo(0.25)

      // A second turn keeps accumulating.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0.2,
              usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              modelUsage: {
                "openai/gpt-5.2": {
                  cost: 0.2,
                  tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                },
              },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      await session.send("again")

      expect(session.usage.turns).toBe(4)
      expect(session.usage.totalCostUsd).toBeCloseTo(1.2)
      expect(session.usage.usage.inputTokens).toBe(190)
      expect(session.usage.modelUsage["openai/gpt-5.2"].costUsd).toBeCloseTo(0.45)
    } finally {
      await client.close()
    }
  })

  test("session.usage folds manual compaction cost", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-usage",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "as_compact",
                role: "assistant",
                sessionID: req.sessionID,
                mode: "build",
                agent: "build",
                path: { cwd: "/", root: "/" },
                cost: 0.05,
                tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
                summary: true,
              },
            },
          })
          mock.emit({
            type: "system.compact_boundary",
            properties: {
              sessionID: req.sessionID,
              messageID: "as_compact",
              auto: false,
              overflow: false,
              trigger: "manual",
              preCompactTokenCount: 1,
              compactionId: "cmp_usage",
              preservedMessageIds: [],
            },
          })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      await session.compact()

      expect(session.usage.totalCostUsd).toBeCloseTo(0.05)
      // Summary assistants never count as turns.
      expect(session.usage.turns).toBe(0)
      expect(session.usage.usage.inputTokens).toBe(500)
      expect(session.usage.modelUsage["anthropic/claude-sonnet-4-5"].costUsd).toBeCloseTo(0.05)

      // A follow-up turn sweeps the compaction entry into the committed
      // aggregate (bounded live map) without losing or double counting it.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0.2,
              usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      await session.send("after compact")

      expect(session.usage.totalCostUsd).toBeCloseTo(0.25)
      expect(session.usage.turns).toBe(1)
      expect(session.usage.usage.inputTokens).toBe(510)
    } finally {
      await client.close()
    }
  })

  test("nested subagent observability spawned by a stale turn is suppressed", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-stale-child" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          // A stale result (different turn) marks msg_parent_spawn ignored.
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "msg_parent_spawn",
              parentMessageID: "msg_other_turn",
              subtype: "error_aborted",
            },
          })
          // The link: msg_parent_spawn spawned ses_stale_child.
          mock.emit({
            type: "subagent.started",
            properties: {
              sessionID: req.sessionID,
              parentSessionID: req.sessionID,
              childSessionID: "ses_stale_child",
              agent: "general",
              messageID: "msg_parent_spawn",
              taskID: "ses_stale_child",
              spawnMode: "fresh",
            },
          })
          // The grandchild's own spawning message is not directly ignored;
          // suppression must walk through its parent to msg_parent_spawn.
          mock.emit({
            type: "subagent.started",
            properties: {
              sessionID: req.sessionID,
              parentSessionID: "ses_stale_child",
              childSessionID: "ses_stale_grandchild",
              agent: "general",
              messageID: "msg_nested_spawn",
              taskID: "ses_stale_grandchild",
              spawnMode: "fresh",
            },
          })
          const base = {
            sessionID: req.sessionID,
            messageID: "msg_in_grandchild",
            partID: "prt_1",
            tool: "bash",
            agent: "general",
          }
          // Belongs to the stale grandchild -> suppressed.
          mock.emit({
            type: "task.started",
            properties: { ...base, activeSessionID: "ses_stale_grandchild", taskID: "call_stale" },
          })
          // A current-turn child with valid provenance still passes through.
          mock.emit({
            type: "subagent.started",
            properties: {
              sessionID: req.sessionID,
              parentSessionID: req.sessionID,
              childSessionID: "ses_live_child",
              agent: "general",
              messageID: requestMessageID(req.body) ?? "msg_current_turn",
              taskID: "ses_live_child",
              spawnMode: "fresh",
            },
          })
          mock.emit({
            type: "task.started",
            properties: { ...base, activeSessionID: "ses_live_child", taskID: "call_live" },
          })
          // Rate limits get the same treatment: stale child suppressed,
          // live child passes.
          mock.emit({
            type: "session.rate_limit_hit",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: "ses_stale_grandchild",
              provider: "anthropic",
              retryAfterSeconds: 2,
            },
          })
          mock.emit({
            type: "session.rate_limit_hit",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: "ses_live_child",
              provider: "anthropic",
              retryAfterSeconds: 3,
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const message of session.stream("stale child")) messages.push(message)

      expect(
        messages.some(
          (message) =>
            message.type === "subagent.start" &&
            (message.childSessionId === "ses_stale_child" || message.childSessionId === "ses_stale_grandchild"),
        ),
      ).toBe(false)
      const started = messages.filter((message) => message.type === "task.started")
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ taskId: "call_live", activeSessionId: "ses_live_child" })
      const rateLimits = messages.filter((message) => message.type === "rate_limit")
      expect(rateLimits).toHaveLength(1)
      expect(rateLimits[0]).toMatchObject({ activeSessionId: "ses_live_child", retryAfterSeconds: 3 })
    } finally {
      await client.close()
    }
  })

  test("task dedup keys are scoped per active session and block late starts", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-dedup-scope" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          const base = {
            sessionID: req.sessionID,
            messageID: "msg_dedup",
            partID: "prt_1",
            tool: "bash",
            agent: "build",
            taskID: "call_1",
          }
          // Terminal arrives first for child s1; the late start must be dropped.
          mock.emit({
            type: "task.stopped",
            properties: { ...base, activeSessionID: "ses_s1", status: "completed", durationMs: 10 },
          })
          mock.emit({ type: "task.started", properties: { ...base, activeSessionID: "ses_s1" } })
          // Same call ID from a DIFFERENT child session is a different task.
          mock.emit({ type: "task.started", properties: { ...base, activeSessionID: "ses_s2" } })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const message of session.stream("dedup scope")) messages.push(message)

      const stopped = messages.filter((message) => message.type === "task.stopped")
      expect(stopped).toHaveLength(1)
      const started = messages.filter((message) => message.type === "task.started")
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ taskId: "call_1", activeSessionId: "ses_s2" })
    } finally {
      await client.close()
    }
  })

  test("session.usage starts at zero on handles resumed from another client", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const other = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-resume-zero" })
      await session.send("hello")
      // Same-client resume returns the SAME handle (accumulator shared —
      // intended); a fresh client models a new process: zero baseline, no
      // transcript hydration.
      const same = await client.sessions.resume(session.id)
      expect(same).toBe(session)

      const resumed = await other.sessions.resume(session.id)
      expect(resumed.usage.turns).toBe(0)
      expect(resumed.usage.totalCostUsd).toBe(0)
      expect(Object.keys(resumed.usage.modelUsage)).toHaveLength(0)
    } finally {
      await client.close()
      await other.close()
    }
  })

  test("task events with reused call IDs across turns are not deduped", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-dedup-turns" })
      let turn = 0
      mock.setPromptAsyncHandler((req) => {
        turn += 1
        const partId = `prt_turn_${turn}`
        setTimeout(() => {
          const base = {
            sessionID: req.sessionID,
            activeSessionID: req.sessionID,
            taskID: "call_1",
            messageID: `msg_task_${turn}`,
            partID: partId,
            tool: "bash",
            agent: "build",
          }
          mock.emit({ type: "task.started", properties: base })
          mock.emit({ type: "task.stopped", properties: { ...base, status: "completed", durationMs: 5 } })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      async function* turns() {
        yield "turn one"
        yield "turn two"
      }
      const messages: AgentMessage[] = []
      for await (const message of session.stream(turns())) messages.push(message)

      // Sequential providers reuse call_1 every request; partID keeps the
      // turns apart, so both lifecycles surface.
      expect(messages.filter((message) => message.type === "task.started")).toHaveLength(2)
      expect(messages.filter((message) => message.type === "task.stopped")).toHaveLength(2)
    } finally {
      await client.close()
    }
  })

  test("session.usage stays bounded and correct across consecutive compacts and early breaks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-usage-bounded",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })

      // Two consecutive manual compactions, each with its own summary cost —
      // no reconcile in between; the compact teardown sweep must commit both.
      let compaction = 0
      mock.setSummarizeHandler((req) => {
        compaction += 1
        const id = `as_compact_${compaction}`
        setTimeout(() => {
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id,
                role: "assistant",
                sessionID: req.sessionID,
                mode: "build",
                agent: "build",
                path: { cwd: "/", root: "/" },
                cost: 0.05,
                tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
                summary: true,
              },
            },
          })
          mock.emit({
            type: "system.compact_boundary",
            properties: {
              sessionID: req.sessionID,
              messageID: id,
              auto: false,
              overflow: false,
              trigger: "manual",
              preCompactTokenCount: 1,
              compactionId: `cmp_${compaction}`,
              preservedMessageIds: [],
            },
          })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      // White-box boundedness probe: totals alone cannot distinguish a leak
      // (the getter sums live entries too), so assert the live map drains at
      // every checkpoint.
      const liveSize = () => (session as unknown as { usageLive: Map<string, unknown> }).usageLive.size

      await session.compact()
      await session.compact()
      expect(session.usage.totalCostUsd).toBeCloseTo(0.1)
      expect(session.usage.turns).toBe(0)
      expect(liveSize()).toBe(0)

      // Early break: an in-flight assistant folds cost, then the consumer
      // abandons the stream before any result. The teardown sweep commits the
      // abandoned entry — kept in totals, never double counted.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "as_broken",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: requestMessageID(req.body) ?? "msg_turn",
                parentMessageID: requestMessageID(req.body) ?? "msg_turn",
                mode: "build",
                agent: "build",
                path: { cwd: "/", root: "/" },
                cost: 0.1,
                tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                time: { created: Date.now() },
              },
            },
          })
          mock.emit({
            type: "task.started",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: req.sessionID,
              taskID: "call_break",
              messageID: "as_broken",
              partID: "prt_break",
              tool: "bash",
              agent: "build",
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })
      for await (const message of session.stream("will break")) {
        if (message.type === "task.started") break
      }
      expect(session.usage.totalCostUsd).toBeCloseTo(0.2)
      expect(session.usage.turns).toBe(0)
      expect(liveSize()).toBe(0)

      // A normal turn afterwards reconciles cleanly on top.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0.2,
              usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      await session.send("after everything")

      expect(session.usage.totalCostUsd).toBeCloseTo(0.4)
      expect(session.usage.usage.inputTokens).toBe(260)
      expect(session.usage.turns).toBe(1)
      expect(liveSize()).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("failed compact() does not leak a permanent live usage entry", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-fail",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      const liveSize = () => (session as unknown as { usageLive: Map<string, unknown> }).usageLive.size

      // The summary assistant is caught mid-flight (no finish), then the
      // summarize call itself fails: the folded entry must be committed via
      // the abandoned path, not stranded incomplete in the live map.
      mock.setSummarizeHandler(async (req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "as_failed_compact",
                role: "assistant",
                sessionID: req.sessionID,
                mode: "build",
                agent: "build",
                path: { cwd: "/", root: "/" },
                cost: 0.03,
                tokens: { input: 30, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                time: { created: Date.now() },
                summary: true,
              },
            },
          })
        }, 5)
        await new Promise((resolve) => setTimeout(resolve, 60))
        return Response.json({ error: "summary failed" }, { status: 500 })
      })

      await expect(session.compact()).rejects.toThrow()

      // Real spend is preserved (monotonic accounting), the map is drained,
      // and an incomplete summary never counts as a turn.
      expect(session.usage.totalCostUsd).toBeCloseTo(0.03)
      expect(session.usage.turns).toBe(0)
      expect(liveSize()).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("stale child suppression survives a missed subagent start between streams", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-cross-stream" })
      const baseline = mock.sseConnections()

      // Stream A queues subagent.started behind the parent task event. The
      // consumer breaks on that task, so the queued link is never normalized.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "task.started",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: req.sessionID,
              taskID: "call_parent",
              messageID: requestMessageID(req.body) ?? "msg_turn_a",
              partID: "prt_parent",
              tool: "task",
              agent: "general",
            },
          })
          mock.emit({
            type: "subagent.started",
            properties: {
              sessionID: req.sessionID,
              parentSessionID: req.sessionID,
              childSessionID: "ses_orphan_child",
              agent: "general",
              messageID: requestMessageID(req.body) ?? "msg_turn_a",
              taskID: "ses_orphan_child",
              spawnMode: "fresh",
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })
      for await (const message of session.stream("spawn and leave")) {
        if (message.type === "task.started") break
      }
      await waitFor(() => (mock.capturedAborts.length === 1 ? true : undefined))
      await waitFor(() => (mock.sseConnections() === baseline ? true : undefined))
      expect((session as unknown as { subagentParentLinks: Map<string, unknown> }).subagentParentLinks.size).toBe(0)

      // Stream B receives the old child's late activity without provenance,
      // then a properly linked child from the current turn.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          const stale = {
            sessionID: req.sessionID,
            activeSessionID: "ses_orphan_child",
            taskID: "call_late",
            messageID: "msg_in_orphan",
            partID: "prt_late",
            tool: "bash",
            agent: "general",
          }
          mock.emit({ type: "task.started", properties: stale })
          mock.emit({
            type: "session.rate_limit_hit",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: "ses_orphan_child",
              provider: "anthropic",
              retryAfterSeconds: 1,
            },
          })
          mock.emit({
            type: "subagent.started",
            properties: {
              sessionID: req.sessionID,
              parentSessionID: req.sessionID,
              childSessionID: "ses_live_child",
              agent: "general",
              messageID: requestMessageID(req.body) ?? "msg_turn_b",
              taskID: "ses_live_child",
              spawnMode: "fresh",
            },
          })
          mock.emit({
            type: "task.started",
            properties: {
              ...stale,
              activeSessionID: "ses_live_child",
              taskID: "call_live",
              messageID: "msg_in_live_child",
              partID: "prt_live",
            },
          })
          mock.emit({
            type: "session.rate_limit_hit",
            properties: {
              sessionID: req.sessionID,
              activeSessionID: "ses_live_child",
              provider: "live-provider",
              retryAfterSeconds: 2,
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      const messages: AgentMessage[] = []
      for await (const message of session.stream("fresh turn")) messages.push(message)

      expect(
        messages.some((message) => message.type === "task.started" && message.activeSessionId === "ses_orphan_child"),
      ).toBe(false)
      expect(
        messages.some((message) => message.type === "rate_limit" && message.activeSessionId === "ses_orphan_child"),
      ).toBe(false)
      expect(messages.filter((message) => message.type === "task.started")).toEqual([
        expect.objectContaining({ activeSessionId: "ses_live_child", taskId: "call_live" }),
      ])
      expect(messages.filter((message) => message.type === "rate_limit")).toEqual([
        expect.objectContaining({ activeSessionId: "ses_live_child", provider: "live-provider" }),
      ])
      expect(
        messages.some((message) => message.type === "subagent.start" && message.childSessionId === "ses_live_child"),
      ).toBe(true)
      expect(messages.filter((message) => message.type === "result")).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  test("usage folded before a failing prompt POST is committed, not leaked", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-post-error" })
      const liveSize = () => (session as unknown as { usageLive: Map<string, unknown> }).usageLive.size

      // The server streams a partial assistant (folded into usage), then the
      // prompt POST itself fails.
      mock.setPromptAsyncHandler(async (req) => {
        mock.emit({
          type: "message.updated",
          properties: {
            sessionID: req.sessionID,
            info: {
              id: "as_post_error",
              role: "assistant",
              sessionID: req.sessionID,
              parentID: requestMessageID(req.body) ?? "msg_turn",
              parentMessageID: requestMessageID(req.body) ?? "msg_turn",
              mode: "build",
              agent: "build",
              path: { cwd: "/", root: "/" },
              cost: 0.07,
              tokens: { input: 70, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "gpt-5.2",
              providerID: "openai",
              time: { created: Date.now() },
            },
          },
        })
        await new Promise((resolve) => setTimeout(resolve, 60))
        return Response.json({ error: "prompt failed" }, { status: 500 })
      })

      await expect(
        (async () => {
          for await (const message of session.stream("will fail")) void message
        })(),
      ).rejects.toThrow()

      // The abandoned partial spend is committed and the live map is drained.
      expect(session.usage.totalCostUsd).toBeCloseTo(0.07)
      expect(session.usage.turns).toBe(0)
      expect(liveSize()).toBe(0)

      // A later successful turn accumulates cleanly on top.
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0.2,
              usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      await session.send("recovers")
      expect(session.usage.totalCostUsd).toBeCloseTo(0.27)
      expect(liveSize()).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("send() serializes text, file, and image parts through prompt_async", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-parts" })

      await session.send({
        text: "inspect these",
        parts: [
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,aGVsbG8=",
          },
          {
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      })

      expect(mock.capturedPromptAsync).toHaveLength(1)
      const body = mock.capturedPromptAsync[0]!.body as { messageID?: string; parts?: unknown[] }
      expect(body.messageID).toMatch(/^msg_/)
      expect(body.parts).toEqual([
        { type: "text", text: "inspect these" },
        {
          type: "file",
          mime: "text/plain",
          filename: "note.txt",
          url: "data:text/plain;base64,aGVsbG8=",
        },
        {
          type: "file",
          mime: "image/png",
          filename: "image.png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ])
    } finally {
      await client.close()
    }
  })

  test("runtime config create-time payload, setModel, setPermissionMode, and getAppliedSettings round-trip runtime fields", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-runtime",
        runtimeConfig: {
          systemPrompt: { type: "preset", preset: "default", append: "Be precise." },
          appendSystemPrompt: "Use repo facts.",
          settingSources: ["project", "local"],
          model: "anthropic/claude-sonnet-4-5",
          maxTurns: 2,
          maxBudgetUsd: 0.5,
          permissionMode: "auto",
          autoPermissionClassifierModel: "anthropic/claude-haiku-4-5",
          canUseTool: async () => ({ behavior: "ask" }),
          hooks: defineHook("PreToolUse", /bash/, async () => ({ continue: true }), { timeoutMs: 1234 }),
          allowedTools: ["Read", "Bash(npm:*)", "MyServer_MyTool"],
          disallowedTools: ["Write"],
          enableToolSearch: "always",
          enableFileCheckpointing: true,
          skills: [
            defineSkill({
              name: "runtime-review",
              description: "Review runtime changes",
              content: "Review the active session state.",
              model: "openai/gpt-5.2",
              allowedTools: ["Read"],
            }),
          ],
          commands: [
            defineCommand({
              name: "runtime-ship",
              template: "Ship $ARGUMENTS",
              allowedTools: ["Bash(git:*)"],
            }),
          ],
          plugins: [
            definePlugin({
              name: "team",
              skills: [
                defineSkill({
                  name: "triage",
                  description: "Triage work",
                  content: "Triage the current issue.",
                }),
              ],
              commands: [defineCommand({ name: "handoff", template: "Prepare handoff" })],
              agents: { helper: defineAgent({ prompt: "Help with the current task." }) },
              hooks: defineHook("PreToolUse", /bash/, async () => ({ continue: true })),
              mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
            }),
          ],
        },
      })
      expect(mock.runtimeConfigs.get(session.id)).toEqual({
        systemPrompt: { type: "preset", preset: "default", append: "Be precise." },
        appendSystemPrompt: "Use repo facts.",
        settingSources: ["project", "local"],
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        maxTurns: 2,
        maxBudgetUsd: 0.5,
        permissionMode: "auto",
        autoPermissionClassifierModel: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        canUseTool: true,
        hooks: {
          PreToolUse: [{ id: "PreToolUse:0:bash:", matcher: "bash", matcherFlags: "", timeoutMs: 1234 }],
        },
        allowedTools: ["read", "bash(npm *)", "MyServer_MyTool"],
        disallowedTools: ["write"],
        enableToolSearch: true,
        enableFileCheckpointing: true,
        skills: [
          {
            name: "runtime-review",
            description: "Review runtime changes",
            content: "Review the active session state.",
            model: { providerID: "openai", modelID: "gpt-5.2" },
            allowedTools: ["read"],
          },
        ],
        commands: [{ name: "runtime-ship", template: "Ship $ARGUMENTS", allowedTools: ["bash(git *)"] }],
        plugins: [
          {
            type: "inline",
            name: "team",
            skills: [
              {
                name: "triage",
                description: "Triage work",
                content: "Triage the current issue.",
              },
            ],
            commands: [{ name: "handoff", template: "Prepare handoff" }],
            agents: { helper: { prompt: "Help with the current task." } },
            hooks: { PreToolUse: [{ id: "PreToolUse:0:bash:", matcher: "bash", matcherFlags: "" }] },
            mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
          },
        ],
      })
      expect(mock.capturedRuntimeConfigPatches).toHaveLength(0)

      await session.setModel("openai/gpt-5.2")
      await session.setPermissionMode("dontAsk")
      const settings = await session.getAppliedSettings()
      expect(settings).toMatchObject({
        sessionId: session.id,
        model: "openai/gpt-5.2",
        maxTurns: 2,
        maxBudgetUsd: 0.5,
        permissionMode: "dontAsk",
        systemPrompt: { mode: "preset", preset: "default", hasAppend: true },
        appendSystemPrompt: { length: 15 },
        settingSources: ["project", "local"],
        canUseTool: { registered: true },
        hookCounts: { PreToolUse: 2 },
        autoPermissionClassifierModel: "anthropic/claude-haiku-4-5",
        tools: { allowed: ["read", "bash(npm *)", "MyServer_MyTool"], disallowed: ["write"] },
        registeredHooks: ["PreToolUse"],
        agents: [],
        skills: [
          { name: "runtime-review", source: "runtime" },
          { name: "team:triage", source: "plugin", pluginName: "team" },
        ],
        commands: [
          { name: "runtime-ship", source: "runtime" },
          { name: "runtime-review", source: "skill" },
          { name: "team:handoff", source: "plugin", pluginName: "team" },
          { name: "team:triage", source: "skill", pluginName: "team" },
        ],
        plugins: [
          {
            name: "team",
            source: "inline",
            skillCount: 1,
            commandCount: 1,
            agentCount: 1,
            hookEventCount: 1,
            mcpServerCount: 1,
          },
        ],
      })
    } finally {
      await client.close()
    }
  })

  test("runtime outputFormat serializes maxRetries and is sent to prompt_async", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const format = defineOutputFormat(z.object({ ok: z.boolean() }), { maxRetries: 4 })
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-output-format",
        runtimeConfig: { outputFormat: format },
      })

      expect(mock.runtimeConfigs.get(session.id)?.outputFormat).toMatchObject({
        type: "json_schema",
        retryCount: 4,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      })

      await session.send("structured")
      expect((mock.capturedPromptAsync.at(-1)?.body as { format?: unknown }).format).toEqual(
        mock.runtimeConfigs.get(session.id)?.outputFormat,
      )
    } finally {
      await client.close()
    }
  })

  test("sessions.create applies non-SDK runtime config without runtime-config PATCH", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-runtime-create",
        runtimeConfig: {
          model: "openai/gpt-5.2",
        },
      })

      expect(mock.capturedRuntimeConfigPatches).toHaveLength(0)
      expect(mock.runtimeConfigs.get(session.id)).toEqual({
        model: { providerID: "openai", modelID: "gpt-5.2" },
        // Phase 12: sessions without an explicit systemPrompt/instructions get
        // the neutral base prompt injected at create time.
        systemPrompt: NEUTRAL_BASE_PROMPT,
        settingSources: [],
      })
    } finally {
      await client.close()
    }
  })

  test("neutral default injection matrix on create", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      // no config at all → neutral prompt injected
      const bare = await client.sessions.create()
      expect(mock.runtimeConfigs.get(bare.id)).toEqual({ settingSources: [], systemPrompt: NEUTRAL_BASE_PROMPT })

      // only append → append rides on top of the injected neutral base
      const appendOnly = await client.sessions.create({
        runtimeConfig: { appendSystemPrompt: "Tail." },
      })
      expect(mock.runtimeConfigs.get(appendOnly.id)).toEqual({
        systemPrompt: NEUTRAL_BASE_PROMPT,
        settingSources: [],
        appendSystemPrompt: "Tail.",
      })

      // explicit forms are preserved verbatim — no injection
      const explicitString = await client.sessions.create({
        runtimeConfig: { systemPrompt: "Mine." },
      })
      expect(mock.runtimeConfigs.get(explicitString.id)).toEqual({ settingSources: [], systemPrompt: "Mine." })

      const explicitCustom = await client.sessions.create({
        runtimeConfig: { systemPrompt: { type: "custom", prompt: "Custom mine." } },
      })
      expect(mock.runtimeConfigs.get(explicitCustom.id)).toEqual({ settingSources: [], systemPrompt: "Custom mine." })

      const explicitPreset = await client.sessions.create({
        runtimeConfig: { systemPrompt: { type: "preset", preset: "none" } },
      })
      expect(mock.runtimeConfigs.get(explicitPreset.id)).toEqual({
        systemPrompt: { type: "preset", preset: "none" },
        settingSources: [],
      })

      // explicit empty instructions = intentional empty base, not injection
      const emptyInstructions = await client.sessions.create({
        runtimeConfig: { instructions: "" },
      })
      expect(mock.runtimeConfigs.get(emptyInstructions.id)).toEqual({ settingSources: [], systemPrompt: "" })

      // V2 defaults disable ambient instruction discovery for every transport.
      for (const id of [bare.id, appendOnly.id, explicitString.id]) {
        expect(mock.runtimeConfigs.get(id)?.settingSources).toEqual([])
      }
    } finally {
      await client.close()
    }
  })

  test("instructions flatten to a plain systemPrompt and reject combination", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        runtimeConfig: { instructions: "Full custom prompt." },
      })
      expect(mock.runtimeConfigs.get(session.id)).toEqual({ settingSources: [], systemPrompt: "Full custom prompt." })

      await expect(
        client.sessions.create({
          runtimeConfig: { instructions: "One.", systemPrompt: "Two." },
        }),
      ).rejects.toThrow("runtimeConfig.instructions cannot be combined with runtimeConfig.systemPrompt")

      await expect(
        client.sessions.create({
          runtimeConfig: { instructions: 42 as unknown as string },
        }),
      ).rejects.toThrow("runtimeConfig.instructions must be a string")
    } finally {
      await client.close()
    }
  })

  test("unknown systemPrompt preset is rejected client-side", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      await expect(
        client.sessions.create({
          runtimeConfig: { systemPrompt: { type: "preset", preset: "future" as never } },
        }),
      ).rejects.toThrow('runtimeConfig.systemPrompt.preset must be "default" or "none"')
    } finally {
      await client.close()
    }
  })

  test("getAppliedSettings reports neutral/custom/preset modes, also after re-attach", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const neutral = await client.sessions.create()
      expect((await neutral.getAppliedSettings()).systemPrompt?.mode).toBe("neutral")

      const custom = await client.sessions.create({ runtimeConfig: { systemPrompt: "Mine." } })
      expect((await custom.getAppliedSettings()).systemPrompt?.mode).toBe("custom")

      const preset = await client.sessions.create({
        runtimeConfig: { systemPrompt: { type: "preset", preset: "default" } },
      })
      expect((await preset.getAppliedSettings()).systemPrompt?.mode).toBe("preset")

      // re-attached handles detect neutral via the stored config blob
      const reattached = await client.sessions.get(neutral.id)
      expect((await reattached.getAppliedSettings()).systemPrompt?.mode).toBe("neutral")
    } finally {
      await client.close()
    }
  })

  test("runtime config accepts custom system prompt forms and empty setting sources", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const stringPrompt = await client.sessions.create({
        cwd: "/tmp/agent-sdk-runtime-string-prompt",
        runtimeConfig: {
          systemPrompt: "Custom base.",
          settingSources: [],
        },
      })
      const objectPrompt = await client.sessions.create({
        cwd: "/tmp/agent-sdk-runtime-object-prompt",
        runtimeConfig: {
          systemPrompt: { type: "custom", prompt: "Object custom base." },
          settingSources: [],
        },
      })

      expect(mock.runtimeConfigs.get(stringPrompt.id)).toEqual({
        systemPrompt: "Custom base.",
        settingSources: [],
      })
      expect(mock.runtimeConfigs.get(objectPrompt.id)).toEqual({
        systemPrompt: "Object custom base.",
        settingSources: [],
      })
    } finally {
      await client.close()
    }
  })

  test("sessions.create accepts bare callback hook entries", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        runtimeConfig: {
          hooks: {
            SessionStart: [async () => {}],
          },
        },
      })

      expect(mock.runtimeConfigs.get(session.id)?.hooks).toEqual({
        SessionStart: [{ id: "SessionStart:0::" }],
      })
    } finally {
      await client.close()
    }
  })

  test("remote transport rejects local sdkMcpServers before creating a session", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      await expect(
        client.sessions.create({
          runtimeConfig: {
            sdkMcpServers: [
              createSdkMcpServer({
                name: "local-tools",
                tools: [
                  defineTool({
                    name: "echo",
                    inputSchema: { type: "object", properties: {} },
                    execute: () => "ok",
                  }),
                ],
              }),
            ],
          },
        }),
      ).rejects.toThrow(/local spawn transport/)
      expect(mock.sessions.size).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("remote transport passes through externally reachable MCP specs", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        runtimeConfig: {
          sdkMcpServers: [
            {
              name: "reachable-tools",
              type: "remote",
              url: "http://127.0.0.1:45678/mcp",
              enabled: true,
              oauth: false,
            },
          ],
        },
      })
      expect(mock.runtimeConfigs.get(session.id)?.sdkMcpServers).toEqual([
        {
          name: "reachable-tools",
          type: "remote",
          url: "http://127.0.0.1:45678/mcp",
          enabled: true,
          oauth: false,
        },
      ])
    } finally {
      await client.close()
    }
  })

  test("sessions.create rejects mixed and invalid runtimeConfig before network writes", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      await expect(
        client.sessions.create({
          runtimeConfig: {
            canUseTool: "deny" as never,
          },
        }),
      ).rejects.toThrow(/canUseTool/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            appendSystemPrompt: 42 as never,
          },
        }),
      ).rejects.toThrow(/appendSystemPrompt/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            settingSources: ["workspace" as never],
          },
        }),
      ).rejects.toThrow(/settingSources/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            systemPrompt: { type: "custom", prompt: 42 as never },
          },
        }),
      ).rejects.toThrow(/systemPrompt\.prompt/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            systemPrompt: { type: "preset", preset: "default", append: 42 as never },
          },
        }),
      ).rejects.toThrow(/systemPrompt\.append/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            checkpointing: { enabled: "yes" as never },
          },
        }),
      ).rejects.toThrow(/checkpointing/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            allowedTools: ["Bash(npm:*"],
          },
        }),
      ).rejects.toThrow(/missing closing parenthesis/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            commands: [{ name: "bad-model", template: "run", model: "openai/" }],
          },
        }),
      ).rejects.toThrow(/provider\/model format/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            skills: [{ name: 42, description: "Bad", content: "Bad" } as never],
          },
        }),
      ).rejects.toThrow(/runtimeConfig\.skills\.0\.name/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            skills: [
              { name: "bad-disable", description: "Bad", content: "Bad", disableModelInvocation: "yes" } as never,
            ],
          },
        }),
      ).rejects.toThrow(/disableModelInvocation/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            skills: [
              {
                name: "bad-model-object",
                description: "Bad",
                content: "Bad",
                model: { providerID: "", modelID: "model" },
              },
            ],
          },
        }),
      ).rejects.toThrow(/providerID/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            commands: [{ name: "bad-subtask", template: "run", subtask: "yes" } as never],
          },
        }),
      ).rejects.toThrow(/subtask/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            agents: { "   ": { prompt: "Bad" } },
          },
        }),
      ).rejects.toThrow(/runtimeConfig\.agents names/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            plugins: [{ type: "claude", path: 42 } as never],
          },
        }),
      ).rejects.toThrow(/runtimeConfig\.plugins\.0\.path/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            plugins: [
              {
                type: "inline",
                name: "bad-remote-plugin",
                mcpServers: [{ name: 42, type: "remote", url: "https://example.com/mcp" } as never],
              },
            ],
          },
        }),
      ).rejects.toThrow(/mcpServers\.0\.name/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            plugins: [
              {
                type: "inline",
                name: "bad-timeout-plugin",
                mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp", timeout: 0 }],
              },
            ],
          },
        }),
      ).rejects.toThrow(/timeout/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            plugins: [
              {
                type: "inline",
                name: "bad-direct-timeout-plugin",
                mcpServers: [
                  {
                    name: "direct",
                    type: "sdk",
                    transport: "direct",
                    timeout: 0,
                    tools: [defineTool({ name: "ping", inputSchema: {}, execute: () => "pong" })],
                  },
                ],
              },
            ],
          },
        }),
      ).rejects.toThrow(/timeout/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            sdkMcpServers: [{ name: "bad-url", type: "remote", url: "not-a-url" }],
          },
        }),
      ).rejects.toThrow(/valid URL/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            plugins: [
              {
                type: "inline",
                name: "bad-plugin",
                mcpServers: [
                  {
                    name: "hosted",
                    type: "sdk",
                    tools: [defineTool({ name: "ping", inputSchema: {}, execute: () => "pong" })],
                  },
                ],
              },
            ],
          },
        }),
      ).rejects.toThrow(/transport "direct"/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            enableToolSearch: "sometimes" as never,
          },
        }),
      ).rejects.toThrow(/enableToolSearch/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            enableFileCheckpointing: "yes" as never,
          },
        }),
      ).rejects.toThrow(/enableFileCheckpointing/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            outputFormat: { type: "json_schema", schema: { type: "object" }, maxRetries: -1 },
          },
        }),
      ).rejects.toThrow(/outputFormat\.maxRetries/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            outputFormat: { type: "json_schema", schema: null },
          },
        }),
      ).rejects.toThrow(/outputFormat\.schema/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            model: 42 as never,
          },
        }),
      ).rejects.toThrow(/provider\/model format/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            model: "openai/",
          },
        }),
      ).rejects.toThrow(/provider\/model format/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            maxTurns: 0,
          },
        }),
      ).rejects.toThrow(/positive integer/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            maxTurns: 1.5,
          },
        }),
      ).rejects.toThrow(/positive integer/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            maxBudgetUsd: -1,
          },
        }),
      ).rejects.toThrow(/positive number/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            maxBudgetUsd: Number.NaN,
          },
        }),
      ).rejects.toThrow(/positive number/)

      await expect(
        client.sessions.create({
          runtimeConfig: {
            maxBudgetUsd: Number.POSITIVE_INFINITY,
          },
        }),
      ).rejects.toThrow(/positive number/)

      expect(mock.sessions.size).toBe(0)
      expect(mock.runtimeConfigs.size).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("Session.compact posts manual summarize and returns compact boundary metadata", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })

      const result = await session.compact()

      expect(result).toEqual({
        compactionId: "msg_compact",
        preCompactTokenCount: 123,
        preservedMessageIds: ["msg_keep"],
      })
      expect(mock.capturedSummaries).toHaveLength(1)
      expect(mock.capturedSummaries[0]!.body).toMatchObject({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        auto: false,
      })
    } finally {
      await client.close()
    }
  })

  test("Session.compact accepts a model override", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-override",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })

      await session.compact({ model: "openai/gpt-5.2" })

      expect(mock.capturedSummaries[0]!.body).toMatchObject({
        providerID: "openai",
        modelID: "gpt-5.2",
        auto: false,
      })
    } finally {
      await client.close()
    }
  })

  test("Session.compact rejects servers without Phase 6 compact boundary fields", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-old-boundary",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "system.compact_boundary",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-compact",
              auto: false,
              overflow: false,
            },
          })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      await expect(session.compact()).rejects.toThrow(/Phase 6 compact boundary fields/)
    } finally {
      await client.close()
    }
  })

  test("Session.compact rejects same-session session.error before boundary", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-error",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.error",
            properties: {
              sessionID: req.sessionID,
              error: { data: { message: "summary failed" } },
            },
          })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      await expect(session.compact()).rejects.toThrow(/summary failed/)
    } finally {
      await client.close()
    }
  })

  test("Session.compact rejects successful runs that finish without compact boundary", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-no-boundary",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              subtype: "success",
              numTurns: 0,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      await expect(session.compact()).rejects.toThrow(/without compact boundary/)
    } finally {
      await client.close()
    }
  })

  test("Session.compact rejects summarize HTTP failures before boundary", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-http-error",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler(() => Response.json({ message: "compact rejected" }, { status: 400 }))

      await expect(Promise.race([session.compact(), timeout(750)])).rejects.toThrow(/Failed to compact session/)
    } finally {
      await client.close()
    }
  })

  // Compact teardown registers a server abort only when the summarize was POSTed
  // and the operation did not succeed. Both directions matter: aborting a
  // compaction the server already finished would throw away a paid-for summary,
  // and skipping the abort on an abandoned one leaves the server running.
  test("Session.compact issues no server abort once it reaches its compact boundary", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-no-abort",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })

      expect(await session.compact()).toMatchObject({ compactionId: "msg_compact" })
      expect(mock.capturedSummaries).toHaveLength(1)
      // The successful path leaves nothing pending, so nothing can land late.
      await sleep(50)
      expect(mock.capturedAborts).toEqual([])
    } finally {
      await client.close()
    }
  })

  test("Session.compact aborts the server when the summarize was posted but no boundary arrives", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-abort",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5" },
      })
      mock.setSummarizeHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              subtype: "success",
              numTurns: 0,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return Response.json(true, { status: 200 })
      })

      await expect(session.compact()).rejects.toThrow(/without compact boundary/)
      expect(mock.capturedSummaries).toHaveLength(1)
      const abort = await waitFor(() => mock.capturedAborts[0])
      expect(abort.sessionID).toBe(session.id)
      expect(mock.capturedAborts).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  test("Session.close aborts an abandoned compact after the summarize POST", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-compact-close",
        runtimeConfig: { model: "openai/gpt-5.2" },
      })
      mock.setSummarizeHandler(() => Response.json(true, { status: 200 }))
      const compacting = session.compact()
      const compactError = compacting.then(
        () => undefined,
        (error: unknown) => error,
      )
      await waitFor(() => (mock.capturedSummaries.length === 1 ? true : undefined))
      await sleep(20)

      await session.close()

      expect(await compactError).toMatchObject({
        message: expect.stringMatching(/was closed while a stream was in flight/),
      })
      expect(mock.capturedAborts).toHaveLength(1)
      expect(mock.capturedAborts[0]!.sessionID).toBe(session.id)
    } finally {
      await client.close()
    }
  })

  test("Session.close unwedges an in-flight command and waits for its abort request", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-command-close" })
      let abortResolved = false
      mock.setAbortHandler(async () => {
        await sleep(30)
        abortResolved = true
        return Response.json(true)
      })
      mock.setCommandHandler(() => new Response(null, { status: 204 }))
      const commanding = session.command("wait")
      const commandError = commanding.then(
        () => undefined,
        (error: unknown) => error,
      )
      await waitFor(() => (mock.capturedCommands.length === 1 ? true : undefined))
      await sleep(20)

      await session.close()

      expect(await commandError).toMatchObject({
        message: expect.stringMatching(/was closed while a stream was in flight/),
      })
      expect(abortResolved).toBe(true)
      expect(mock.capturedAborts).toHaveLength(1)
      expect(mock.capturedAborts[0]!.sessionID).toBe(session.id)
    } finally {
      mock.setAbortHandler(() => Response.json(true))
      await client.close()
    }
  })

  test("Session.close prevents a command POST after a delayed event subscription resolves", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-command-delayed-subscribe" })
      const internal = session as unknown as {
        ctx: {
          client: {
            event: {
              subscribe(...args: unknown[]): Promise<{ stream: AsyncIterable<unknown> }>
            }
          }
        }
      }
      const subscribe = internal.ctx.client.event.subscribe.bind(internal.ctx.client.event)
      let entered = false
      let resume = () => {}
      internal.ctx.client.event.subscribe = async (...args) => {
        entered = true
        await new Promise<void>((resolve) => {
          resume = resolve
        })
        return subscribe(...args)
      }

      const commanding = session.command("late")
      const commandError = commanding.then(
        () => undefined,
        (error: unknown) => error,
      )
      await waitFor(() => (entered ? true : undefined))
      const closing = session.close()
      resume()
      await closing

      expect(await commandError).toMatchObject({
        message: expect.stringMatching(/was closed while a stream was in flight/),
      })
      expect(mock.capturedCommands).toEqual([])
      expect(mock.capturedAborts).toEqual([])
    } finally {
      await client.close()
    }
  })

  test("Session.close prevents a prompt POST when an async input yields a late turn", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-prompt-late-turn" })
      let nextCalls = 0
      let resumeTurn = () => {}
      const prompt = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls++
              if (nextCalls === 1) return Promise.resolve({ done: false as const, value: "first" })
              return new Promise<IteratorResult<string>>((resolve) => {
                resumeTurn = () => resolve({ done: false, value: "late" })
              })
            },
            return() {
              return new Promise<IteratorResult<string>>(() => {})
            },
          }
        },
      }
      const iterator = session.stream(prompt)
      while (true) {
        const next = await iterator.next()
        if (next.done) throw new Error("stream ended before first result")
        if (next.value.type === "result") break
      }
      expect(mock.capturedPromptAsync).toHaveLength(1)

      const pending = iterator.next()
      const pendingError = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      await waitFor(() => (nextCalls === 2 ? true : undefined))
      await session.close()
      resumeTurn()

      expect(await pendingError).toMatchObject({
        message: expect.stringMatching(/was closed while a stream was in flight/),
      })
      expect(mock.capturedPromptAsync).toHaveLength(1)
      expect(mock.capturedAborts).toEqual([])
    } finally {
      await client.close()
    }
  })

  test("overlapping send and stream calls reject clearly", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-overlap" })
      // Acknowledge the request while keeping the turn open until both overlap
      // checks complete. This tests the query guard without a timer race.
      mock.setPromptAsyncHandler(() => new Response(null, { status: 204 }))

      const running = session.send("first")
      // Cleanup may reject this promise if an earlier assertion fails; the
      // explicit success assertion below still observes its actual outcome.
      running.catch(() => {})
      const request = await waitFor(() => mock.capturedPromptAsync[0])
      await expect(session.send("second")).rejects.toThrow(/active send\(\)\/stream\(\)/)
      await expect(session.stream("third").next()).rejects.toThrow(/active send\(\)\/stream\(\)/)
      expect(mock.capturedPromptAsync).toHaveLength(1)
      mock.emit({
        type: "session.result",
        properties: {
          sessionID: request.sessionID,
          parentMessageID: requestMessageID(request.body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
      mock.emit({ type: "session.idle", properties: { sessionID: request.sessionID } })
      await expect(running).resolves.toMatchObject({ subtype: "success" })
    } finally {
      await client.close()
    }
  })

  test("stream sends async iterable turns sequentially after each result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-async-turns" })
      let firstResultSeen = false
      let secondStartedAfterFirstResult = false
      mock.setPromptAsyncHandler((req) => {
        const turn = mock.capturedPromptAsync.length
        if (turn === 2) secondStartedAfterFirstResult = firstResultSeen
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: `assistant-${turn}`,
              partID: `text-${turn}`,
              field: "text",
              delta: `turn ${turn}`,
            },
          })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: `assistant-${turn}`,
              partID: `text-${turn}`,
              field: "text",
              delta: " text",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: `assistant-${turn}`,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: turn,
              totalCostUsd: 0,
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const results: number[] = []
      const texts: string[] = []
      const iterator = session.stream(
        (async function* () {
          yield "first"
          yield { text: "second" }
        })(),
      )
      let next = await iterator.next()
      while (!next.done) {
        const msg = next.value
        if (msg.type === "result") {
          results.push(msg.result.turns)
          texts.push(msg.text ?? "")
          if (msg.result.turns === 1) firstResultSeen = true
        }
        next = await iterator.next()
      }

      expect(results).toEqual([1, 2])
      expect(texts).toEqual(["turn 1 text", "turn 2 text"])
      // The generator's return value is the last turn's result, text included.
      expect(next.value).toMatchObject({ turns: 2, text: "turn 2 text" })
      expect(secondStartedAfterFirstResult).toBe(true)
      const bodies = mock.capturedPromptAsync.map((item) => item.body as { messageID?: string; parts?: unknown[] })
      expect(bodies.map((body) => body.parts)).toEqual([
        [{ type: "text", text: "first" }],
        [{ type: "text", text: "second" }],
      ])
      expect(bodies.every((body) => body.messageID?.startsWith("msg_"))).toBe(true)
    } finally {
      await client.close()
    }
  })

  test("stream fails the next turn fast when the event stream already reported done", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-reader-done" })
      mock.setPromptAsyncHandler((req) => {
        if (mock.capturedPromptAsync.length > 1) return new Response(null, { status: 204 })
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-done",
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          // No session.idle: the drain window is still parked on the reader when
          // the upstream iterator reports done, so the second turn's read has to
          // observe the remembered done instead of waiting forever.
          setTimeout(() => mock.closeSseConnections(), 10)
        }, 5)
        return new Response(null, { status: 204 })
      })

      const results: number[] = []
      const drained = (async () => {
        for await (const msg of session.stream(
          (async function* () {
            yield "first"
            yield "second"
          })(),
        )) {
          if (msg.type === "result") results.push(msg.result.turns)
        }
      })()

      // The regression this guards against is an *infinite* park, so the budget
      // only has to be finite. Keep it well clear of scheduler noise under a
      // loaded suite: a real hang still fails here with the timeout message,
      // which deliberately does not match the expected rejection.
      await expect(Promise.race([drained, timeout(10000)])).rejects.toThrow(/Event stream ended before session\.result/)
      expect(results).toEqual([1])
    } finally {
      await client.close()
    }
  })

  test("a remembered event-stream done answers both the post-result drain window and the next turn's read", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-reader-done-drain" })
      // The test drives every event itself, so the turn stays open until asked.
      mock.setPromptAsyncHandler(() => new Response(null, { status: 204 }))

      const stream = session.stream(
        (async function* () {
          yield "first"
          yield "second"
        })(),
      )

      // Park the generator on a yielded message. While it is suspended nothing
      // reads the EventReader, so `done` can be remembered before the
      // post-result drain window (which uses nextWithin) ever opens.
      const parking = stream.next()
      await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))
      mock.emit({
        type: "task.started",
        properties: {
          sessionID: session.id,
          activeSessionID: session.id,
          taskID: "call_reader_done",
          messageID: "assistant-reader-done-drain",
          partID: "prt_reader_done",
          tool: "bash",
          agent: "build",
        },
      })
      const parked = await Promise.race([parking, timeout(10000)])
      expect(parked.done).toBe(false)

      // Queue the terminal result and then end the subscription: readLoop stores
      // the result and latches done while the consumer is still suspended.
      mock.emit({
        type: "session.result",
        properties: {
          sessionID: session.id,
          messageID: "assistant-reader-done-drain",
          parentMessageID: requestMessageID(mock.capturedPromptAsync[0]!.body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
      mock.closeSseConnections()
      await waitFor(() => (mock.sseConnections() === 0 ? true : undefined))
      await sleep(50)

      // nextWithin() after done returns at once instead of parking a waiter that
      // readLoop has already stopped serving, so the result still gets delivered.
      let next = await Promise.race([stream.next(), timeout(10000)])
      while (!next.done && next.value.type !== "result") next = await Promise.race([stream.next(), timeout(10000)])
      expect(next).toMatchObject({ done: false, value: { type: "result", result: { subtype: "success" } } })

      // Turn 2's read then observes the same remembered done through next(),
      // failing fast rather than waiting for an event nobody will send.
      await expect(Promise.race([stream.next(), timeout(10000)])).rejects.toThrow(
        /Event stream ended before session\.result/,
      )
    } finally {
      await client.close()
    }
  })

  test("sessions.get resolves a session by ID even when the client default cwd differs", async () => {
    mock.sessions.set("sess-existing", {
      id: "sess-existing",
      directory: "/tmp/agent-sdk-existing",
      title: "existing",
      tags: [],
    })

    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      directory: "/tmp/agent-sdk-default",
    })
    try {
      const session = await client.sessions.get("sess-existing")
      expect(session.id).toBe("sess-existing")
      expect(session.directory).toBe("/tmp/agent-sdk-existing")
    } finally {
      await client.close()
    }
  })

  test("sessions.get and resume reuse one live handle until close unregisters it", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-owned" })
      const sameFromGet = await client.sessions.get(session.id)
      const sameFromResume = await client.sessions.resume(session.id)

      expect(sameFromGet).toBe(session)
      expect(sameFromResume).toBe(session)
      expect(mock.sseConnections()).toBe(1)

      await session.close()

      const reloaded = await client.sessions.get(session.id)
      expect(reloaded).not.toBe(session)
      expect(reloaded.id).toBe(session.id)
      await reloaded.close()
    } finally {
      await client.close()
    }
  })

  test("closed sessions guard exactly the 14 work-starting methods while reads and abort remain available", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-closed-guards",
        runtimeConfig: { model: "openai/gpt-5.2" },
      })
      await session.close()
      const guarded = [
        () => session.startDispatcher(),
        () => session.send("closed"),
        () => session.stream("closed").next(),
        () => session.command("closed"),
        () => session.compact(),
        () => session.todos().next(),
        () => session.checkpoint(),
        () => session.rewind("chk"),
        () => session.rename("closed"),
        () => session.tag("closed"),
        () => session.untag("closed"),
        () => session.setModel("openai/gpt-5.2"),
        () => session.setAgents({}),
        () => session.setPermissionMode("default"),
      ]

      expect(guarded).toHaveLength(14)
      await Promise.all(
        guarded.map(async (run) => {
          await expect(run()).rejects.toThrow(/Session .* is closed .*sessions\.resume/)
        }),
      )

      expect(session.usage.turns).toBe(0)
      await expect(session.messages()).resolves.toEqual([])
      await expect(session.getTodos()).resolves.toEqual([])
      await expect(session.listCheckpoints()).resolves.toEqual([])
      await expect(session.getAppliedSettings()).resolves.toMatchObject({ sessionId: session.id })
      await session.abort()
      await session.interrupt()
      expect(mock.capturedAborts.map((item) => item.sessionID)).toEqual([session.id, session.id])
    } finally {
      await client.close()
    }
  })

  test("sessions.fork reuses the source session cwd", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      directory: "/tmp/agent-sdk-client-default",
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-source" })
      const forked = await client.sessions.fork(session.id)
      expect(forked.directory).toBe("/tmp/agent-sdk-source")
      expect(mock.capturedForks).toHaveLength(1)
      expect(mock.capturedForks[0]!.directory).toBe("/tmp/agent-sdk-source")
    } finally {
      await client.close()
    }
  })

  test("Session.stream yields partials in real time and terminates on session.result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-rt" })
      let messageResolved = false

      mock.setPromptAsyncHandler(async (req) => {
        // Emit two events while the /prompt_async request is still pending.
        mock.emit({
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: "m-1",
            partID: "p-1",
            field: "text",
            delta: "hello",
          },
        })
        await sleep(40)
        mock.emit({
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: "m-1",
            partID: "p-1",
            field: "text",
            delta: " world",
          },
        })
        await sleep(40)
        mock.emit({
          type: "session.result",
          properties: {
            sessionID: session.id,
            parentMessageID: requestMessageID(req.body),
            subtype: "success",
            numTurns: 1,
            totalCostUsd: 0,
          },
        })
        mock.emit({ type: "session.idle", properties: { sessionID: session.id } })
        // Resolve /prompt_async only after the idle marker has been emitted.
        await sleep(20)
        messageResolved = true
        return new Response(null, { status: 204 })
      })

      const events: Array<{ observedBeforeMessageResolved: boolean; type: string }> = []
      for await (const msg of session.stream("prompt", { includePartialMessages: true })) {
        events.push({ observedBeforeMessageResolved: !messageResolved, type: msg.type })
      }

      // At least one delta event must have been observed before /prompt_async
      // resolved — that's the real-time guarantee for must-fix #1.
      const realTimeDelta = events.find((e) => e.type === "partial" && e.observedBeforeMessageResolved)
      expect(realTimeDelta).toBeDefined()

      // Stream must terminate on session.result (Phase 2 terminal result).
      const lastEvent = events[events.length - 1]!
      expect(lastEvent.type).toBe("result")
    } finally {
      await client.close()
    }
  })

  test("Session.stream subscribes before prompt_async so synchronous terminal events are observed", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-sync-result" })
      mock.setPromptAsyncHandler((req) => {
        mock.emit({
          type: "session.result",
          properties: {
            sessionID: req.sessionID,
            parentMessageID: requestMessageID(req.body),
            subtype: "success",
            numTurns: 1,
            totalCostUsd: 0,
          },
        })
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("sync result"), timeout(250)])).resolves.toMatchObject({
        subtype: "success",
      })
    } finally {
      await client.close()
    }
  })

  test("single-turn result delivery releases SSE and the active guard before the consumer asks again", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-result-release" })
      await waitFor(() => (mock.sseConnections() === 1 ? true : undefined))
      const baselineConnections = mock.sseConnections()
      const baselineAborts = mock.sseAborts()
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const iterator = session.stream("first")
      const terminal = await (async () => {
        while (true) {
          const next = await iterator.next()
          if (next.done) throw new Error("stream ended before result")
          if (next.value.type === "result") return next.value
        }
      })()

      // Measured from the consumer's stopping point: it holds its result and
      // will never touch the iterator again.
      const startedAt = Date.now()

      expect(terminal.result.subtype).toBe("success")
      // The result event carries no messageID, so there is nothing to look up.
      expect(terminal.result.text).toBeUndefined()
      expect(terminal.text).toBeUndefined()
      // WP2 headline bound. What makes this finite at all is that the release
      // rides along with delivering the result instead of waiting on a next() or
      // return() that never comes — drop that and the SSE stays open for the
      // life of the handle, so the wait below fails at any deadline. That, not
      // the size of the number, is the detector.
      //
      // The number is therefore deliberately generous: ~12 ms is what this
      // actually takes, but the closing gate is `bun turbo test:ci`, which runs
      // every package's suite in parallel, and a 100 ms race lost there once.
      // A flaky gate costs more than a loose bound buys.
      await waitFor(() => (mock.sseConnections() === baselineConnections ? true : undefined), 200)
      expect(Date.now() - startedAt).toBeLessThan(2000)
      expect(mock.sseAborts()).toBeGreaterThan(baselineAborts)
      await expect(session.send("second")).resolves.toMatchObject({ subtype: "success" })
      // Deliberately do not call iterator.next() or iterator.return(): receiving
      // the single-turn result is itself the resource-release boundary.
    } finally {
      await client.close()
    }
  })

  test("Session.stream rejects when own session.idle arrives before session.result and releases the active guard", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-missing-result" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(session.send("missing result")).rejects.toThrow(/idle before session\.result/)

      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(session.send("after failure")).resolves.toMatchObject({ subtype: "success" })
    } finally {
      await client.close()
    }
  })

  test("Session.stream rejects on same-session session.error without session.result and releases the active guard", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-session-error" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.error",
            properties: {
              sessionID: req.sessionID,
              error: {
                name: "UnknownError",
                data: { message: "model exploded" },
              },
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("boom"), timeout(750)])).rejects.toThrow(/model exploded/)

      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(session.send("after error")).resolves.toMatchObject({ subtype: "success" })
    } finally {
      await client.close()
    }
  })

  test("Session.stream does not suppress missing-result idle from the next run", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-stale-idle" })
      await expect(session.send("first")).resolves.toMatchObject({ subtype: "success" })

      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("missing result"), timeout(250)])).rejects.toThrow(
        /idle before session\.result/,
      )
    } finally {
      await client.close()
    }
  })

  test("Session.stream does not suppress missing-result idle from a later async iterable turn", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-async-turn-idle" })
      mock.setPromptAsyncHandler((req) => {
        const turn = mock.capturedPromptAsync.length
        setTimeout(() => {
          if (turn === 1) {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                parentMessageID: requestMessageID(req.body),
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
            return
          }
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(
        Promise.race([
          session.send(
            (async function* () {
              yield "first"
              yield "second"
            })(),
          ),
          timeout(750),
        ]),
      ).rejects.toThrow(/idle before session\.result/)
    } finally {
      await client.close()
    }
  })

  test("Session.stream normalizes reasoning, tools, compact boundary, raw events, and result payload", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-normalize" })
      let promptMessageID = ""
      mock.setPromptAsyncHandler((req) => {
        promptMessageID = (req.body as { messageID?: string }).messageID ?? ""
        setTimeout(() => {
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "text-1",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "text",
                text: "hello",
              },
            },
          })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "text-2",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "text",
                text: " world",
              },
            },
          })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-1",
              partID: "text-1",
              field: "text",
              delta: "!",
            },
          })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "reason-1",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "reasoning",
                text: "thinking",
                time: { start: Date.now() },
              },
            },
          })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-1",
              partID: "reason-1",
              field: "text",
              delta: " more",
            },
          })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "tool-1",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "tool",
                tool: "bash",
                callID: "call-1",
                state: {
                  status: "pending",
                  raw: "{}",
                  input: {},
                },
              },
            },
          })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "tool-1",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "tool",
                tool: "bash",
                callID: "call-1",
                state: {
                  status: "running",
                  time: { start: Date.now() },
                  input: { command: "echo hi" },
                },
              },
            },
          })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "tool-1",
                messageID: "assistant-1",
                sessionID: req.sessionID,
                type: "tool",
                tool: "bash",
                callID: "call-1",
                state: {
                  status: "completed",
                  time: { start: Date.now(), end: Date.now() },
                  input: { command: "echo hi" },
                  output: "hi",
                },
              },
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "msg_compaction_user",
                role: "user",
                sessionID: req.sessionID,
                parentMessageID: "assistant-1",
                agent: "build",
                model: { providerID: "openai", modelID: "gpt-5.2" },
                time: { created: Date.now() },
              },
            },
          })
          mock.emit({
            type: "system.compact_boundary",
            properties: {
              sessionID: req.sessionID,
              messageID: "msg_compaction_user",
              auto: true,
              overflow: false,
              trigger: "auto",
              preCompactTokenCount: 42,
              compactionId: "msg_compact_stream",
              preservedMessageIds: ["msg_keep_stream"],
            },
          })
          mock.emit({
            type: "control.request",
            properties: {
              id: crypto.randomUUID(),
              sessionID: req.sessionID,
              subtype: "hook_callback",
              payload: {},
              createdAt: Date.now(),
              timeoutMs: 30_000,
            },
          })
          mock.emit({
            type: "permission.asked",
            properties: {
              id: "per_test",
              sessionID: req.sessionID,
              permission: "bash",
              patterns: ["*"],
              metadata: { command: "echo hi" },
              always: ["*"],
              tool: { messageID: "assistant-1", callID: "call-1" },
            },
          })
          mock.emit({ type: "session.unknown", properties: { sessionID: req.sessionID } })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "assistant-1",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: promptMessageID,
                parentMessageID: promptMessageID,
                mode: "build",
                agent: "build",
                cost: 0.25,
                path: { cwd: "/", root: "/" },
                tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
                modelID: "gpt-5.2",
                providerID: "openai",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-1",
              parentMessageID: promptMessageID,
              subtype: "success",
              stopReason: "stop",
              numTurns: 1,
              totalCostUsd: 0.25,
              usage: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
              modelUsage: {
                "openai/gpt-5.2": {
                  cost: 0.25,
                  tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
                },
              },
              structuredOutput: { ok: true },
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages = []
      for await (const msg of session.stream("normalize")) {
        messages.push(msg)
      }

      expect(messages.filter((msg) => msg.type === "tool.use" && msg.toolUseId === "call-1")).toHaveLength(1)
      expect(messages.some((msg) => msg.type === "tool.result" && msg.output === "hi")).toBe(true)
      expect(messages.find((msg) => msg.type === "system" && msg.subtype === "system.compact_boundary")).toMatchObject({
        type: "system",
        subtype: "system.compact_boundary",
        trigger: "auto",
        preCompactTokenCount: 42,
        compactionId: "msg_compact_stream",
        preservedMessageIds: ["msg_keep_stream"],
      })
      expect(messages.some((msg) => msg.type === "raw" && String(msg.event.type) === "session.unknown")).toBe(true)
      expect(messages.some((msg) => msg.type === "permission.request")).toBe(false)
      expect(
        messages.some(
          (msg) => msg.type === "assistant" && msg.text === "hello! world" && msg.reasoning === "thinking more",
        ),
      ).toBe(true)
      expect(messages.find((msg) => msg.type === "assistant")).toMatchObject({
        parts: [
          { id: "text-1", text: "hello!" },
          { id: "text-2", text: " world" },
          { id: "reason-1", text: "thinking more" },
          { id: "tool-1", state: { status: "completed" } },
        ],
      })
      expect(messages.at(-1)).toMatchObject({
        type: "result",
        text: "hello! world",
        result: {
          subtype: "success",
          sessionId: session.id,
          messageId: "assistant-1",
          parentMessageId: promptMessageID,
          stopReason: "stop",
          text: "hello! world",
          turns: 1,
          totalCostUsd: 0.25,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 3,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 5,
          },
          modelUsage: {
            "openai/gpt-5.2": {
              inputTokens: 1,
              outputTokens: 2,
              reasoningTokens: 3,
              cacheReadInputTokens: 4,
              cacheCreationInputTokens: 5,
              costUsd: 0.25,
            },
          },
          structuredOutput: { ok: true },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("Session.stream reports no result text when the final step is tool-only", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-tool-only-text" })
      let promptMessageID = ""
      mock.setPromptAsyncHandler((req) => {
        promptMessageID = (req.body as { messageID?: string }).messageID ?? ""
        setTimeout(() => {
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "tool-only-1",
                messageID: "assistant-tool-only",
                sessionID: req.sessionID,
                type: "tool",
                tool: "bash",
                callID: "call-tool-only",
                state: {
                  status: "completed",
                  time: { start: Date.now(), end: Date.now() },
                  input: { command: "echo hi" },
                  output: "hi",
                },
              },
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "assistant-tool-only",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: promptMessageID,
                parentMessageID: promptMessageID,
                mode: "build",
                agent: "build",
                cost: 0,
                path: { cwd: "/", root: "/" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "gpt-5.2",
                providerID: "openai",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-tool-only",
              parentMessageID: promptMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const msg of session.stream("tool only")) messages.push(msg)

      expect(messages.some((msg) => msg.type === "tool.result" && msg.toolUseId === "call-tool-only")).toBe(true)
      const assistants = messages.flatMap((msg) => (msg.type === "assistant" ? [msg] : []))
      expect(assistants).toHaveLength(1)
      expect(assistants[0]!.text).toBeUndefined()
      const terminals = messages.flatMap((msg) => (msg.type === "result" ? [msg] : []))
      expect(terminals).toHaveLength(1)
      expect(terminals[0]!.result.messageId).toBe("assistant-tool-only")
      expect(terminals[0]!.text).toBeUndefined()
      expect(terminals[0]!.result.text).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  test("Session.stream keeps result text undefined for an empty text delta", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-empty-delta-text" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          // No preceding message.part.updated: the accumulator path must leave the
          // entry absent rather than storing "".
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-empty",
              partID: "text-empty",
              field: "text",
              delta: "",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-empty",
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const result = await session.send("empty delta")

      expect(result.messageId).toBe("assistant-empty")
      expect(result.text).toBeUndefined()
      expect(result.text).not.toBe("")
    } finally {
      await client.close()
    }
  })

  test("Session.stream emits one user message after live parts are available", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-user-parts" })
      let promptMessageID = ""
      mock.setPromptAsyncHandler((req) => {
        promptMessageID = (req.body as { messageID?: string }).messageID ?? ""
        setTimeout(() => {
          const user = {
            id: promptMessageID,
            role: "user" as const,
            sessionID: req.sessionID,
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5.2" },
            time: { created: Date.now() },
          }
          mock.emit({ type: "message.updated", properties: { sessionID: req.sessionID, info: user } })
          mock.emit({
            type: "message.part.updated",
            properties: {
              sessionID: req.sessionID,
              time: Date.now(),
              part: {
                id: "user-text",
                messageID: promptMessageID,
                sessionID: req.sessionID,
                type: "text",
                text: "hello with parts",
              },
            },
          })
          mock.emit({ type: "message.updated", properties: { sessionID: req.sessionID, info: user } })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "assistant-user-parts",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: promptMessageID,
                parentMessageID: promptMessageID,
                mode: "build",
                agent: "build",
                path: { cwd: "/", root: "/" },
                modelID: "gpt-5.2",
                providerID: "openai",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-user-parts",
              parentMessageID: promptMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages = []
      for await (const msg of session.stream("hello with parts")) messages.push(msg)

      const users = messages.filter((msg) => msg.type === "user")
      expect(users).toHaveLength(1)
      expect(users[0]).toMatchObject({
        type: "user",
        parts: [{ id: "user-text", text: "hello with parts" }],
      })
      expect(messages.findIndex((msg) => msg.type === "user")).toBeLessThan(
        messages.findIndex((msg) => msg.type === "assistant"),
      )
    } finally {
      await client.close()
    }
  })

  test("Session.stream filters events to its own sessionID", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const sessionA = await client.sessions.create({ cwd: "/tmp/agent-sdk-a" })
      const sessionB = await client.sessions.create({ cwd: "/tmp/agent-sdk-b" })

      mock.setPromptAsyncHandler(async (req) => {
        // Emit an event for THE OTHER session first (should be filtered out),
        // then an event for THIS session, then session.idle.
        const otherID = req.sessionID === sessionA.id ? sessionB.id : sessionA.id
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: otherID,
              messageID: "cross",
              partID: "cross-p",
              field: "text",
              delta: "cross-traffic",
            },
          })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "own",
              partID: "own-p",
              field: "text",
              delta: "own-traffic",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const deltas: Array<{ sessionID: string; delta: string }> = []
      for await (const msg of sessionA.stream("prompt", { includePartialMessages: true })) {
        if (msg.type === "partial") {
          deltas.push({
            sessionID: (msg.raw as { properties?: { sessionID?: string } }).properties?.sessionID ?? "",
            delta: msg.delta,
          })
        }
      }

      // sessionA must NOT see sessionB's event.
      expect(deltas).toHaveLength(1)
      expect(deltas[0]!.sessionID).toBe(sessionA.id)
      expect(deltas[0]!.delta).toBe("own-traffic")
    } finally {
      await client.close()
    }
  })

  test("send() surfaces structured output retry exhaustion result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-structured-error" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "error_max_structured_output_retries",
              numTurns: 3,
              totalCostUsd: 0,
              error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(session.send("bad structured output")).resolves.toMatchObject({
        subtype: "error_max_structured_output_retries",
        turns: 3,
        error: { message: "Model did not produce structured output" },
      })
    } finally {
      await client.close()
    }
  })

  test("stream() surfaces structured output retry exhaustion result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-structured-stream-error" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "error_max_structured_output_retries",
              numTurns: 2,
              totalCostUsd: 0,
              error: { name: "StructuredOutputError", message: "Structured output does not match schema" },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const messages: AgentMessage[] = []
      for await (const msg of session.stream("bad structured output")) messages.push(msg)

      expect(messages.at(-1)).toMatchObject({
        type: "result",
        result: {
          subtype: "error_max_structured_output_retries",
          turns: 2,
          error: { message: "Structured output does not match schema" },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("send() rejects with a formatted message when the server returns an error body", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-err" })
      mock.setPromptAsyncHandler(() => Response.json({ message: "boom" }, { status: 400 }))

      await expect(session.send("bad")).rejects.toThrow(/Failed to stream prompt/)
    } finally {
      await client.close()
    }
  })

  test("abort() rejects when the server returns an error body", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-abort" })
      mock.setAbortHandler(() => Response.json({ message: "cannot abort" }, { status: 500 }))

      await expect(session.abort()).rejects.toThrow(/Failed to abort session/)
      expect(mock.capturedAborts).toHaveLength(1)
      expect(mock.capturedAborts[0]!.sessionID).toBe(session.id)
    } finally {
      await client.close()
    }
  })

  test("interrupt() posts abort and lets an active send resolve from terminal error_aborted", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-interrupt" })
      mock.setPromptAsyncHandler(async (req) => {
        mock.emit({
          type: "message.part.delta",
          properties: {
            sessionID: req.sessionID,
            messageID: "assistant-interrupted",
            partID: "text-interrupted",
            field: "text",
            delta: "partial answer",
          },
        })
        await sleep(80)
        return new Response(null, { status: 204 })
      })
      mock.setAbortHandler((req) => {
        const prompt = mock.capturedPromptAsync[mock.capturedPromptAsync.length - 1]
        mock.emit({
          type: "session.result",
          properties: {
            sessionID: req.sessionID,
            messageID: "assistant-interrupted",
            parentMessageID: requestMessageID(prompt?.body),
            subtype: "error_aborted",
            numTurns: 1,
            totalCostUsd: 0,
            error: { name: "AbortedError", message: "aborted" },
          },
        })
        mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        return Response.json(true, { status: 200 })
      })

      const running = session.send("long running")
      await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))
      await session.interrupt()

      await expect(running).resolves.toMatchObject({
        subtype: "error_aborted",
        error: { message: "aborted" },
      })
      // error_aborted keeps the partial answer produced before the interrupt.
      expect((await running).text).toBe("partial answer")
      expect(mock.capturedAborts).toHaveLength(1)
      expect(mock.capturedAborts[0]!.sessionID).toBe(session.id)
    } finally {
      await client.close()
    }
  })

  test("interrupt terminal result resolves even when prompt_async request is wedged", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    let releasePrompt = () => {}
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-interrupt-wedged" })
      mock.setPromptAsyncHandler((req) => {
        mock.emit({
          type: "message.part.delta",
          properties: {
            sessionID: req.sessionID,
            messageID: "assistant-wedged",
            partID: "text-wedged",
            field: "text",
            delta: "wedged partial",
          },
        })
        return new Promise<Response>((resolve) => {
          releasePrompt = () => resolve(new Response(null, { status: 204 }))
        })
      })
      mock.setAbortHandler((req) => {
        const prompt = mock.capturedPromptAsync[mock.capturedPromptAsync.length - 1]
        mock.emit({
          type: "session.result",
          properties: {
            sessionID: req.sessionID,
            messageID: "assistant-wedged",
            parentMessageID: requestMessageID(prompt?.body),
            subtype: "error_aborted",
            numTurns: 1,
            totalCostUsd: 0,
            error: { name: "AbortedError", message: "aborted" },
          },
        })
        mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        return Response.json(true, { status: 200 })
      })

      const running = session.send("long running")
      await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))
      await session.interrupt()

      await expect(Promise.race([running, timeout(250)])).resolves.toMatchObject({
        subtype: "error_aborted",
      })
      expect((await running).text).toBe("wedged partial")
    } finally {
      releasePrompt()
      await client.close()
    }
  })

  test("interrupt after hard stop does not rewrite the hard-stop result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-interrupt-after-hard-stop" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-capped",
              partID: "text-capped",
              field: "text",
              delta: "answer before the cap",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-capped",
              parentMessageID: requestMessageID(req.body),
              subtype: "error_max_turns",
              numTurns: 1,
              totalCostUsd: 0,
              error: { name: "MaxTurnsExceededError", message: "Maximum turns exceeded: 1" },
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      mock.setAbortHandler((req) => {
        const prompt = mock.capturedPromptAsync[mock.capturedPromptAsync.length - 1]
        mock.emit({
          type: "session.result",
          properties: {
            sessionID: req.sessionID,
            parentMessageID: requestMessageID(prompt?.body),
            subtype: "error_aborted",
            numTurns: 1,
            totalCostUsd: 0,
            error: { name: "AbortedError", message: "aborted" },
          },
        })
        mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        return Response.json(true, { status: 200 })
      })

      const iterator = session.stream("hit cap")
      let resultSeen = false
      while (!resultSeen) {
        const next = await Promise.race([iterator.next(), timeout(750)])
        if (next.done) throw new Error("stream ended before hard-stop result")
        if (next.value.type !== "result") continue
        resultSeen = true
        expect(next.value.result).toMatchObject({ subtype: "error_max_turns" })
        // error_max_turns still reports the text produced before the hard stop.
        expect(next.value.text).toBe("answer before the cap")
        expect(next.value.result.text).toBe("answer before the cap")
      }

      await session.interrupt()
      const final = await Promise.race([iterator.next(), timeout(750)])
      expect(final.done).toBe(true)
      expect(final.value).toMatchObject({ subtype: "error_max_turns" })
      expect(final.value).toMatchObject({ text: "answer before the cap" })
    } finally {
      await client.close()
    }
  })

  test("interrupt() without an active query still posts abort", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-interrupt-idle" })
      await session.interrupt()
      expect(mock.capturedAborts).toHaveLength(1)
      expect(mock.capturedAborts[0]!.sessionID).toBe(session.id)
    } finally {
      await client.close()
    }
  })

  test("Session.stream breaks promptly and closes the SSE subscription when the consumer exits early", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break" })
      const currentMock = mock
      mock.setPromptAsyncHandler(async (req) => {
        setTimeout(() => {
          currentMock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: session.id,
              messageID: "m",
              partID: "p",
              field: "text",
              delta: "one",
            },
          })
        }, 5)
        setTimeout(() => {
          currentMock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: session.id,
              messageID: "m",
              partID: "p",
              field: "text",
              delta: "two",
            },
          })
        }, 15)
        setTimeout(() => {
          currentMock.emit({
            type: "session.result",
            properties: {
              sessionID: session.id,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          currentMock.emit({ type: "session.idle", properties: { sessionID: session.id } })
        }, 150)
        return new Response(null, { status: 204 })
      })

      const startedAt = Date.now()
      let count = 0
      for await (const _msg of session.stream("prompt", { includePartialMessages: true })) {
        count++
        if (count >= 1) break
      }
      const elapsedMs = Date.now() - startedAt

      // Give Bun.serve a moment to flush the abort signal.
      await sleep(50)
      expect(elapsedMs).toBeLessThan(100)
      expect(mock.sseAborts()).toBeGreaterThanOrEqual(1)
    } finally {
      await client.close()
    }
  })

  test("Session.stream closes async iterable prompts when the consumer exits early", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-async-cleanup" })
      let cleanedUp = false
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "m",
              partID: "p",
              field: "text",
              delta: "one",
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const input = (async function* () {
        try {
          yield "first"
          yield "second"
        } finally {
          cleanedUp = true
        }
      })()

      for await (const msg of session.stream(input, { includePartialMessages: true })) {
        if (msg.type === "partial") break
      }

      expect(cleanedUp).toBe(true)
    } finally {
      await client.close()
    }
  })

  test("Session.close reclaims an abandoned async prompt and bounds a hostile iterator return", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-close-abandoned" })
      mock.setPromptAsyncHandler(() => new Response(null, { status: 204 }))
      const prompt = {
        [Symbol.asyncIterator]() {
          let yielded = false
          return {
            next() {
              if (!yielded) {
                yielded = true
                return Promise.resolve({ done: false as const, value: "first" })
              }
              return new Promise<IteratorResult<string>>(() => {})
            },
            return() {
              return new Promise<IteratorResult<string>>(() => {})
            },
          }
        },
      }
      const iterator = session.stream(prompt)
      const pending = iterator.next()
      await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))

      const startedAt = Date.now()
      const closed = await Promise.race([session.close().then(() => true), sleep(200).then(() => false)])
      expect(closed).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(150)
      await expect(pending).rejects.toThrow(/was closed while a stream was in flight/)
      await waitFor(() => (mock.sseConnections() === 0 ? true : undefined))
      await expect(session.send("closed")).rejects.toThrow(/Session .* is closed/)

      const resumed = await client.sessions.get(session.id)
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })
      await expect(resumed.send("fresh handle")).resolves.toMatchObject({ subtype: "success" })
    } finally {
      await client.close()
    }
  })

  test("Session.stream early-break cleanup releases local resources before abort resolves", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-slow-abort" })
      let cleanedUp = false
      mock.setAbortHandler(async () => {
        await sleep(500)
        return Response.json(true, { status: 200 })
      })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "m",
              partID: "p",
              field: "text",
              delta: "one",
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      const input = (async function* () {
        try {
          yield "first"
          yield "second"
        } finally {
          cleanedUp = true
        }
      })()

      for await (const msg of session.stream(input, { includePartialMessages: true })) {
        if (msg.type === "partial") break
      }

      expect(cleanedUp).toBe(true)
      await waitFor(() => (mock.capturedAborts.length === 1 ? true : undefined))

      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
        }, 5)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("second"), timeout(250)])).resolves.toMatchObject({
        subtype: "success",
      })
    } finally {
      await client.close()
    }
  })

  test("Session.stream early break does not let the abandoned result settle the next call", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-stale-result" })
      let firstMessageID = ""
      let secondMessageID = ""

      mock.setPromptAsyncHandler((req) => {
        const messageID = (req.body as { messageID?: string }).messageID ?? ""
        if (mock.capturedPromptAsync.length === 1) {
          firstMessageID = messageID
          setTimeout(() => {
            mock.emit({
              type: "message.part.delta",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                partID: "part-old",
                field: "text",
                delta: "old partial",
              },
            })
          }, 5)
          setTimeout(() => {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          }, 80)
          return new Response(null, { status: 204 })
        }

        secondMessageID = messageID
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: secondMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 140)
        return new Response(null, { status: 204 })
      })

      for await (const msg of session.stream("first", { includePartialMessages: true })) {
        if (msg.type === "partial") break
      }

      await waitFor(() => (mock.capturedAborts.length === 1 ? true : undefined))
      const result = await Promise.race([session.send("second"), timeout(750)])
      expect(result).toMatchObject({
        subtype: "success",
        messageId: "assistant-new",
        parentMessageId: secondMessageID,
      })
      expect(result.parentMessageId).not.toBe(firstMessageID)
    } finally {
      await client.close()
    }
  })

  test("Session.stream drains terminal idle before yielding result to breakable consumers", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-result-drain" })
      let secondMessageID = ""

      mock.setPromptAsyncHandler((req) => {
        const messageID = (req.body as { messageID?: string }).messageID ?? ""
        if (mock.capturedPromptAsync.length === 1) {
          setTimeout(() => {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                parentMessageID: messageID,
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
          }, 5)
          setTimeout(() => {
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          }, 20)
          return new Response(null, { status: 204 })
        }

        secondMessageID = messageID
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: secondMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 120)
        return new Response(null, { status: 204 })
      })

      for await (const msg of session.stream("first")) {
        if (msg.type === "result") break
      }

      const result = await Promise.race([session.send("second"), timeout(750)])
      expect(result).toMatchObject({
        subtype: "success",
        messageId: "assistant-new",
        parentMessageId: secondMessageID,
      })
    } finally {
      await client.close()
    }
  })

  test("Session.stream keeps stale-idle suppression after current turn activity", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-stale-idle-current-activity" })
      let messageID = ""

      mock.setPromptAsyncHandler((req) => {
        messageID = (req.body as { messageID?: string }).messageID ?? ""
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-stale",
              parentMessageID: "msg_stale",
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
        }, 5)
        setTimeout(() => {
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: messageID,
                role: "user",
                sessionID: req.sessionID,
                agent: "build",
                model: { providerID: "openai", modelID: "gpt-5.2" },
                time: { created: Date.now() },
              },
            },
          })
        }, 15)
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 25)
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: messageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 80)
        return new Response(null, { status: 204 })
      })

      const result = await Promise.race([session.send("current"), timeout(750)])
      expect(result).toMatchObject({
        subtype: "success",
        parentMessageId: messageID,
      })
    } finally {
      await client.close()
    }
  })

  test("Session.stream skips stale idle during result drain before the next run", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-stale-idle-result-drain" })
      let secondMessageID = ""

      mock.setPromptAsyncHandler((req) => {
        const messageID = (req.body as { messageID?: string }).messageID ?? ""
        if (mock.capturedPromptAsync.length === 1) {
          setTimeout(() => {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-stale",
                parentMessageID: "msg_stale",
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
          }, 5)
          setTimeout(() => {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-current",
                parentMessageID: messageID,
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
          }, 15)
          setTimeout(() => {
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          }, 20)
          setTimeout(() => {
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          }, 35)
          return new Response(null, { status: 204 })
        }

        secondMessageID = messageID
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: secondMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 120)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("first"), timeout(750)])).resolves.toMatchObject({
        subtype: "success",
        messageId: "assistant-current",
      })
      const result = await Promise.race([session.send("second"), timeout(750)])
      expect(result).toMatchObject({
        subtype: "success",
        parentMessageId: secondMessageID,
      })
    } finally {
      await client.close()
    }
  })

  test("Session.stream stale idle does not impose a timeout on a slow current run", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-stale-slow-current" })
      let secondMessageID = ""

      mock.setPromptAsyncHandler((req) => {
        const messageID = (req.body as { messageID?: string }).messageID ?? ""
        if (mock.capturedPromptAsync.length === 1) {
          setTimeout(() => {
            mock.emit({
              type: "message.part.delta",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                partID: "part-old",
                field: "text",
                delta: "old partial",
              },
            })
          }, 5)
          setTimeout(() => {
            mock.emit({
              type: "session.result",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                parentMessageID: messageID,
                subtype: "success",
                numTurns: 1,
                totalCostUsd: 0,
              },
            })
            mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          }, 80)
          return new Response(null, { status: 204 })
        }

        secondMessageID = messageID
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: secondMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 450)
        return new Response(null, { status: 204 })
      })

      for await (const msg of session.stream("first", { includePartialMessages: true })) {
        if (msg.type === "partial") break
      }

      await waitFor(() => (mock.capturedAborts.length === 1 ? true : undefined))
      const result = await Promise.race([session.send("second"), timeout(1000)])
      expect(result).toMatchObject({ subtype: "success" })
      expect(result.parentMessageId).toBe(secondMessageID)
    } finally {
      await client.close()
    }
  })

  test("Session.stream suppresses abandoned non-terminal events before the current result", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-break-stale-nonterminal" })
      let firstMessageID = ""
      let secondMessageID = ""

      mock.setPromptAsyncHandler((req) => {
        const messageID = (req.body as { messageID?: string }).messageID ?? ""
        if (mock.capturedPromptAsync.length === 1) {
          firstMessageID = messageID
          setTimeout(() => {
            mock.emit({
              type: "message.part.delta",
              properties: {
                sessionID: req.sessionID,
                messageID: "assistant-old",
                partID: "part-old",
                field: "text",
                delta: "old partial",
              },
            })
          }, 5)
          return new Response(null, { status: 204 })
        }

        secondMessageID = messageID
        setTimeout(() => {
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-old",
              partID: "part-old",
              field: "text",
              delta: "stale before marker",
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "assistant-old",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: firstMessageID,
                parentMessageID: firstMessageID,
                mode: "build",
                agent: "build",
                cost: 0,
                path: { cwd: "/", root: "/" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "gpt-5.2",
                providerID: "openai",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
            },
          })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-old",
              partID: "part-old",
              field: "text",
              delta: "stale old partial",
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-old",
              parentMessageID: firstMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
          mock.emit({
            type: "message.part.delta",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              partID: "part-new",
              field: "text",
              delta: "fresh answer",
            },
          })
          mock.emit({
            type: "message.updated",
            properties: {
              sessionID: req.sessionID,
              info: {
                id: "assistant-new",
                role: "assistant",
                sessionID: req.sessionID,
                parentID: secondMessageID,
                parentMessageID: secondMessageID,
                mode: "build",
                agent: "build",
                cost: 0,
                path: { cwd: "/", root: "/" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "gpt-5.2",
                providerID: "openai",
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
            },
          })
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-new",
              parentMessageID: secondMessageID,
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      })

      for await (const msg of session.stream("first", { includePartialMessages: true })) {
        if (msg.type === "partial") break
      }

      await waitFor(() => (mock.capturedAborts.length === 1 ? true : undefined))
      const messages: AgentMessage[] = []
      for await (const msg of session.stream("second", { includePartialMessages: true })) {
        messages.push(msg)
      }

      expect(
        messages.some(
          (msg) =>
            (msg.type === "assistant" && msg.message.id === "assistant-old") ||
            (msg.type === "partial" && msg.messageId === "assistant-old"),
        ),
      ).toBe(false)
      expect(messages.some((msg) => msg.type === "assistant" && msg.message.id === "assistant-new")).toBe(true)
      expect(messages.at(-1)).toMatchObject({ type: "result", result: { parentMessageId: secondMessageID } })
      // Stale-turn text never leaks into the current turn's result text.
      expect(messages.at(-1)).toMatchObject({ type: "result", text: "fresh answer", result: { text: "fresh answer" } })
    } finally {
      await client.close()
    }
  })

  test("Session.stream stale result suppression does not hide a missing-result idle", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-stale-result-missing-current" })
      mock.setPromptAsyncHandler((req) => {
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID: "assistant-stale",
              parentMessageID: "msg_stale",
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        setTimeout(() => {
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 350)
        return new Response(null, { status: 204 })
      })

      await expect(Promise.race([session.send("missing current result"), timeout(750)])).rejects.toThrow(
        /idle before session\.result/,
      )
    } finally {
      await client.close()
    }
  })

  test("control dispatcher posts same-session fallback responses", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control" })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { tool: "bash" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.sessionID).toBe(session.id)
      expect(captured.directory).toBe("/tmp/agent-sdk-control")
      expect(captured.body).toEqual({
        requestID,
        subtype: "can_use_tool",
        response: {
          behavior: "deny",
          message: "No canUseTool callback registered",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher calls canUseTool callback", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool",
        runtimeConfig: {
          canUseTool: async (toolName, input) =>
            toolName === "bash" && input.command === "rm -rf /tmp/nope"
              ? { behavior: "deny", message: "blocked" }
              : { behavior: "allow", updatedInput: { ...input, ok: true } },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "rm -rf /tmp/nope" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toEqual({
        requestID,
        subtype: "can_use_tool",
        response: {
          behavior: "deny",
          message: "blocked",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher preserves explicit canUseTool allow and ask responses", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool-allow-ask",
        runtimeConfig: {
          canUseTool: async (_toolName, input) =>
            input.mode === "ask" ? { behavior: "ask" } : { behavior: "allow", updatedInput: { command: "pwd" } },
        },
      })
      const allowID = crypto.randomUUID()
      const askID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: allowID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "ls" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })
      mock.emit({
        type: "control.request",
        properties: {
          id: askID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { mode: "ask" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      await waitFor(() => (mock.capturedControlResponses.length === 2 ? true : undefined))
      expect(mock.capturedControlResponses.map((item) => item.body)).toContainEqual({
        requestID: allowID,
        subtype: "can_use_tool",
        response: {
          behavior: "allow",
          updatedInput: { command: "pwd" },
        },
      })
      expect(mock.capturedControlResponses.map((item) => item.body)).toContainEqual({
        requestID: askID,
        subtype: "can_use_tool",
        response: { behavior: "ask" },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher denies rejected canUseTool callbacks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool-reject",
        runtimeConfig: {
          canUseTool: async () => {
            throw new Error("callback failed")
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "ls" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toEqual({
        requestID,
        subtype: "can_use_tool",
        response: {
          behavior: "deny",
          message: "callback failed",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher denies timed out canUseTool callbacks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool-timeout",
        runtimeConfig: {
          canUseTool: () => new Promise<never>(() => {}),
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "ls" } },
          createdAt: Date.now(),
          timeoutMs: 20,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toEqual({
        requestID,
        subtype: "can_use_tool",
        response: {
          behavior: "deny",
          message: "canUseTool callback timed out",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher denies invalid canUseTool callback responses", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool-invalid",
        runtimeConfig: {
          canUseTool: async () => undefined as never,
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "ls" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toEqual({
        requestID,
        subtype: "can_use_tool",
        response: {
          behavior: "deny",
          message: "Invalid canUseTool response",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("Session.close does not wait for a canUseTool callback that ignores abort", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-can-use-tool-close",
        runtimeConfig: {
          canUseTool: () => new Promise<never>(() => {}),
        },
      })
      mock.emit({
        type: "control.request",
        properties: {
          id: crypto.randomUUID(),
          sessionID: session.id,
          subtype: "can_use_tool",
          payload: { toolName: "bash", input: { command: "sleep 999" } },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      await sleep(20)
      const closed = await Promise.race([session.close().then(() => true), sleep(100).then(() => false)])
      expect(closed).toBe(true)
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("control dispatcher runs matching hook callbacks and aggregates results", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      let seenToolCallId: string | undefined
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-hooks",
        runtimeConfig: {
          hooks: {
            PreToolUse: [
              {
                matcher: /bash/,
                callback: async (payload) => {
                  seenToolCallId = payload.toolCallId
                  return {
                    permissionDecision: "allow",
                    updatedInput: { command: "npm test" },
                    additionalContext: "context",
                  }
                },
              },
              {
                matcher: /write/,
                callback: async () => ({ permissionDecision: "deny" }),
              },
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash", callID: "call-1" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: true,
          permissionDecision: { behavior: "allow" },
          updatedInput: { command: "npm test" },
          additionalContext: ["context"],
        },
      })
      expect(seenToolCallId).toBe("call-1")
    } finally {
      await client.close()
    }
  })

  test("control dispatcher aggregates PreCompact custom instructions", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-precompact",
        runtimeConfig: {
          hooks: {
            PreCompact: [
              async () => ({ customInstructions: "Keep API decisions." }),
              async () => ({ customInstructions: "Preserve migration risks." }),
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreCompact",
            target: "manual",
            data: { trigger: "manual", messageCount: 2 },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreCompact"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: true,
          customInstructions: "Keep API decisions.\n\nPreserve migration risks.",
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher hook deny wins over matching allow callbacks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-hooks-deny",
        runtimeConfig: {
          hooks: {
            PreToolUse: [
              {
                matcher: /bash/,
                callback: async () => ({ permissionDecision: "allow" }),
              },
              {
                matcher: /bash/,
                callback: async () => ({ permissionDecision: PermissionDecision.deny("blocked") }),
              },
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: true,
          permissionDecision: { behavior: "deny", message: "blocked" },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher hook ask wins over later matching allow callbacks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-hooks-ask",
        runtimeConfig: {
          hooks: {
            PreToolUse: [
              {
                matcher: /bash/,
                callback: async () => ({ permissionDecision: PermissionDecision.ask() }),
              },
              {
                matcher: /bash/,
                callback: async () => ({ permissionDecision: PermissionDecision.allow({ command: "npm test" }) }),
              },
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: true,
          permissionDecision: { behavior: "ask" },
          updatedInput: { command: "npm test" },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher merges hook permission-decision and top-level input updates", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-hooks-merge",
        runtimeConfig: {
          hooks: {
            PreToolUse: [
              {
                matcher: /bash/,
                callback: async () => ({ permissionDecision: PermissionDecision.allow({ command: "npm test" }) }),
              },
              {
                matcher: /bash/,
                callback: async () => ({ updatedInput: { timeout: 1_000 } }),
              },
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: true,
          permissionDecision: { behavior: "allow", updatedInput: { command: "npm test" } },
          updatedInput: { command: "npm test", timeout: 1_000 },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher ignores unmatched policy hook descriptors", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-hooks-unmatched",
        runtimeConfig: {
          hooks: defineHook("PreToolUse", /bash/, async () => ({
            permissionDecision: PermissionDecision.deny("blocked"),
          })),
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "read",
            data: { toolName: "read" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: { continue: true },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher fails closed for policy hooks without local callbacks", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-hooks-resume-missing" })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash" },
            descriptors: [{ id: "pre-bash", matcher: "bash" }],
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toMatchObject({
        requestID,
        subtype: "hook_callback",
        response: {
          continue: false,
          permissionDecision: {
            behavior: "deny",
            message: "No local hook callback registered for PreToolUse",
          },
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher posts elicitation and MCP fallback payloads", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-fallbacks" })
      const elicitationID = crypto.randomUUID()
      const mcpID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: elicitationID,
          sessionID: session.id,
          subtype: "elicitation",
          payload: { question: "Continue?" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })
      mock.emit({
        type: "control.request",
        properties: {
          id: mcpID,
          sessionID: session.id,
          subtype: "mcp_message",
          payload: { method: "ping" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      await waitFor(() => (mock.capturedControlResponses.length === 2 ? true : undefined))
      expect(mock.capturedControlResponses.map((item) => item.body)).toContainEqual({
        requestID: elicitationID,
        subtype: "elicitation",
        response: {
          behavior: "decline",
          message: "No elicitation handler registered",
        },
      })
      expect(mock.capturedControlResponses.map((item) => item.body)).toContainEqual({
        requestID: mcpID,
        subtype: "mcp_message",
        response: { error: "No SDK MCP message handler registered" },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher executes direct SDK MCP tools", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-direct-mcp",
        runtimeConfig: {
          sdkMcpServers: [
            createSdkMcpServer({
              name: "local",
              transport: "direct",
              tools: [
                defineTool({
                  name: "echo",
                  inputSchema: { type: "object", properties: { value: { type: "string" } } },
                  execute: (input: { value: string }, ctx) => ({
                    value: input.value,
                    sessionId: ctx.sessionId,
                    rootSessionId: ctx.rootSessionId,
                    toolCallId: ctx.toolCallId,
                  }),
                }),
              ],
            }),
          ],
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "mcp_message",
          payload: {
            server: "local",
            tool: "echo",
            input: { value: "hello" },
            activeSessionID: "ses_child",
            rootSessionID: session.id,
            toolCallId: "call_1",
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      const captured = await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.body).toEqual({
        requestID,
        subtype: "mcp_message",
        response: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                value: "hello",
                sessionId: "ses_child",
                rootSessionId: session.id,
                toolCallId: "call_1",
              }),
            },
          ],
        },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher ignores cross-session requests", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-own" })
      mock.emit({
        type: "control.request",
        properties: {
          id: crypto.randomUUID(),
          sessionID: `${session.id}-other`,
          subtype: "hook_callback",
          payload: { hook: "ignored" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      await sleep(50)
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("control cancellation aborts local pending work before a late response posts", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({
        cwd: "/tmp/agent-sdk-control-cancel",
        runtimeConfig: {
          hooks: {
            PreToolUse: [
              {
                matcher: /bash/,
                callback: () => new Promise<never>(() => {}),
              },
            ],
          },
        },
      })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: {
            event: "PreToolUse",
            target: "bash",
            data: { toolName: "bash" },
            descriptors: runtimeHookDescriptors(mock, session.id, "PreToolUse"),
          },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })
      mock.emit({
        type: "control.cancelled",
        properties: {
          id: requestID,
          sessionID: session.id,
          reason: "cancelled",
        },
      })

      await sleep(50)
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("control dispatcher ignores duplicate SSE requests", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-duplicate" })
      const requestID = crypto.randomUUID()
      const event = {
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: { hook: "pre_tool" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      }
      mock.emit(event)
      mock.emit(event)

      await waitFor(() => mock.capturedControlResponses[0])
      await sleep(20)
      expect(mock.capturedControlResponses).toHaveLength(1)
      expect(mock.capturedControlResponses[0]!.body.requestID).toBe(requestID)
    } finally {
      await client.close()
    }
  })

  test("control dispatcher records cancel-before-request across SSE and replay", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-cancel-before" })
      const requestID = crypto.randomUUID()
      mock.emit({
        type: "control.cancelled",
        properties: {
          id: requestID,
          sessionID: session.id,
          reason: "cancelled",
        },
      })
      mock.emit({
        type: "control.request",
        properties: {
          id: requestID,
          sessionID: session.id,
          subtype: "hook_callback",
          payload: { hook: "stale-sse" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })
      mock.addControlRequest({
        id: requestID,
        sessionID: session.id,
        subtype: "hook_callback",
        payload: { hook: "stale-replay" },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      })
      mock.closeSseConnections()

      await waitFor(() => (mock.capturedControlLists.length >= 2 ? true : undefined), 100)
      await sleep(20)
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("Session.close stops its control SSE subscription", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-close" })
      expect(mock.sseConnections()).toBeGreaterThanOrEqual(1)
      await session.close()
      mock.emit({
        type: "control.request",
        properties: {
          id: crypto.randomUUID(),
          sessionID: session.id,
          subtype: "hook_callback",
          payload: { hook: "after_close" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("Session.close waits for pending control work to settle without posting late fallback", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-close-pending" })
      mock.emit({
        type: "control.request",
        properties: {
          id: crypto.randomUUID(),
          sessionID: session.id,
          subtype: "hook_callback",
          payload: { hook: "pre_tool" },
          createdAt: Date.now(),
          timeoutMs: 30_000,
        },
      })

      await session.close()
      expect(mock.capturedControlResponses).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  test("AgentClient.close stops active session dispatchers before closing transport", async () => {
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const first = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-client-a" })
    const second = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-client-b" })
    expect(first.id).not.toBe(second.id)
    expect(mock.sseConnections()).toBeGreaterThanOrEqual(2)

    await client.close()
    mock.emit({
      type: "control.request",
      properties: {
        id: crypto.randomUUID(),
        sessionID: first.id,
        subtype: "hook_callback",
        payload: { hook: "after_client_close_a" },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    mock.emit({
      type: "control.request",
      properties: {
        id: crypto.randomUUID(),
        sessionID: second.id,
        subtype: "hook_callback",
        payload: { hook: "after_client_close_b" },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    expect(mock.capturedControlResponses).toHaveLength(0)
  })

  test("control dispatcher recovers pending requests after reconnect", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-reconnect" })
      const requestID = crypto.randomUUID()
      mock.addControlRequest({
        id: requestID,
        sessionID: session.id,
        subtype: "hook_callback",
        payload: { hook: "after_reconnect" },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      })
      mock.closeSseConnections()

      const captured = await waitFor(() => mock.capturedControlResponses[0], 100)
      expect(captured.body).toEqual({
        requestID,
        subtype: "hook_callback",
        response: { continue: true },
      })
    } finally {
      await client.close()
    }
  })

  test("control dispatcher deduplicates SSE requests replayed by /control-requests", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-replay-dedupe" })
      const requestID = crypto.randomUUID()
      mock.setControlResponseDelay(50)
      const request = {
        id: requestID,
        sessionID: session.id,
        subtype: "hook_callback" as const,
        payload: { hook: "replayed" },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      }
      mock.addControlRequest(request)
      mock.emit({ type: "control.request", properties: request })
      mock.closeSseConnections()

      await waitFor(() => mock.capturedControlResponses[0], 100)
      await waitFor(() => (mock.capturedControlLists.length >= 2 ? true : undefined), 100)
      await sleep(20)
      expect(mock.capturedControlResponses).toHaveLength(1)
      expect(mock.capturedControlResponses[0]!.body.requestID).toBe(requestID)
    } finally {
      await client.close()
    }
  })

  test("control dispatcher stops reconnecting after readiness when event reconnects keep failing", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-reconnect-exhaust" })
      const initialRequests = mock.sseRequests()
      mock.setEventFailure(true)
      mock.closeSseConnections()

      await waitFor(() => (mock.sseRequests() >= initialRequests + 2 ? true : undefined), 100)
      await sleep(30)
      expect(mock.sseRequests()).toBe(initialRequests + 2)
      await session.close()
    } finally {
      await client.close()
    }
  })

  test("control dispatcher exhausts reconnects when streams connect and close cleanly", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-connect-close" })
      const initialRequests = mock.sseRequests()
      mock.setEventCloseAfterConnected(true)
      mock.closeSseConnections()

      await waitFor(() => (mock.sseRequests() >= initialRequests + 2 ? true : undefined), 100)
      await sleep(30)
      expect(mock.sseRequests()).toBe(initialRequests + 2)
      await session.close()
    } finally {
      await client.close()
    }
  })

  test("control dispatcher counts /control-requests recovery failures against reconnect attempts", async () => {
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: { reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 } },
    })
    try {
      const session = await client.sessions.create({ cwd: "/tmp/agent-sdk-control-list-fail" })
      const initialLists = mock.capturedControlLists.length
      mock.setControlListHandler(() => Response.json({ message: "list failed" }, { status: 500 }))
      mock.closeSseConnections()

      await waitFor(() => (mock.capturedControlLists.length >= initialLists + 2 ? true : undefined), 100)
      await sleep(30)
      expect(mock.capturedControlLists).toHaveLength(initialLists + 2)
      await session.close()
    } finally {
      await client.close()
    }
  })

  test("control dispatcher surfaces readiness timeout", async () => {
    await mock.stop()
    mock = await startMockServer({ sendConnected: false })
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      control: {
        readyTimeoutMs: 50,
        reconnect: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      },
    })
    try {
      await expect(client.sessions.create({ cwd: "/tmp/agent-sdk-control-timeout" })).rejects.toThrow(
        /control dispatcher readiness/,
      )
    } finally {
      await client.close()
    }
  })
})
