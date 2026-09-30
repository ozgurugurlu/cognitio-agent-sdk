import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Agent, createAgentClient, createSdkMcpServer, defineTool, isSdkError } from "../src/index.js"
import { normalizeRuntimeConfig } from "../src/internal/runtime-config.js"
import { startSdkMcpServers, stopSdkMcpHosts } from "../src/tools/mcp-server.js"
import { startMockServer, waitFor } from "./mock-server.js"
import { stopAndWait, registerAutoCleanup, autoCleanupCount } from "../src/internal/runtime-client/process.js"

describe("v2 public contracts", () => {
  test("remote authorization headers reach session, SSE, and control response requests", async () => {
    const mock = await startMockServer()
    const captured: Array<{ path: string; authorization: string | null }> = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const authorization = request.headers.get("authorization")
        captured.push({ path: url.pathname, authorization })
        if (authorization !== "Bearer test-token") return Response.json({ message: "Unauthorized" }, { status: 401 })
        return fetch(new Request(`${mock.baseUrl}${url.pathname}${url.search}`, request))
      },
    })
    const agent = new Agent({
      baseUrl: `http://127.0.0.1:${proxy.port}`,
      headers: { Authorization: "Bearer test-token" },
      canUseTool: () => ({ behavior: "allow" }),
    })
    try {
      const session = await agent.createSession()
      const request = {
        id: crypto.randomUUID(),
        sessionID: session.id,
        subtype: "can_use_tool" as const,
        payload: { toolName: "read", input: {} },
        createdAt: Date.now(),
        timeoutMs: 1000,
      }
      mock.addControlRequest(request)
      mock.emit({ type: "control.request", properties: request })
      await waitFor(() => mock.capturedControlResponses[0])
      expect(captured.some((request) => request.path === "/session")).toBe(true)
      expect(captured.some((request) => request.path === "/event")).toBe(true)
      expect(captured.some((request) => request.path.endsWith("/control-response"))).toBe(true)
      expect(captured.every((request) => request.authorization === "Bearer test-token")).toBe(true)
      await expect(createAgentClient({ headers: { Authorization: "secret" } })).rejects.toThrow(/requires baseUrl/)
      expect(() => new Agent({ headers: { Authorization: "secret" } })).toThrow(/requires "baseUrl"/)
    } finally {
      await agent.close()
      await proxy.stop(true)
      await mock.stop()
    }
  })

  test("custom child handles with undefined exit properties are stopped and awaited", async () => {
    // Windows stops a process tree by PID before calling handle.kill(). Use a
    // real owned child, never the test runner's PID, even for this custom handle.
    const child = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); process.stdout.write("ready\\n")'], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    const exited = once(child, "exit")
    exited.catch(() => {})
    let didExit = false
    child.once("exit", () => {
      didExit = true
    })
    const handle = new Proxy(child, {
      get(target, property) {
        if (property === "exitCode" || property === "signalCode") return undefined
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const count = autoCleanupCount()
    const unregister = registerAutoCleanup(handle)
    try {
      const ready = await once(child.stdout, "data", { signal: AbortSignal.timeout(10000) })
      expect(String(ready[0])).toBe("ready\n")
      expect(child.pid).toBeGreaterThan(0)
      expect(child.pid).not.toBe(process.pid)
      expect(handle.exitCode).toBeUndefined()
      expect(handle.signalCode).toBeUndefined()
      await stopAndWait(handle, 1000)
      expect(didExit).toBe(true)
      expect(autoCleanupCount()).toBe(count)
    } finally {
      unregister()
      if (!didExit) child.kill("SIGKILL")
      await exited
    }
  })
  test("reasoning and session policies normalize without dropping fields", () => {
    const input = {
      effort: "high" as const,
      thinkingConfig: { type: "enabled" as const, budgetTokens: 2048 },
      checkpointing: { enabled: true, beforeTools: false, beforeCompaction: true },
      compaction: { auto: false, includeFiles: false },
      includeEnvironment: false,
      backgroundTaskPolicy: { mode: "foreground" as const },
      sdkMcpServers: [
        {
          name: "local",
          type: "local" as const,
          command: ["node", "server.mjs"],
          environment: { TEST: "1" },
          cwd: "/tmp",
        },
        { name: "legacy", type: "remote" as const, transport: "sse" as const, url: "https://example.com/sse" },
      ],
    }
    expect(normalizeRuntimeConfig(input)).toEqual(input)
    expect(() => normalizeRuntimeConfig({ thinkingConfig: { type: "enabled", budgetTokens: 32 } })).toThrow(/1024/)
    expect(() => normalizeRuntimeConfig({ backgroundTaskPolicy: { mode: "detached" } as never })).toThrow(/foreground/)
    expect(() => normalizeRuntimeConfig({ sdkMcpServers: [{ name: "bad", type: "local", command: [] }] })).toThrow(
      /command/,
    )
  })

  test("configuration and lifecycle errors expose stable kinds", async () => {
    const error = (() => {
      try {
        return new Agent({ maxTurns: -1 })
      } catch (error) {
        return error
      }
    })()
    expect(isSdkError(error)).toBe(true)
    if (isSdkError(error)) expect(error.kind).toBe("configuration")
    const agent = new Agent()
    await agent.close()
    const closed = await agent.run("never sent").catch((error: unknown) => error)
    expect(isSdkError(closed)).toBe(true)
    if (isSdkError(closed)) expect(closed.kind).toBe("closed")
  })

  test("HTTP MCP serves resources and parameterized prompts over the real protocol", async () => {
    const descriptors = createSdkMcpServer({
      name: "content",
      tools: [],
      resources: [
        {
          name: "guide",
          uri: "docs://guide",
          mimeType: "text/plain",
          read: (context) => ({ contents: [{ uri: "docs://guide", text: context.sessionId }] }),
        },
      ],
      prompts: [
        {
          name: "review",
          arguments: [{ name: "subject", required: true }],
          get: (args) => ({ messages: [{ role: "user", content: { type: "text", text: `Review ${args.subject}` } }] }),
        },
      ],
    })
    const hosted = await startSdkMcpServers([descriptors], { sessionId: "session-content" })
    const client = new Client({ name: "content-test", version: "1.0.0" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(hosted.specs[0]!.url)))
      expect((await client.listResources()).resources).toEqual([
        { name: "guide", uri: "docs://guide", mimeType: "text/plain" },
      ])
      expect((await client.readResource({ uri: "docs://guide" })).contents[0]).toMatchObject({
        text: "session-content",
      })
      expect((await client.listPrompts()).prompts[0]?.name).toBe("review")
      expect(
        (await client.getPrompt({ name: "review", arguments: { subject: "this change" } })).messages[0]?.content,
      ).toEqual({ type: "text", text: "Review this change" })
      await expect(client.getPrompt({ name: "review" })).rejects.toThrow(/subject/)
      await expect(client.readResource({ uri: "docs://missing" })).rejects.toThrow(/Unknown resource/)
    } finally {
      await client.close()
      await stopSdkMcpHosts(hosted.hosts)
    }
  })

  test("resume merges explicit overrides and coalesces concurrent attachment", async () => {
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const original = await client.sessions.create({
        runtimeConfig: { instructions: "Keep this prompt", maxTurns: 4 },
      })
      await original.close()
      const resumed = await client.sessions.resume(original.id, {
        runtimeConfig: { effort: "high", maxBudgetUsd: 2 },
        title: "Resumed",
      })
      expect(mock.runtimeConfigs.get(original.id)).toMatchObject({
        systemPrompt: "Keep this prompt",
        maxTurns: 4,
        effort: "high",
        maxBudgetUsd: 2,
      })
      expect(mock.sessions.get(original.id)?.title).toBe("Resumed")
      await expect(client.sessions.resume(original.id, { runtimeConfig: { maxTurns: 1 } })).rejects.toThrow(
        /active handle/,
      )
      await resumed.close()
      const handles = await Promise.all([
        client.sessions.get(original.id),
        client.sessions.resume(original.id),
        client.sessions.get(original.id),
      ])
      expect(handles[0]).toBe(handles[1])
      expect(handles[1]).toBe(handles[2])
    } finally {
      await client.close()
      await mock.stop()
    }
  })

  test("failed resume setup restores the previous runtime config", async () => {
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl, control: { readyTimeoutMs: 100 } })
    try {
      const original = await client.sessions.create({ runtimeConfig: { maxTurns: 4 } })
      await original.close()
      const before = structuredClone(mock.runtimeConfigs.get(original.id))
      mock.setRuntimeConfigPatchHandler((request) => {
        if (request.body.maxTurns === 9) return Response.json({ message: "reject override" }, { status: 500 })
        mock.runtimeConfigs.set(request.sessionID, { ...mock.runtimeConfigs.get(request.sessionID), ...request.body })
        return Response.json(mock.runtimeConfigs.get(request.sessionID))
      })
      await expect(client.sessions.resume(original.id, { runtimeConfig: { maxTurns: 9 } })).rejects.toThrow(
        /reject override/,
      )
      expect(mock.runtimeConfigs.get(original.id)).toEqual(before)
      expect(mock.sessions.has(original.id)).toBe(true)
    } finally {
      await client.close()
      await mock.stop()
    }
  })

  test("explicit empty MCP registrations clear stored servers through client and facade resume", async () => {
    expect(normalizeRuntimeConfig({ sdkMcpServers: [] })).toEqual({ sdkMcpServers: [] })
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const agent = new Agent({ client, tools: [] })
    try {
      const original = await client.sessions.create({
        runtimeConfig: { sdkMcpServers: [{ name: "external", type: "remote", url: "https://example.test/mcp" }] },
      })
      await original.close()
      const cleared = await client.sessions.resume(original.id, { runtimeConfig: { sdkMcpServers: [] } })
      expect(mock.runtimeConfigs.get(original.id)?.sdkMcpServers).toEqual([])
      await cleared.close()
      const restored = await client.sessions.resume(original.id, {
        runtimeConfig: {
          sdkMcpServers: [{ name: "external", type: "remote", url: "https://example.test/mcp" }],
        },
      })
      await restored.close()
      await agent.resume(original.id)
      expect(mock.runtimeConfigs.get(original.id)?.sdkMcpServers).toEqual([])
    } finally {
      await agent.close()
      await client.close()
      await mock.stop()
    }
  })

  test("resume preserves every explicit empty or false policy override and clears callback descriptors", async () => {
    const empty = {
      agents: {},
      skills: [],
      commands: [],
      plugins: [],
      hooks: {},
      allowedTools: [],
      disallowedTools: [],
      settingSources: [],
      sdkMcpServers: [],
      checkpointing: {},
      compaction: {},
      canUseTool: false as const,
      instructions: "",
      appendSystemPrompt: "",
    }
    const expected = { ...empty, instructions: undefined, systemPrompt: "" }
    delete expected.instructions
    expect(normalizeRuntimeConfig(empty)).toEqual(expected)
    expect(normalizeRuntimeConfig({ hooks: { Stop: [] } })).toEqual({ hooks: { Stop: [] } })
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    try {
      const original = await client.sessions.create({
        runtimeConfig: {
          maxTurns: 4,
          hooks: { Stop: [() => ({ continue: true })] },
          canUseTool: () => ({ behavior: "allow" }),
        },
      })
      await original.close()
      expect(mock.runtimeConfigs.get(original.id)).toMatchObject({ canUseTool: true, hooks: { Stop: [{}] } })
      await client.sessions.resume(original.id, { runtimeConfig: empty })
      expect(mock.runtimeConfigs.get(original.id)).toMatchObject({ ...expected, maxTurns: 4 })
    } finally {
      await client.close()
      await mock.stop()
    }
  })

  test("facade resume reattaches callback descriptors without replacing stored defaults", async () => {
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const original = await client.sessions.create({
      runtimeConfig: { instructions: "Preserve", allowedTools: ["read"] },
    })
    await original.close()
    const agent = new Agent({
      client,
      tools: [defineTool({ name: "echo", inputJsonSchema: { type: "object" }, execute: () => "ok" })],
      hooks: { Stop: [() => ({ continue: true })] },
      canUseTool: () => ({ behavior: "allow" }),
    })
    try {
      const session = await agent.resume(original.id)
      expect(session.id).toBe(original.id)
      expect(mock.runtimeConfigs.get(original.id)).toMatchObject({
        systemPrompt: "Preserve",
        allowedTools: ["read"],
        canUseTool: true,
      })
      expect(mock.runtimeConfigs.get(original.id)?.sdkMcpServers).toMatchObject([
        { name: "sdk", type: "sdk", transport: "direct" },
      ])
    } finally {
      await agent.close()
      await client.close()
      await mock.stop()
    }
  })

  test("deleteSessionsOnClose deletes created sessions and keeps resumed sessions", async () => {
    const mock = await startMockServer()
    const client = await createAgentClient({ baseUrl: mock.baseUrl })
    const source = await client.sessions.create()
    await source.close()
    const agent = new Agent({ client, deleteSessionsOnClose: true })
    const created = await agent.createSession()
    await created.close()
    await agent.resume(source.id)
    await agent.close()
    expect(mock.sessions.has(created.id)).toBe(false)
    expect(mock.sessions.has(source.id)).toBe(true)
    await client.close()
    await mock.stop()
  })
})
