import { expect, test } from "bun:test"
import { createCognitioClient, CognitioClient } from "../src/v2/client.js"
import type {
  Event,
  EventSessionResult,
  RuntimeConfig,
  SessionCreateData,
  SessionPromptAsyncData,
  SessionSummarizeData,
  SessionRuntimeConfigClearMcpScopesData,
  SessionRuntimeConfigClearMcpScopesResponse,
  SessionRuntimeConfigGetResponse,
  SessionRuntimeConfigPatchData,
  SessionRuntimeConfigPatchResponse,
} from "../src/v2/client.js"

test("generated client exposes session runtime config surface", () => {
  const session = new CognitioClient().session
  const runtimeConfig = session.runtimeConfig

  expect(runtimeConfig).toBeDefined()
  expect(typeof runtimeConfig.get).toBe("function")
  expect(typeof runtimeConfig.patch).toBe("function")
  expect(typeof runtimeConfig.clearMcpScopes).toBe("function")
  expect(typeof runtimeConfig.clear).toBe("function")
  expect(typeof session.commands).toBe("function")
  expect(typeof session.skills).toBe("function")
})

test("generated runtime config types accept request and response payloads", () => {
  const request: SessionRuntimeConfigPatchData = {
    url: "/session/{sessionID}/runtime-config",
    path: { sessionID: "ses_test" },
    body: {
      systemPrompt: { type: "preset", preset: "default", append: "Be exact." },
      appendSystemPrompt: "Use source citations.",
      settingSources: ["project", "local"],
      maxTurns: 5,
      permissionMode: "dontAsk",
      model: { providerID: "anthropic", modelID: "claude" },
      allowedTools: ["read", "grep"],
      skills: [
        {
          name: "runtime-review",
          description: "Review runtime changes",
          content: "Review the active diff.",
          model: { providerID: "openai", modelID: "gpt-5.2" },
        },
      ],
      commands: [{ name: "runtime-ship", template: "Ship $ARGUMENTS" }],
      plugins: [
        {
          type: "inline",
          name: "team",
          skills: [{ name: "triage", description: "Triage work", content: "Triage the issue." }],
          commands: [{ name: "handoff", template: "Write a handoff." }],
          mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
        },
        { type: "claude", path: "/tmp/claude-plugin" },
      ],
      agents: {
        reviewer: {
          prompt: "Review carefully.",
          spawnMode: "inherit",
          mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
        },
      },
      sdkMcpServers: [
        {
          name: "direct",
          type: "sdk",
          transport: "direct",
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
      ],
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        retryCount: 1,
      },
    } satisfies RuntimeConfig,
  }
  const patchResponse: SessionRuntimeConfigPatchResponse = request.body ?? {}
  const getResponse: SessionRuntimeConfigGetResponse = {
    sessionID: "ses_test",
    runtimeConfig: patchResponse,
    effective: {
      model: patchResponse.model,
      maxTurns: patchResponse.maxTurns,
      permissionMode: patchResponse.permissionMode,
      systemPrompt: { mode: "preset", preset: "default", hasAppend: true },
      appendSystemPrompt: { length: 21 },
      settingSources: ["project", "local"],
      tools: {
        allowed: patchResponse.allowedTools ?? [],
        disallowed: patchResponse.disallowedTools ?? [],
      },
      agents: {
        reviewer: {
          description: "Reviewer",
          spawnMode: "inherit",
          hasModel: false,
          toolCount: 0,
          disallowedToolCount: 0,
          mcpServerCount: 1,
        },
      },
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
          agentCount: 0,
          hookEventCount: 0,
          mcpServerCount: 1,
        },
      ],
    },
  }

  expect(getResponse.runtimeConfig.maxTurns).toBe(5)
  expect(getResponse.effective.tools.allowed).toEqual(["read", "grep"])
  expect(getResponse.effective.permissionMode).toBe("dontAsk")
  expect(getResponse.effective.systemPrompt).toEqual({ mode: "preset", preset: "default", hasAppend: true })
  expect(getResponse.effective.appendSystemPrompt).toEqual({ length: 21 })
  expect(getResponse.effective.settingSources).toEqual(["project", "local"])
  expect(getResponse.runtimeConfig.agents?.reviewer?.spawnMode).toBe("inherit")
  expect(getResponse.runtimeConfig.sdkMcpServers?.[0]?.type).toBe("sdk")
  expect(getResponse.runtimeConfig.skills?.[0]?.name).toBe("runtime-review")
  expect(getResponse.runtimeConfig.commands?.[0]?.name).toBe("runtime-ship")
  expect(getResponse.runtimeConfig.plugins?.[0]?.type).toBe("inline")
  expect(getResponse.runtimeConfig.outputFormat?.retryCount).toBe(1)
  expect(getResponse.effective.plugins[0]?.name).toBe("team")
})

test("generated session result type includes structured output retry exhaustion subtype", () => {
  const event: EventSessionResult = {
    type: "session.result",
    properties: {
      sessionID: "ses_test",
      subtype: "error_max_structured_output_retries",
      numTurns: 3,
      error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
    },
  }

  expect(event.properties.subtype).toBe("error_max_structured_output_retries")
  expect(event.properties.error?.name).toBe("StructuredOutputError")
})

test("generated prompt format type includes structured output retryCount", () => {
  const request: SessionPromptAsyncData = {
    url: "/session/{sessionID}/prompt_async",
    path: { sessionID: "ses_test" },
    body: {
      parts: [{ type: "text", text: "structured please" }],
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        retryCount: 2,
      },
    },
  }

  if (!request.body) throw new Error("expected prompt body")
  expect(request.body.format?.type).toBe("json_schema")
  if (request.body.format?.type === "json_schema") expect(request.body.format.retryCount).toBe(2)
})

test("generated runtime config types include scoped MCP cleanup route", () => {
  const request: SessionRuntimeConfigClearMcpScopesData = {
    url: "/session/{sessionID}/runtime-config/mcp-scopes",
    path: { sessionID: "ses_test" },
  }
  const response: SessionRuntimeConfigClearMcpScopesResponse = true

  expect(request.path.sessionID).toBe("ses_test")
  expect(response).toBe(true)
})

test("generated runtime config types reject malformed Phase 8 payloads", () => {
  const badSkillName: RuntimeConfig = {
    skills: [
      {
        // @ts-expect-error runtime skill names must be strings.
        name: 42,
        description: "Review",
        content: "Review.",
      },
    ],
  }
  const badSkillFlag: RuntimeConfig = {
    skills: [
      {
        name: "review",
        description: "Review",
        content: "Review.",
        // @ts-expect-error disableModelInvocation must be boolean.
        disableModelInvocation: "yes",
      },
    ],
  }
  const badCommandSubtask: RuntimeConfig = {
    commands: [
      {
        name: "ship",
        template: "Ship",
        // @ts-expect-error command subtask must be boolean.
        subtask: "yes",
      },
    ],
  }
  const badClaudePluginPath: RuntimeConfig = {
    plugins: [
      {
        type: "claude",
        // @ts-expect-error Claude plugin path must be a string.
        path: 42,
      },
    ],
  }
  const badOutputFormatRetry: RuntimeConfig = {
    outputFormat: {
      type: "json_schema",
      schema: { type: "object" },
      // @ts-expect-error output format retryCount must be a number.
      retryCount: "two",
    },
  }

  expect([badSkillName, badSkillFlag, badCommandSubtask, badClaudePluginPath, badOutputFormatRetry]).toHaveLength(5)
})

test("generated session create types accept create-time runtime config", () => {
  const request: SessionCreateData = {
    url: "/session",
    body: {
      title: "with runtime config",
      runtimeConfig: {
        systemPrompt: "Custom prompt.",
        settingSources: [],
        permissionMode: "plan",
        canUseTool: true,
      },
    },
  }

  expect(request.body?.runtimeConfig?.permissionMode).toBe("plan")
  expect(request.body?.runtimeConfig?.systemPrompt).toBe("Custom prompt.")
  expect(request.body?.runtimeConfig?.settingSources).toEqual([])
})

test("generated session command method requires command body fields", () => {
  const client = createCognitioClient({ baseUrl: "http://127.0.0.1:1" })

  // @ts-expect-error session.command requires both command and arguments.
  client.session.command({ sessionID: "ses_test" })
  // @ts-expect-error session.command requires arguments.
  client.session.command({ sessionID: "ses_test", command: "ship" })
  // @ts-expect-error session.command requires command.
  client.session.command({ sessionID: "ses_test", arguments: "now" })

  expect(typeof client.session.command).toBe("function")
})

test("generated compaction types include Phase 6 fields", () => {
  const summarize: SessionSummarizeData = {
    url: "/session/{sessionID}/summarize",
    path: { sessionID: "ses_test" },
    body: {
      providerID: "anthropic",
      modelID: "claude",
      auto: false,
      customInstructions: "Preserve API decisions.",
    },
  }
  const boundary: Event = {
    type: "system.compact_boundary",
    properties: {
      sessionID: "ses_test",
      messageID: "msg_user",
      auto: false,
      overflow: false,
      trigger: "manual",
      preCompactTokenCount: 100,
      compactionId: "msg_summary",
      preservedMessageIds: ["msg_tail"],
    },
  }

  expect(summarize.body?.customInstructions).toBe("Preserve API decisions.")
  if (boundary.type !== "system.compact_boundary") throw new Error("expected compact boundary")
  expect(boundary.properties.compactionId).toBe("msg_summary")
  expect(boundary.properties.preservedMessageIds).toEqual(["msg_tail"])
})

test("generated summarize method serializes customInstructions at runtime", async () => {
  let body: unknown
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      body = await req.json()
      return Response.json(true)
    },
  })

  try {
    const result = await createCognitioClient({ baseUrl: `http://${server.hostname}:${server.port}` }).session.summarize({
      sessionID: "ses_test",
      providerID: "anthropic",
      modelID: "claude",
      auto: false,
      customInstructions: "Preserve API decisions.",
    })

    expect(result.error).toBeUndefined()
    expect(body).toEqual({
      providerID: "anthropic",
      modelID: "claude",
      auto: false,
      customInstructions: "Preserve API decisions.",
    })
  } finally {
    server.stop()
  }
})

test("generated subagent event types include parent message correlation", () => {
  const event: Event = {
    type: "subagent.started",
    properties: {
      sessionID: "ses_root",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      agent: "reviewer",
      messageID: "msg_parent",
      taskID: "ses_child",
      spawnMode: "inherit",
    },
  }

  expect(event.properties.messageID).toBe("msg_parent")
})
