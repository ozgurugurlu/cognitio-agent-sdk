import { expect, test } from "bun:test"
import { connect } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createSdkMcpServer, defineTool } from "../src/index.js"
import { startSdkMcpServers, stopSdkMcpHosts } from "../src/tools/mcp-server.js"

test("HTTP MCP clients have independent sessions and all belong to the SDK owner", async () => {
  const signals: AbortSignal[] = []
  const hosted = await startSdkMcpServers(
    [
      createSdkMcpServer({
        name: "shared-content",
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
            name: "guide",
            uri: "docs://guide",
            read: (context) => ({ contents: [{ uri: "docs://guide", text: context.sessionId }] }),
          },
        ],
        prompts: [
          {
            name: "review",
            get: (_, context) => ({ messages: [{ role: "user", content: { type: "text", text: context.sessionId } }] }),
          },
        ],
      }),
    ],
    { sessionId: "owner-session" },
  )
  const url = new URL(hosted.specs[0]!.url)
  const clients = [new Client({ name: "runtime", version: "1" }), new Client({ name: "consumer", version: "1" })]
  const transports = clients.map(() => new StreamableHTTPClientTransport(url))
  try {
    await clients[0]!.connect(transports[0]!)
    await clients[1]!.connect(transports[1]!)
    expect(transports[0]!.sessionId).toBeDefined()
    expect(transports[1]!.sessionId).toBeDefined()
    expect(transports[0]!.sessionId).not.toBe(transports[1]!.sessionId)
    for (const client of clients) {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["owner"])
      expect((await client.callTool({ name: "owner" })).content).toEqual([{ type: "text", text: "owner-session" }])
      expect((await client.listResources()).resources[0]?.uri).toBe("docs://guide")
      expect((await client.readResource({ uri: "docs://guide" })).contents[0]).toMatchObject({ text: "owner-session" })
      expect((await client.listPrompts()).prompts[0]?.name).toBe("review")
      expect((await client.getPrompt({ name: "review" })).messages[0]?.content).toEqual({
        type: "text",
        text: "owner-session",
      })
    }
    const terminated = transports[0]!.sessionId!
    await transports[0]!.terminateSession()
    const stale = await fetch(url, { headers: { "mcp-session-id": terminated, accept: "text/event-stream" } })
    expect(stale.status).toBe(404)
    expect((await clients[1]!.callTool({ name: "owner" })).content).toEqual([{ type: "text", text: "owner-session" }])
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    // Replacing the terminated peer must not revive or reuse its protocol ID.
    const replacement = new Client({ name: "replacement", version: "1" })
    clients.push(replacement)
    const transport = new StreamableHTTPClientTransport(url)
    await replacement.connect(transport)
    expect(transport.sessionId).not.toBe(terminated)
    await replacement.callTool({ name: "owner" })
    await Promise.all([hosted.hosts[0]!.stop(), hosted.hosts[0]!.stop()])
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await expect(fetch(url)).rejects.toThrow()
    await expect(clients[1]!.listTools()).rejects.toThrow()
    await expect(replacement.listTools()).rejects.toThrow()
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await stopSdkMcpHosts(hosted.hosts)
  }
})

test("owner close stops incomplete initialization and rejects missing protocol sessions", async () => {
  const hosted = await startSdkMcpServers([createSdkMcpServer({ name: "pending", tools: [] })], { sessionId: "owner" })
  const url = new URL(hosted.specs[0]!.url)
  const socket = connect({ host: url.hostname, port: Number(url.port) })
  try {
    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(missing.status).toBe(400)
    await new Promise<void>((resolve) => (socket.readyState === "open" ? resolve() : socket.once("connect", resolve)))
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\ncontent-type: application/json\r\ncontent-length: 999\r\n\r\n{"jsonrpc":`,
    )
    await Bun.sleep(20)
    await hosted.hosts[0]!.stop()
    await closed
    await expect(fetch(url)).rejects.toThrow()
  } finally {
    socket.destroy()
    await stopSdkMcpHosts(hosted.hosts)
  }
})

test("owner close aborts callbacks running in every independent MCP session", async () => {
  const entered = new Set<AbortSignal>()
  const aborted: string[] = []
  const ready = Promise.withResolvers<void>()
  let calls = 0
  const hosted = await startSdkMcpServers(
    [
      createSdkMcpServer({
        name: "pending-tools",
        tools: [
          defineTool({
            name: "wait",
            inputSchema: { type: "object" },
            execute: (_, context) =>
              new Promise<string>((resolve) => {
                entered.add(context.signal)
                context.signal.addEventListener(
                  "abort",
                  () => {
                    aborted.push(context.sessionId)
                    resolve("cancelled")
                  },
                  { once: true },
                )
                if (++calls === 2) ready.resolve()
              }),
          }),
        ],
      }),
    ],
    { sessionId: "owner-callbacks" },
  )
  const clients = [new Client({ name: "first", version: "1" }), new Client({ name: "second", version: "1" })]
  try {
    await Promise.all(
      clients.map((client) => client.connect(new StreamableHTTPClientTransport(new URL(hosted.specs[0]!.url)))),
    )
    const pending = clients.map((client) => client.callTool({ name: "wait" }).catch(() => undefined))
    await ready.promise
    expect([...entered].every((signal) => !signal.aborted)).toBe(true)
    await hosted.hosts[0]!.stop()
    await Promise.all(pending)
    expect(aborted).toEqual(["owner-callbacks", "owner-callbacks"])
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await stopSdkMcpHosts(hosted.hosts)
  }
})

for (const kind of ["tool", "resource", "prompt"] as const) {
  test.each(["cancel", "terminate"] as const)(
    `${kind} callback aborts on %s without stopping another MCP peer`,
    async (mode) => {
      const entered = Promise.withResolvers<AbortSignal>()
      const aborted = Promise.withResolvers<void>()
      const wait = (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          )
          entered.resolve(signal)
        })
      const hosted = await startSdkMcpServers(
        [
          createSdkMcpServer({
            name: "cancellable-content",
            tools: [
              defineTool({ name: "ping", inputSchema: { type: "object" }, execute: () => "pong" }),
              defineTool({
                name: "wait",
                inputSchema: { type: "object" },
                execute: async (_, context) => {
                  await wait(context.signal)
                  return "cancelled"
                },
              }),
            ],
            resources: [
              {
                name: "wait",
                uri: "docs://wait",
                read: async (context) => {
                  await wait(context.signal)
                  return { contents: [{ uri: "docs://wait", text: "cancelled" }] }
                },
              },
            ],
            prompts: [
              {
                name: "wait",
                get: async (_, context) => {
                  await wait(context.signal)
                  return { messages: [{ role: "user", content: { type: "text", text: "cancelled" } }] }
                },
              },
            ],
          }),
        ],
        { sessionId: "cancellable-owner" },
      )
      const clients = [new Client({ name: "cancelled", version: "1" }), new Client({ name: "survivor", version: "1" })]
      const httpFinished = Promise.withResolvers<number | undefined>()
      const transports = clients.map(
        () =>
          new StreamableHTTPClientTransport(new URL(hosted.specs[0]!.url), {
            fetch: async (input, init) => {
              const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
              const tracked = body?.params?.name === "wait" || body?.params?.uri === "docs://wait"
              try {
                const response = await fetch(input, init)
                if (tracked) httpFinished.resolve((await response.clone().json()).error?.code)
                return response
              } catch (error) {
                if (tracked) httpFinished.resolve(undefined)
                throw error
              }
            },
          }),
      )
      const request = new AbortController()
      try {
        await Promise.all(clients.map((client, index) => client.connect(transports[index]!)))
        const pending = (
          kind === "tool"
            ? clients[0]!.callTool({ name: "wait" }, undefined, { signal: request.signal })
            : kind === "resource"
              ? clients[0]!.readResource({ uri: "docs://wait" }, { signal: request.signal })
              : clients[0]!.getPrompt({ name: "wait" }, { signal: request.signal })
        ).catch(() => undefined)
        const signal = await entered.promise
        expect(signal.aborted).toBe(false)
        if (mode === "cancel") request.abort()
        if (mode === "terminate") await transports[0]!.terminateSession()
        await aborted.promise
        expect(signal.aborted).toBe(true)
        const code = await httpFinished.promise
        if (mode === "cancel") expect(code).toBe(-32800)
        expect((await clients[1]!.callTool({ name: "ping" })).content).toEqual([{ type: "text", text: "pong" }])
        if (mode === "cancel")
          expect((await clients[0]!.callTool({ name: "ping" })).content).toEqual([{ type: "text", text: "pong" }])
        await pending
      } finally {
        request.abort()
        await Promise.all(clients.map((client) => client.close()))
        await stopSdkMcpHosts(hosted.hosts)
      }
    },
  )
}

test("cancelling one batched MCP request settles its HTTP response without dropping another result", async () => {
  const entered = Promise.withResolvers<void>()
  const hosted = await startSdkMcpServers(
    [
      createSdkMcpServer({
        name: "batch",
        tools: [
          defineTool({ name: "ping", inputSchema: { type: "object" }, execute: () => "pong" }),
          defineTool({
            name: "wait",
            inputSchema: { type: "object" },
            execute: (_, context) =>
              new Promise<string>((resolve) => {
                context.signal.addEventListener("abort", () => resolve("ignored late result"), { once: true })
                entered.resolve()
              }),
          }),
        ],
      }),
    ],
    { sessionId: "batch-owner" },
  )
  const url = new URL(hosted.specs[0]!.url)
  const client = new Client({ name: "batch-client", version: "1" })
  const transport = new StreamableHTTPClientTransport(url)
  try {
    await client.connect(transport)
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": transport.sessionId!,
      "mcp-protocol-version": transport.protocolVersion!,
    }
    const pending = fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1001, method: "tools/call", params: { name: "wait" } },
        { jsonrpc: "2.0", id: 1002, method: "tools/call", params: { name: "ping" } },
      ]),
    })
    await entered.promise
    const cancelled = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1001 } }),
    })
    expect(cancelled.status).toBe(202)
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 1001, error: { code: -32800, message: "Request cancelled" } },
      { jsonrpc: "2.0", id: 1002, result: { content: [{ type: "text", text: "pong" }] } },
    ])
    expect((await client.callTool({ name: "ping" })).content).toEqual([{ type: "text", text: "pong" }])
  } finally {
    await client.close()
    await stopSdkMcpHosts(hosted.hosts)
  }
})
