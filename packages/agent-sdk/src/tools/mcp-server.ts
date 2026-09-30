import { sdkError } from "../errors.js"
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { SdkMcpServer, ToolDefinition } from "../types.js"
import { validateMcpContent } from "./index.js"

export interface SdkMcpHost {
  name: string
  url: string
  stop(): Promise<void>
}

export interface RuntimeMcpServerSpec {
  name: string
  type: "remote"
  ownership: "sdk"
  url: string
  enabled: true
  oauth: false
}

type ProtocolConnection = {
  mcp: Server
  transport: StreamableHTTPServerTransport
  responses: Set<ServerResponse>
}

export async function startSdkMcpServers(
  servers: SdkMcpServer[] | undefined,
  input: { sessionId: string },
): Promise<{ hosts: SdkMcpHost[]; specs: RuntimeMcpServerSpec[] }> {
  if (!servers?.length) return { hosts: [], specs: [] }
  const hosts: SdkMcpHost[] = []
  try {
    for (const server of servers.filter((server) => server.enabled !== false))
      hosts.push(await startSdkMcpServer(server, input))
    return {
      hosts,
      specs: hosts.map((host) => ({
        name: host.name,
        type: "remote",
        ownership: "sdk",
        url: host.url,
        enabled: true,
        oauth: false,
      })),
    }
  } catch (error) {
    await stopSdkMcpHosts(hosts)
    throw error
  }
}

export async function stopSdkMcpHosts(hosts: SdkMcpHost[]): Promise<void> {
  await Promise.all(hosts.map((host) => host.stop().catch(() => {})))
}

async function startSdkMcpServer(server: SdkMcpServer, input: { sessionId: string }): Promise<SdkMcpHost> {
  validateMcpContent(server)
  const seen = new Set<string>()
  for (const tool of server.tools) {
    if (seen.has(tool.name))
      throw sdkError("configuration", `createSdkMcpServer(${server.name}): duplicate tool "${tool.name}"`)
    inputSchema(tool)
    seen.add(tool.name)
  }

  const abort = new AbortController()
  const sessions = new Map<string, ProtocolConnection>()
  // Include connections before initialization completes so owner shutdown also
  // closes slow, malformed, and disconnected initialization requests.
  const connections = new Set<ProtocolConnection>()

  function connect() {
    const mcp = protocolServer(server, input.sessionId, abort.signal)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        if (abort.signal.aborted) throw new Error("MCP host is closed")
        sessions.set(sessionId, connection)
      },
    })
    const connection = { mcp, transport, responses: new Set<ServerResponse>() }
    connections.add(connection)
    // Server.onclose is called by the transport on DELETE as well as by
    // Server.close(); do not retain terminated protocol sessions or their peers.
    mcp.onclose = () => {
      connections.delete(connection)
      if (transport.sessionId) sessions.delete(transport.sessionId)
      // MCP transport.close() aborts handlers but does not settle pending JSON
      // HTTP responses. End only this peer's requests; DELETE itself must still
      // receive the transport's successful termination response.
      for (const response of connection.responses) response.destroy()
      connection.responses.clear()
    }
    return connection
  }

  function dispatch(connection: ProtocolConnection, req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "DELETE") {
      connection.responses.add(res)
      res.once("close", () => connection.responses.delete(res))
    }
    return connection.transport.handleRequest(req, res)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (abort.signal.aborted) {
      res.writeHead(503)
      res.end()
      return
    }
    const sessionId = req.headers["mcp-session-id"]
    if (sessionId !== undefined) {
      const connection = typeof sessionId === "string" ? sessions.get(sessionId) : undefined
      if (!connection) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }))
        return
      }
      await dispatch(connection, req, res)
      return
    }
    const connection = connect()
    try {
      await connection.mcp.connect(connection.transport)
      // Let the MCP transport validate the method and unparsed body. Only a
      // successful initialize retains the new protocol session for later use.
      await dispatch(connection, req, res)
    } finally {
      if (!connection.transport.sessionId || abort.signal.aborted) await connection.mcp.close()
    }
  }

  // node:http keeps the host usable from plain Node as well as Bun. Every
  // protocol client gets an independent MCP Server/transport pair, while the
  // listener, descriptors and callback ownership belong to the SDK session.
  const http = createServer((req, res) => {
    // Pathname only: method rejection (405/406/415) is the transport's job, and
    // its answers are part of the MCP contract.
    //
    // Parsed by hand rather than with `new URL(req.url, base)`, which THROWS on
    // a request target node delivers verbatim: `GET //` arrives as `req.url ===
    // "//"`, and `new URL("//", base)` is a protocol-relative URL with an empty
    // host — `ERR_INVALID_URL`. That throw is synchronous inside the request
    // listener, so it becomes an uncaughtException, and this server runs inside
    // the SDK consumer's process: any local client could kill their
    // application with one malformed request line. Splitting on `?`/`#` cannot
    // throw and is sufficient for an exact-match route.
    const target = req.url ?? "/"
    const pathname = target.split("?")[0]!.split("#")[0]!
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("Not found")
      return
    }
    // Two arguments on purpose: the transport reads the body itself, so no
    // pre-parsing is needed outside body-parser middleware.
    //
    // The rejection MUST be handled. `Bun.serve` used to catch a rejected
    // `fetch` for us; a `node:http` request listener returns void and node
    // never inspects it, so an unhandled rejection here would reach the default
    // handler — and this server runs inside the SDK consumer's own process, so
    // that would take their application down over a failed tool call. The
    // transport's own error recovery can still throw if the socket died
    // mid-response.
    // Both halves must be caught. The async half was the one the previous round
    // guarded; the synchronous half is what `new URL` demonstrated.
    try {
      handle(req, res).catch(fail)
    } catch (error) {
      fail(error)
    }

    function fail(_error: unknown) {
      if (res.headersSent || res.destroyed) res.destroy()
      else {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" } }))
      }
    }
  })
  const port = await listen(http)
  let stopping: Promise<void> | undefined

  return {
    name: server.name,
    url: `http://127.0.0.1:${port}/mcp`,
    stop() {
      if (stopping) return stopping
      // Mark closed and cancel consumer callbacks before the first await. All
      // active AND pending protocol peers must close with their owning session.
      abort.abort()
      stopping = (async () => {
        http.closeAllConnections()
        await Promise.all([
          new Promise<void>((resolve) => http.close(() => resolve())),
          ...Array.from(connections, ({ mcp }) => mcp.close().catch(() => {})),
        ])
      })()
      return stopping
    },
  }
}

function protocolServer(server: SdkMcpServer, sessionId: string, signal: AbortSignal) {
  const mcp = new Server(
    { name: server.name, version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        ...(server.resources?.length ? { resources: {} } : {}),
        ...(server.prompts?.length ? { prompts: {} } : {}),
      },
    },
  )

  async function invoke<T>(
    extra: { signal: AbortSignal; requestId: string | number },
    callback: (context: { sessionId: string; signal: AbortSignal }) => T | Promise<T>,
  ): Promise<T> {
    const transport = mcp.transport
    const cancelled = () => {
      // MCP normally recommends no reply after cancellation. SDK 1.27.1's
      // JSON transport otherwise leaves the HTTP response and request maps
      // pending forever, including uncancelled requests in the same batch.
      // Settle only this request through the public transport API; a cancelling
      // client ignores the reply. Protocol already suppresses the handler's
      // later result when extra.signal is aborted, so no duplicate is sent.
      void transport
        ?.send({
          jsonrpc: "2.0",
          id: extra.requestId,
          error: { code: -32800, message: "Request cancelled" },
        })
        .catch(() => {})
    }
    if (extra.signal.aborted) {
      cancelled()
      throw new McpError(-32800, "Request cancelled")
    }
    extra.signal.addEventListener("abort", cancelled, { once: true })
    try {
      return await callback({ sessionId, signal: AbortSignal.any([signal, extra.signal]) })
    } finally {
      extra.signal.removeEventListener("abort", cancelled)
    }
  }

  if (server.resources?.length) {
    mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: server.resources!.map(({ read, ...resource }) => resource),
    }))
    mcp.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const resource = server.resources!.find((item) => item.uri === request.params.uri)
      if (!resource) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`)
      return invoke(extra, (context) => resource.read(context))
    })
  }
  if (server.prompts?.length) {
    mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: server.prompts!.map(({ get, ...prompt }) => prompt),
    }))
    mcp.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const prompt = server.prompts!.find((item) => item.name === request.params.name)
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`)
      const arguments_ = request.params.arguments ?? {}
      const missing = prompt.arguments?.find((item) => item.required && arguments_[item.name] === undefined)
      if (missing) throw new McpError(ErrorCode.InvalidParams, `Missing required argument: ${missing.name}`)
      return invoke(extra, (context) => prompt.get(arguments_, context))
    })
  }
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: server.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: inputSchema(tool),
      _meta: {
        ...(tool.metadata?.searchHint === undefined ? {} : { "cognitio/searchHint": tool.metadata.searchHint }),
        ...(tool.metadata?.alwaysLoad === undefined ? {} : { "cognitio/alwaysLoad": tool.metadata.alwaysLoad }),
      },
      annotations: {
        readOnlyHint: tool.annotations?.readOnly,
        destructiveHint: tool.annotations?.destructive,
        idempotentHint: tool.annotations?.idempotent,
        openWorldHint: tool.annotations?.openWorld,
      },
    })),
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = server.tools.find((item) => item.name === request.params.name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
      }
    }
    try {
      return toMcpResult(await invoke(extra, (context) => tool.execute(request.params.arguments ?? {}, context)))
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      }
    }
  })

  return mcp
}

function inputSchema(tool: ToolDefinition) {
  if (tool.inputJsonSchema !== undefined) return jsonObjectSchema(tool.name, tool.inputJsonSchema)
  if (isZodSchema(tool.inputSchema)) return z.toJSONSchema(tool.inputSchema)
  return jsonObjectSchema(tool.name, tool.inputSchema)
}

function jsonObjectSchema(name: string, input: unknown) {
  if (!!input && typeof input === "object" && (input as { type?: unknown }).type === "object") return input
  throw sdkError("configuration", `defineTool(${name}): input schema must be a JSON object schema or Zod`)
}

function isZodSchema(input: unknown): input is z.ZodType {
  return !!input && typeof input === "object" && "safeParse" in input
}

function toMcpResult(output: unknown) {
  if (isMcpContentResult(output)) return output
  if (typeof output === "string") return { content: [{ type: "text" as const, text: output }] }
  return {
    content: [{ type: "text" as const, text: output === undefined ? "" : (JSON.stringify(output) ?? String(output)) }],
  }
}

function isMcpContentResult(input: unknown): input is { content: Array<Record<string, unknown>> } {
  return !!input && typeof input === "object" && Array.isArray((input as { content?: unknown }).content)
}

/**
 * Binds an OS-assigned loopback port and reports it.
 *
 * This replaces a reserve-then-rebind helper that opened a socket, read its
 * port, closed it, and handed the number to a second listener — a TOCTOU window
 * in which anything could take the port. Listening directly and reading
 * `address()` has no such gap.
 */
async function listen(server: HttpServer) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      // Detached on success: a `once("error")` left attached would swallow the
      // server's next error instead of surfacing it.
      server.off("error", onError)
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(sdkError("configuration", "Failed to bind a local MCP port"))
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(0, "127.0.0.1")
  })
}
