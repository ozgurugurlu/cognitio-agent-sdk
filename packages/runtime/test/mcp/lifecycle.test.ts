import { test, expect, mock, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  tools: Array<{
    name: string
    description?: string
    inputSchema: object
    _meta?: Record<string, unknown>
    annotations?: Record<string, unknown>
  }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  // oxlint-disable-next-line no-useless-constructor
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Mock Client that delegates to per-name MockClientState
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any) {
      clientCreateCount++
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { GlobalBus } = await import("../../src/bus/global")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// --- Helper ---

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, never>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/cognitio.json`,
          JSON.stringify({
            $schema: "https://example.invalid/config.schema.json",
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(MCP.Service.use(fn).pipe(Effect.provide(MCP.defaultLayer)))
        // dispose instance to clean up state between tests
        await Instance.dispose()
      },
    })
  }
}

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "my-server"
      const serverState = getOrCreateClientState("my-server")
      serverState.tools = [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ]

      // First: add the server successfully
      const addResult = yield* mcp.add("my-server", {
        type: "local",
        command: ["echo", "test"],
      })
      expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

      expect(serverState.listToolsCalls).toBe(1)

      const toolsA = yield* mcp.tools()
      const toolsB = yield* mcp.tools()
      expect(Object.keys(toolsA).length).toBeGreaterThan(0)
      expect(Object.keys(toolsB).length).toBeGreaterThan(0)
      expect(serverState.listToolsCalls).toBe(1)
    }),
  ),
)

test(
  "runtime MCP tools are session-scoped and cached separately from global tools",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "runtime-server"
      const serverState = getOrCreateClientState("runtime-server")
      serverState.tools = [
        { name: "weather", description: "weather", inputSchema: { type: "object", properties: {} } },
      ]

      const globalTools = yield* mcp.tools()
      expect(Object.keys(globalTools).some((key) => key.includes("weather"))).toBe(false)

      const runtimeTools = yield* mcp.tools({
        sessionID: "ses_runtime" as any,
        servers: [
          {
            name: "runtime-server",
            type: "remote",
            url: "http://127.0.0.1:3000/mcp",
            oauth: false,
          },
        ],
      })
      expect(Object.keys(runtimeTools)).toContain("runtime-server_weather")
      expect(serverState.listToolsCalls).toBe(1)

      yield* mcp.tools({
        sessionID: "ses_runtime" as any,
        servers: [
          {
            name: "runtime-server",
            type: "remote",
            url: "http://127.0.0.1:3000/mcp",
            oauth: false,
          },
        ],
      })
      expect(serverState.listToolsCalls).toBe(1)
      expect(Object.keys(yield* mcp.tools()).some((key) => key.includes("weather"))).toBe(false)
    }),
  ),
)

test(
  "runtime MCP tools preserve generated ID case and metadata",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "MetaServer"
      const serverState = getOrCreateClientState("MetaServer")
      serverState.tools = [
        {
          name: "PinnedTool",
          description: "tool with metadata",
          inputSchema: { type: "object", properties: {} },
          _meta: {
            "cognitio/searchHint": "special search hint",
            "cognitio/alwaysLoad": true,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ]

      const tools = yield* mcp.tools({
        sessionID: "ses_meta" as any,
        servers: [
          {
            name: "MetaServer",
            type: "remote",
            url: "http://127.0.0.1:3000/mcp",
            oauth: false,
          },
        ],
      })
      expect(Object.keys(tools)).toEqual(["MetaServer_PinnedTool"])
      expect((tools["MetaServer_PinnedTool"] as any).metadata).toEqual({
        source: "mcp",
        searchHint: "special search hint",
        alwaysLoad: true,
        capabilityFlags: {
          readOnly: true,
          destructive: false,
          concurrencySafe: true,
          openWorld: false,
        },
      })
    }),
  ),
)

test(
  "direct SDK runtime MCP tools expose descriptors without remote clients",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools({
        sessionID: "ses_direct" as any,
        servers: [
          {
            name: "local",
            type: "sdk",
            transport: "direct",
            tools: [
              {
                name: "echo",
                description: "echo input",
                inputSchema: { type: "object", properties: { value: { type: "string" } } },
                metadata: { searchHint: "local echo", alwaysLoad: true },
                annotations: { readOnly: true, idempotent: true },
              },
            ],
          },
        ],
      })

      expect(clientCreateCount).toBe(0)
      expect(Object.keys(tools)).toEqual(["local_echo"])
      expect((tools["local_echo"] as any).metadata).toEqual({
        source: "mcp",
        searchHint: "local echo",
        alwaysLoad: true,
        capabilityFlags: {
          readOnly: true,
          destructive: undefined,
          concurrencySafe: true,
          openWorld: undefined,
        },
      })
    }),
  ),
)

test(
  "direct SDK runtime MCP tools publish invalidation when cleared",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const changed: string[] = []
      const listener = (event: { payload?: { type?: string; properties?: { server?: string } } }) => {
        if (event.payload?.type === "mcp.tools.changed" && event.payload.properties?.server) {
          changed.push(event.payload.properties.server)
        }
      }
      GlobalBus.on("event", listener)
      try {
        const sessionID = "ses_direct_invalidate" as any
        yield* mcp.syncRuntime(sessionID, [
          {
            name: "local",
            type: "sdk",
            transport: "direct",
            tools: [
              {
                name: "echo",
                description: "echo input",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        ])
        expect(changed).toContain("local")
        changed.length = 0

        yield* mcp.clearRuntime(sessionID)
        expect(changed).toContain("local")
        expect(
          Object.keys(
            yield* mcp.tools({
              sessionID,
              servers: [],
            }),
          ),
        ).not.toContain("local_echo")
      } finally {
        GlobalBus.off("event", listener)
      }
    }),
  ),
)

test(
  "tools() with an empty runtime server list closes existing runtime clients",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "runtime-cleanup"
      const serverState = getOrCreateClientState("runtime-cleanup")
      serverState.tools = [
        { name: "weather", description: "weather", inputSchema: { type: "object", properties: {} } },
      ]

      const sessionID = "ses_runtime_cleanup" as any
      expect(
        Object.keys(
          yield* mcp.tools({
            sessionID,
            servers: [
              {
                name: "runtime-cleanup",
                type: "remote",
                url: "http://127.0.0.1:3000/mcp",
                oauth: false,
              },
            ],
          }),
        ),
      ).toContain("runtime-cleanup_weather")
      expect(serverState.closed).toBe(false)

      const afterClear = yield* mcp.tools({ sessionID, servers: [] })
      expect(Object.keys(afterClear).some((key) => key.includes("weather"))).toBe(false)
      expect(serverState.closed).toBe(true)
    }),
  ),
)

test(
  "runtime MCP tools scoped to accepted snapshots survive live runtime sync",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "runtime-snapshot"
      const serverState = getOrCreateClientState("runtime-snapshot")
      serverState.tools = [
        { name: "weather", description: "weather", inputSchema: { type: "object", properties: {} } },
      ]

      const sessionID = "ses_runtime_snapshot" as any
      const servers = [
        {
          name: "runtime-snapshot",
          type: "remote" as const,
          url: "http://127.0.0.1:3000/mcp",
          oauth: false as const,
        },
      ]
      const tools = yield* mcp.tools({ sessionID, servers, scope: "accepted" })
      expect(Object.keys(tools)).toContain("runtime-snapshot_weather")
      expect(serverState.closed).toBe(false)

      yield* mcp.syncRuntime(sessionID, [])
      expect(serverState.closed).toBe(false)

      const again = yield* mcp.tools({ sessionID, servers, scope: "accepted" })
      expect(Object.keys(again)).toContain("runtime-snapshot_weather")
      expect(serverState.listToolsCalls).toBe(1)

      yield* mcp.clearRuntime(sessionID)
      expect(serverState.closed).toBe(true)
    }),
  ),
)

test(
  "clearRuntime closes session-owned runtime MCP clients",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "runtime-clear"
      const serverState = getOrCreateClientState("runtime-clear")

      yield* mcp.syncRuntime("ses_runtime_clear" as any, [
        {
          name: "runtime-clear",
          type: "remote",
          url: "http://127.0.0.1:3000/mcp",
          oauth: false,
        },
      ])
      expect(serverState.closed).toBe(false)

      yield* mcp.clearRuntime("ses_runtime_clear" as any)
      expect(serverState.closed).toBe(true)
    }),
  ),
)

test(
  "clearRuntimeScopes closes accepted-snapshot runtime MCP clients only",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const sessionID = "ses_runtime_scope_clear" as any
      lastCreatedClientName = "runtime-live"
      const liveState = getOrCreateClientState("runtime-live")
      liveState.tools = [
        { name: "weather", description: "weather", inputSchema: { type: "object", properties: {} } },
      ]
      yield* mcp.syncRuntime(sessionID, [
        {
          name: "runtime-live",
          type: "remote",
          url: "http://127.0.0.1:3000/live",
          oauth: false,
        },
      ])

      lastCreatedClientName = "runtime-scoped"
      const scopedState = getOrCreateClientState("runtime-scoped")
      scopedState.tools = [
        { name: "forecast", description: "forecast", inputSchema: { type: "object", properties: {} } },
      ]
      const scoped = yield* mcp.tools({
        sessionID,
        scope: "accepted",
        servers: [
          {
            name: "runtime-scoped",
            type: "remote",
            url: "http://127.0.0.1:3000/scoped",
            oauth: false,
          },
        ],
      })
      expect(Object.keys(scoped)).toContain("runtime-scoped_forecast")

      yield* mcp.clearRuntimeScopes(sessionID)

      expect(liveState.closed).toBe(false)
      expect(scopedState.closed).toBe(true)
    }),
  ),
)

// ========================================================================
// Test: tool change notifications refresh the cache
// ========================================================================

test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "status-server"
      const serverState = getOrCreateClientState("status-server")

      yield* mcp.add("status-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const before = yield* mcp.tools()
      expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
      expect(serverState.listToolsCalls).toBe(1)

      serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

      const handler = Array.from(serverState.notificationHandlers.values())[0]
      expect(handler).toBeDefined()
      yield* Effect.promise(() => handler?.())

      const after = yield* mcp.tools()
      expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
      expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
      expect(serverState.listToolsCalls).toBe(2)
    }),
  ),
)

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disc-server"
        getOrCreateClientState("disc-server")

        yield* mcp.add("disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const statusBefore = yield* mcp.status()
        expect(statusBefore["disc-server"]?.status).toBe("connected")

        yield* mcp.disconnect("disc-server")

        const statusAfter = yield* mcp.status()
        expect(statusAfter["disc-server"]?.status).toBe("disabled")

        // Tools should be empty after disconnect
        const tools = yield* mcp.tools()
        const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
        expect(serverTools.length).toBe(0)
      }),
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "reconn-server"
        const serverState = getOrCreateClientState("reconn-server")
        serverState.tools = [
          { name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("reconn-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("disabled")

        // Reconnect
        yield* mcp.connect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "replace-server"
      const firstState = getOrCreateClientState("replace-server")

      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(false)

      // Create new state for second client
      clientStates.delete("replace-server")
      const secondState = getOrCreateClientState("replace-server")

      // Re-add should close the first client
      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(true)
      expect(secondState.closed).toBe(false)
    }),
  ),
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        // Set up good server
        const goodState = getOrCreateClientState("good-server")
        goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

        // Set up bad server - will fail on listTools during create()
        const badState = getOrCreateClientState("bad-server")
        badState.listToolsShouldFail = true

        // Add good server first
        lastCreatedClientName = "good-server"
        yield* mcp.add("good-server", {
          type: "local",
          command: ["echo", "good"],
        })

        // Add bad server - should fail but not affect good server
        lastCreatedClientName = "bad-server"
        yield* mcp.add("bad-server", {
          type: "local",
          command: ["echo", "bad"],
        })

        const status = yield* mcp.status()
        expect(status["good-server"]?.status).toBe("connected")
        expect(status["bad-server"]?.status).toBe("failed")

        // Good server's tools should still be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        const countBefore = clientCreateCount

        yield* mcp.add("disabled-server", {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        } as any)

        // No client should have been created
        expect(clientCreateCount).toBe(countBefore)

        const status = yield* mcp.status()
        expect(status["disabled-server"]?.status).toBe("disabled")
      }),
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-server"
        const serverState = getOrCreateClientState("prompt-server")
        serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

        yield* mcp.add("prompt-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(1)
        const key = Object.keys(prompts)[0]
        expect(key).toContain("prompt-server")
        expect(key).toContain("my-prompt")
      }),
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-server"
        const serverState = getOrCreateClientState("resource-server")
        serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

        yield* mcp.add("resource-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const resources = yield* mcp.resources()
        expect(Object.keys(resources).length).toBe(1)
        const key = Object.keys(resources)[0]
        expect(key).toContain("resource-server")
        expect(key).toContain("my-resource")
      }),
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-disc-server"
        const serverState = getOrCreateClientState("prompt-disc-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

        yield* mcp.add("prompt-disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("prompt-disc-server")

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

test(
  "connect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      // Should not throw
      yield* mcp.connect("nonexistent")
      const status = yield* mcp.status()
      expect(status["nonexistent"]).toBeUndefined()
    }),
  ),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      yield* mcp.disconnect("nonexistent")
      // Should complete without error
    }),
  ),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools()
      expect(Object.keys(tools).length).toBe(0)
    }),
  ),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-connect"
        getOrCreateClientState("fail-connect")
        connectShouldFail = true
        connectError = "Connection refused"

        yield* mcp.add("fail-connect", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()
        expect(status["fail-connect"]?.status).toBe("failed")
        if (status["fail-connect"]?.status === "failed") {
          expect(status["fail-connect"].error).toContain("Connection refused")
        }

        // No tools should be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let rejected = false
  callbackPromise.then(() => {}).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my.special-server"
        const serverState = getOrCreateClientState("my.special-server")
        serverState.tools = [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("my.special-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)

        // Server name dots should be replaced with underscores
        expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
        // Tool name dots should be replaced with underscores
        expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
        expect(keys.length).toBe(2)
      }),
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-server"
      getOrCreateClientState("hanging-server")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-server", {
        type: "local",
        command: ["node", "fake.js"],
        timeout: 100,
      })

      const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      expect(serverStatus.error).toContain("timed out")
      // Transport must be closed to avoid orphaned child process
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-remote"
      getOrCreateClientState("hanging-remote")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 100,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Transport must be closed to avoid leaked HTTP connections
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "fail-remote"
      getOrCreateClientState("fail-remote")
      connectShouldFail = true
      connectError = "Connection refused"

      const addResult = yield* mcp.add("fail-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 5000,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Both StreamableHTTP and SSE transports should be closed
      expect(transportCloseCount).toBeGreaterThanOrEqual(2)
    }),
  ),
)
