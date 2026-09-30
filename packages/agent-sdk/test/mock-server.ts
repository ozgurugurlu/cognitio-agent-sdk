import type { Server } from "bun"
import { reserveLocalPort } from "./port.js"

export interface CapturedMessageRequest {
  sessionID: string
  directory?: string
  body: unknown
}

export interface CapturedPromptAsyncRequest {
  sessionID: string
  directory?: string
  body: unknown
}

export interface CapturedCommandRequest {
  sessionID: string
  directory?: string
  body: unknown
}

export interface CapturedAbortRequest {
  sessionID: string
  directory?: string
}

export interface CapturedSummarizeRequest {
  sessionID: string
  directory?: string
  body: Record<string, unknown>
}

export interface CapturedForkRequest {
  sessionID: string
  directory?: string
  messageID?: string
}

export interface CapturedControlResponseRequest {
  sessionID: string
  directory?: string
  body: {
    requestID: string
    subtype: string
    response: Record<string, unknown>
  }
}

export interface CapturedControlCancelRequest {
  sessionID: string
  directory?: string
  body: {
    requestID: string
    subtype: string
  }
}

export interface CapturedControlListRequest {
  sessionID: string
  directory?: string
}

export interface CapturedRuntimeConfigPatchRequest {
  sessionID: string
  directory?: string
  body: Record<string, unknown>
}

export interface CapturedSessionCreateRequest {
  directory?: string
  body: Record<string, unknown>
}

export interface CapturedSessionUpdateRequest {
  sessionID: string
  directory?: string
  body: Record<string, unknown>
}

export interface CapturedSessionDeleteRequest {
  sessionID: string
  directory?: string
}

export interface MockControlRequest {
  id: string
  sessionID: string
  subtype: "can_use_tool" | "hook_callback" | "elicitation" | "mcp_message"
  payload: Record<string, unknown>
  createdAt: number
  timeoutMs: number
}

export interface MockCognitioServer {
  readonly baseUrl: string
  readonly sessions: Map<string, MockSession>
  readonly checkpoints: Map<string, MockCheckpoint[]>
  readonly todos: Map<string, MockTodo[]>
  readonly transcripts: Map<string, Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>>
  readonly runtimeConfigs: Map<string, Record<string, unknown>>
  readonly capturedMessages: CapturedMessageRequest[]
  readonly capturedPromptAsync: CapturedPromptAsyncRequest[]
  readonly capturedCommands: CapturedCommandRequest[]
  readonly capturedAborts: CapturedAbortRequest[]
  readonly capturedSummaries: CapturedSummarizeRequest[]
  readonly capturedForks: CapturedForkRequest[]
  readonly capturedControlResponses: CapturedControlResponseRequest[]
  readonly capturedControlCancels: CapturedControlCancelRequest[]
  readonly capturedControlLists: CapturedControlListRequest[]
  readonly capturedRuntimeConfigPatches: CapturedRuntimeConfigPatchRequest[]
  readonly capturedSessionCreates: CapturedSessionCreateRequest[]
  readonly capturedSessionUpdates: CapturedSessionUpdateRequest[]
  readonly capturedSessionDeletes: CapturedSessionDeleteRequest[]
  readonly pendingControlRequests: Map<string, MockControlRequest>
  requests(): number
  sseConnections(): number
  sseAborts(): number
  sseRequests(): number
  emit(event: unknown): void
  addControlRequest(request: MockControlRequest): void
  closeSseConnections(): void
  skipNextConnected(): void
  setTodoDelay(ms: number): void
  setCreateHandler(handler: (req: CapturedSessionCreateRequest) => Promise<Response> | Response): void
  setMessageHandler(handler: (req: CapturedMessageRequest) => Promise<Response> | Response): void
  setPromptAsyncHandler(handler: (req: CapturedPromptAsyncRequest) => Promise<Response> | Response): void
  setCommandHandler(handler: (req: CapturedCommandRequest) => Promise<Response> | Response): void
  setSummarizeHandler(handler: (req: CapturedSummarizeRequest) => Promise<Response> | Response): void
  setRuntimeConfigPatchHandler(handler: (req: CapturedRuntimeConfigPatchRequest) => Promise<Response> | Response): void
  setAbortHandler(handler: (req: CapturedAbortRequest) => Promise<Response> | Response): void
  setForkHandler(handler: (req: CapturedForkRequest) => Promise<Response> | Response): void
  setControlListHandler(handler: (req: CapturedControlListRequest) => Promise<Response> | Response): void
  setControlResponseDelay(ms: number): void
  setEventCloseAfterConnected(enabled: boolean): void
  setEventFailure(enabled: boolean): void
  stop(): Promise<void>
}

export interface MockSession {
  id: string
  directory: string
  title: string
  tags: string[]
  parentID?: string
}

export interface MockCheckpoint {
  id: string
  sessionID: string
  messageID?: string
  label?: string
  source: "manual" | "auto"
  metadata?: Record<string, unknown>
  time: { created: number; updated: number }
}

export interface MockTodo {
  content: string
  status: string
  priority: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function isControlSubtype(value: unknown): value is MockControlRequest["subtype"] {
  return value === "can_use_tool" || value === "hook_callback" || value === "elicitation" || value === "mcp_message"
}

function isControlResponseBody(value: unknown): value is CapturedControlResponseRequest["body"] {
  return isRecord(value) && isUuid(value.requestID) && isControlSubtype(value.subtype) && isRecord(value.response)
}

function isControlCancelBody(value: unknown): value is CapturedControlCancelRequest["body"] {
  return isRecord(value) && isUuid(value.requestID) && isControlSubtype(value.subtype)
}

export function requestMessageID(body: unknown) {
  if (!body || typeof body !== "object") return
  const value = (body as { messageID?: unknown }).messageID
  return typeof value === "string" ? value : undefined
}

function hasSystemPromptAppend(config: Record<string, unknown>) {
  return (
    typeof config.appendSystemPrompt === "string" ||
    (isRecord(config.systemPrompt) && typeof config.systemPrompt.append === "string")
  )
}

export async function startMockServer(options?: { sendConnected?: boolean }): Promise<MockCognitioServer> {
  const port = await reserveLocalPort()
  const encoder = new TextEncoder()
  const sendConnected = options?.sendConnected ?? true
  const sessions = new Map<string, MockSession>()
  const checkpoints = new Map<string, MockCheckpoint[]>()
  const todos = new Map<string, MockTodo[]>()
  const transcripts = new Map<string, Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>>()
  const runtimeConfigs = new Map<string, Record<string, unknown>>()
  const capturedMessages: CapturedMessageRequest[] = []
  const capturedPromptAsync: CapturedPromptAsyncRequest[] = []
  const capturedCommands: CapturedCommandRequest[] = []
  const capturedAborts: CapturedAbortRequest[] = []
  const capturedSummaries: CapturedSummarizeRequest[] = []
  const capturedForks: CapturedForkRequest[] = []
  const capturedControlResponses: CapturedControlResponseRequest[] = []
  const capturedControlCancels: CapturedControlCancelRequest[] = []
  const capturedControlLists: CapturedControlListRequest[] = []
  const capturedRuntimeConfigPatches: CapturedRuntimeConfigPatchRequest[] = []
  const capturedSessionCreates: CapturedSessionCreateRequest[] = []
  const capturedSessionUpdates: CapturedSessionUpdateRequest[] = []
  const capturedSessionDeletes: CapturedSessionDeleteRequest[] = []
  const pendingControlRequests = new Map<string, MockControlRequest>()
  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let sseAbortCount = 0
  let sseRequestCount = 0
  let nextSessionIndex = 1
  let failEventConnections = false
  let closeEventConnectionsAfterConnected = false
  let controlResponseDelayMs = 0
  let skipNextConnectedEvent = false
  let todoDelayMs = 0
  let requestCount = 0

  let createHandler: ((req: CapturedSessionCreateRequest) => Promise<Response> | Response) | undefined
  let messageHandler: (req: CapturedMessageRequest) => Promise<Response> | Response = () =>
    Response.json({}, { status: 200 })
  let promptAsyncHandler: (req: CapturedPromptAsyncRequest) => Promise<Response> | Response = (req) => {
    setTimeout(() => {
      emit({
        type: "session.result",
        properties: {
          sessionID: req.sessionID,
          parentMessageID: requestMessageID(req.body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
      emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
    }, 5)
    return new Response(null, { status: 204 })
  }
  let commandHandler: (req: CapturedCommandRequest) => Promise<Response> | Response = (req) => {
    setTimeout(() => {
      emit({
        type: "session.result",
        properties: {
          sessionID: req.sessionID,
          parentMessageID: requestMessageID(req.body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
      emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
    }, 5)
    return new Response(null, { status: 204 })
  }
  let abortHandler: (req: CapturedAbortRequest) => Promise<Response> | Response = () =>
    Response.json(true, { status: 200 })
  let summarizeHandler: (req: CapturedSummarizeRequest) => Promise<Response> | Response = (req) => {
    setTimeout(() => {
      emit({
        type: "system.compact_boundary",
        properties: {
          sessionID: req.sessionID,
          messageID: "assistant-compact",
          auto: false,
          overflow: false,
          trigger: "manual",
          preCompactTokenCount: 123,
          compactionId: "msg_compact",
          preservedMessageIds: ["msg_keep"],
        },
      })
    }, 5)
    return Response.json(true, { status: 200 })
  }
  let runtimeConfigPatchHandler: (req: CapturedRuntimeConfigPatchRequest) => Promise<Response> | Response = (req) => {
    const runtimeConfig = { ...(runtimeConfigs.get(req.sessionID) ?? {}), ...req.body }
    runtimeConfigs.set(req.sessionID, runtimeConfig)
    return Response.json(runtimeConfig, { status: 200 })
  }
  let forkHandler: (req: CapturedForkRequest) => Promise<Response> | Response = (req) => {
    const directory = req.directory ?? sessions.get(req.sessionID)?.directory ?? `/mock/${nextSessionIndex}`
    const id = `sess-${nextSessionIndex++}`
    const source = sessions.get(req.sessionID)
    const session = {
      id,
      directory,
      title: source?.title ?? "mock",
      tags: source?.tags ?? [],
      parentID: req.sessionID,
    }
    sessions.set(id, session)
    return Response.json(sessionPayload(id, directory), { status: 200 })
  }
  let controlListHandler: (req: CapturedControlListRequest) => Promise<Response> | Response = (captured) => {
    if (!sessions.has(captured.sessionID)) {
      return Response.json({ message: "not found" }, { status: 404 })
    }
    return Response.json(
      [...pendingControlRequests.values()].filter((request) => request.sessionID === captured.sessionID),
      { status: 200 },
    )
  }

  function emit(event: unknown): void {
    const typed = event as { type?: string; properties?: MockControlRequest | { id?: string } }
    if (typed.type === "control.request" && typed.properties) {
      pendingControlRequests.set((typed.properties as MockControlRequest).id, typed.properties as MockControlRequest)
    }
    if (typed.type === "control.cancelled" && typed.properties?.id) {
      pendingControlRequests.delete(typed.properties.id)
    }
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const controller of sseControllers) {
      try {
        controller.enqueue(chunk)
      } catch {
        // controller already closed; ignore
      }
    }
  }

  function sessionPayload(id: string, directory: string) {
    const session = sessions.get(id)
    return {
      id,
      slug: id,
      projectID: "proj-mock",
      directory,
      parentID: session?.parentID,
      title: session?.title ?? "mock",
      tags: session?.tags ?? [],
      version: "0.0.0-mock",
      time: { created: 0, updated: 0 },
    }
  }

  function effectiveRuntimeConfig(config: Record<string, unknown>) {
    const plugins = Array.isArray(config.plugins)
      ? config.plugins.filter((plugin): plugin is Record<string, unknown> & { name: string } => {
          return isRecord(plugin) && typeof plugin.name === "string"
        })
      : []
    const skills = [
      ...(Array.isArray(config.skills)
        ? config.skills
            .filter((skill): skill is Record<string, unknown> & { name: string } => {
              return isRecord(skill) && typeof skill.name === "string"
            })
            .map((skill) => ({ name: skill.name, source: "runtime" as const }))
        : []),
      ...plugins.flatMap((plugin) =>
        Array.isArray(plugin.skills)
          ? plugin.skills
              .filter((skill): skill is Record<string, unknown> & { name: string } => {
                return isRecord(skill) && typeof skill.name === "string"
              })
              .map((skill) => ({
                name: `${plugin.name}:${skill.name}`,
                source: "plugin" as const,
                pluginName: plugin.name,
              }))
          : [],
      ),
    ]
    const commands = [
      ...(Array.isArray(config.commands)
        ? config.commands
            .filter((command): command is Record<string, unknown> & { name: string } => {
              return isRecord(command) && typeof command.name === "string"
            })
            .map((command) => ({ name: command.name, source: "runtime" as const }))
        : []),
      ...(Array.isArray(config.skills)
        ? config.skills
            .filter((skill): skill is Record<string, unknown> & { name: string } => {
              return isRecord(skill) && typeof skill.name === "string"
            })
            .map((skill) => ({ name: skill.name, source: "skill" as const }))
        : []),
      ...plugins.flatMap((plugin) => [
        ...(Array.isArray(plugin.commands)
          ? plugin.commands
              .filter((command): command is Record<string, unknown> & { name: string } => {
                return isRecord(command) && typeof command.name === "string"
              })
              .map((command) => ({
                name: `${plugin.name}:${command.name}`,
                source: "plugin" as const,
                pluginName: plugin.name,
              }))
          : []),
        ...(Array.isArray(plugin.skills)
          ? plugin.skills
              .filter((skill): skill is Record<string, unknown> & { name: string } => {
                return isRecord(skill) && typeof skill.name === "string"
              })
              .map((skill) => ({
                name: `${plugin.name}:${skill.name}`,
                source: "skill" as const,
                pluginName: plugin.name,
              }))
          : []),
      ]),
    ]
    const hookCounts = new Map<string, number>()
    if (isRecord(config.hooks)) {
      Object.entries(config.hooks).forEach(([event, entries]) => {
        hookCounts.set(event, (hookCounts.get(event) ?? 0) + (Array.isArray(entries) ? entries.length : 0))
      })
    }
    plugins.forEach((plugin) => {
      if (!isRecord(plugin.hooks)) return
      Object.entries(plugin.hooks).forEach(([event, entries]) => {
        hookCounts.set(event, (hookCounts.get(event) ?? 0) + (Array.isArray(entries) ? entries.length : 0))
      })
    })
    const systemPrompt =
      config.systemPrompt === undefined
        ? { mode: "default" as const, hasAppend: hasSystemPromptAppend(config) }
        : typeof config.systemPrompt === "string"
          ? { mode: "custom" as const, hasAppend: hasSystemPromptAppend(config) }
          : isRecord(config.systemPrompt)
            ? {
                mode: "preset" as const,
                preset: typeof config.systemPrompt.preset === "string" ? config.systemPrompt.preset : undefined,
                hasAppend: hasSystemPromptAppend(config),
              }
            : { mode: "default" as const, hasAppend: hasSystemPromptAppend(config) }
    return {
      ...Object.fromEntries(
        ["model", "maxTurns", "maxBudgetUsd", "permissionMode", "autoPermissionClassifierModel"]
          .map((key) => [key, config[key]] as const)
          .filter((entry) => entry[1] !== undefined),
      ),
      systemPrompt,
      ...(typeof config.appendSystemPrompt === "string"
        ? { appendSystemPrompt: { length: config.appendSystemPrompt.length } }
        : {}),
      settingSources: Array.isArray(config.settingSources) ? config.settingSources : ["user", "project", "local"],
      ...(typeof config.canUseTool === "boolean" ? { canUseTool: { registered: config.canUseTool } } : {}),
      ...(hookCounts.size
        ? {
            hooks: Object.fromEntries([...hookCounts].map(([event, count]) => [event, { count }])),
          }
        : {}),
      tools: {
        allowed: Array.isArray(config.allowedTools) ? config.allowedTools : [],
        disallowed: Array.isArray(config.disallowedTools) ? config.disallowedTools : [],
      },
      skills,
      commands,
      plugins: plugins.map((plugin) => ({
        name: plugin.name,
        source: plugin.type === "claude" ? ("claude" as const) : ("inline" as const),
        skillCount: Array.isArray(plugin.skills) ? plugin.skills.length : 0,
        commandCount: Array.isArray(plugin.commands) ? plugin.commands.length : 0,
        agentCount: isRecord(plugin.agents) ? Object.keys(plugin.agents).length : 0,
        hookEventCount: isRecord(plugin.hooks) ? Object.keys(plugin.hooks).length : 0,
        mcpServerCount: Array.isArray(plugin.mcpServers) ? plugin.mcpServers.length : 0,
      })),
    }
  }

  async function readBody(req: Request): Promise<unknown> {
    const text = await req.text()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  const server: Server<undefined> = Bun.serve({
    // Bun 1.3.11 intermittently fails `Bun.serve({ port: 0 })` in tests.
    // Reserve a free local port first so the harness stays deterministic.
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      requestCount++
      const url = new URL(req.url)
      const pathname = url.pathname

      if (pathname === "/event" && req.method === "GET") {
        sseRequestCount++
        if (failEventConnections) {
          return Response.json({ message: "event stream unavailable" }, { status: 503 })
        }
        const shouldSendConnected = sendConnected && !skipNextConnectedEvent
        skipNextConnectedEvent = false
        let cleanup = () => {}
        let cleaned = false
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseControllers.add(controller)
            if (shouldSendConnected) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`),
              )
            }
            cleanup = () => {
              if (cleaned) return
              cleaned = true
              sseAbortCount++
              sseControllers.delete(controller)
              try {
                controller.close()
              } catch {
                // already closed
              }
            }
            if (req.signal.aborted) cleanup()
            else req.signal.addEventListener("abort", cleanup, { once: true })
            if (shouldSendConnected && closeEventConnectionsAfterConnected) {
              queueMicrotask(cleanup)
            }
          },
          cancel() {
            cleanup()
          },
        })
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        })
      }

      if (pathname === "/session" && req.method === "POST") {
        const directory = url.searchParams.get("directory") ?? `/mock/${nextSessionIndex}`
        const raw = await readBody(req)
        const body = isRecord(raw) ? raw : {}
        const captured: CapturedSessionCreateRequest = {
          directory: url.searchParams.get("directory") ?? undefined,
          body,
        }
        capturedSessionCreates.push(captured)
        if (createHandler) return createHandler(captured)
        const id = `sess-${nextSessionIndex++}`
        const session = {
          id,
          directory,
          title: typeof body.title === "string" ? body.title : "mock",
          tags: [],
          ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
        }
        sessions.set(id, session)
        if (isRecord(body.runtimeConfig)) runtimeConfigs.set(id, body.runtimeConfig)
        return Response.json(sessionPayload(id, directory), { status: 200 })
      }

      if (pathname === "/session" && req.method === "GET") {
        const directory = url.searchParams.get("directory")
        const tag = url.searchParams.get("tag")
        const roots = url.searchParams.get("roots") === "true"
        const search = url.searchParams.get("search")
        const limit = Number(url.searchParams.get("limit") ?? "0")
        const list = [...sessions.values()]
          .filter((s) => !directory || s.directory === directory)
          .filter((s) => !tag || s.tags.includes(tag))
          .filter((s) => !roots || !s.parentID)
          .filter((s) => !search || s.title.includes(search))
          .slice(0, limit > 0 ? limit : undefined)
          .map((s) => sessionPayload(s.id, s.directory))
        return Response.json(list, { status: 200 })
      }

      if (pathname === "/experimental/session" && req.method === "GET") {
        const directory = url.searchParams.get("directory")
        const tag = url.searchParams.get("tag")
        const roots = url.searchParams.get("roots") === "true"
        const limit = Number(url.searchParams.get("limit") ?? "0")
        const list = [...sessions.values()]
          .filter((s) => !directory || s.directory === directory)
          .filter((s) => !tag || s.tags.includes(tag))
          .filter((s) => !roots || !s.parentID)
          .slice(0, limit > 0 ? limit : undefined)
          .map((s) => ({ ...sessionPayload(s.id, s.directory), project: null }))
        return Response.json(list, { status: 200 })
      }

      const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
      if (sessionMatch && req.method === "GET") {
        const sessionID = sessionMatch[1]!
        const session = sessions.get(sessionID)
        const directory = url.searchParams.get("directory") ?? undefined
        if (!session || (directory && directory !== session.directory)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        return Response.json(sessionPayload(session.id, session.directory), { status: 200 })
      }
      if (sessionMatch && req.method === "PATCH") {
        const sessionID = sessionMatch[1]!
        const session = sessions.get(sessionID)
        const directory = url.searchParams.get("directory") ?? undefined
        if (!session || (directory && directory !== session.directory)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        const body = await readBody(req)
        if (!isRecord(body)) return Response.json({ message: "invalid session update" }, { status: 400 })
        capturedSessionUpdates.push({ sessionID, directory, body })
        if (typeof body.title === "string") session.title = body.title
        if (Array.isArray(body.tags)) session.tags = body.tags.filter((tag): tag is string => typeof tag === "string")
        return Response.json(sessionPayload(session.id, session.directory), { status: 200 })
      }
      if (sessionMatch && req.method === "DELETE") {
        const sessionID = sessionMatch[1]!
        const session = sessions.get(sessionID)
        const directory = url.searchParams.get("directory") ?? undefined
        capturedSessionDeletes.push({ sessionID, directory })
        if (!session || (directory && directory !== session.directory)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        sessions.delete(sessionID)
        runtimeConfigs.delete(sessionID)
        checkpoints.delete(sessionID)
        todos.delete(sessionID)
        transcripts.delete(sessionID)
        for (const request of [...pendingControlRequests.values()]) {
          if (request.sessionID === sessionID) pendingControlRequests.delete(request.id)
        }
        return Response.json(true, { status: 200 })
      }

      const runtimeMcpScopesMatch = pathname.match(/^\/session\/([^/]+)\/runtime-config\/mcp-scopes$/)
      if (runtimeMcpScopesMatch && req.method === "DELETE") {
        const sessionID = runtimeMcpScopesMatch[1]!
        if (!sessions.has(sessionID)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        return Response.json(true, { status: 200 })
      }

      const runtimeConfigMatch = pathname.match(/^\/session\/([^/]+)\/runtime-config$/)
      if (runtimeConfigMatch) {
        const sessionID = runtimeConfigMatch[1]!
        if (!sessions.has(sessionID)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        if (req.method === "GET") {
          const runtimeConfig = runtimeConfigs.get(sessionID) ?? {}
          return Response.json(
            {
              sessionID,
              runtimeConfig,
              effective: effectiveRuntimeConfig(runtimeConfig),
            },
            { status: 200 },
          )
        }
        if (req.method === "PATCH") {
          const body = await readBody(req)
          if (!isRecord(body)) return Response.json({ message: "invalid runtime config" }, { status: 400 })
          const captured: CapturedRuntimeConfigPatchRequest = {
            sessionID,
            directory: url.searchParams.get("directory") ?? undefined,
            body,
          }
          capturedRuntimeConfigPatches.push(captured)
          return runtimeConfigPatchHandler(captured)
        }
        if (req.method === "DELETE") {
          runtimeConfigs.delete(sessionID)
          return Response.json(true, { status: 200 })
        }
      }

      const messageMatch = pathname.match(/^\/session\/([^/]+)\/message$/)
      if (messageMatch && req.method === "POST") {
        const sessionID = messageMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        const captured: CapturedMessageRequest = { sessionID, directory, body }
        capturedMessages.push(captured)
        return messageHandler(captured)
      }

      const promptAsyncMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
      if (promptAsyncMatch && req.method === "POST") {
        const sessionID = promptAsyncMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        const captured: CapturedPromptAsyncRequest = { sessionID, directory, body }
        capturedPromptAsync.push(captured)
        return promptAsyncHandler(captured)
      }

      const commandMatch = pathname.match(/^\/session\/([^/]+)\/command$/)
      if (commandMatch && req.method === "POST") {
        const sessionID = commandMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        const captured: CapturedCommandRequest = { sessionID, directory, body }
        capturedCommands.push(captured)
        return commandHandler(captured)
      }

      if (messageMatch && req.method === "GET") {
        const sessionID = messageMatch[1]!
        return Response.json(transcripts.get(sessionID) ?? [], { status: 200 })
      }

      const todoMatch = pathname.match(/^\/session\/([^/]+)\/todo$/)
      if (todoMatch && req.method === "GET") {
        const sessionID = todoMatch[1]!
        if (todoDelayMs > 0) await sleep(todoDelayMs)
        return Response.json(todos.get(sessionID) ?? [], { status: 200 })
      }

      const checkpointMatch = pathname.match(/^\/session\/([^/]+)\/checkpoint$/)
      if (checkpointMatch && req.method === "POST") {
        const sessionID = checkpointMatch[1]!
        const body = await readBody(req)
        const now = Date.now()
        const checkpoint: MockCheckpoint = {
          id: `chk_${now}${(checkpoints.get(sessionID)?.length ?? 0) + 1}`,
          sessionID,
          ...(isRecord(body) && typeof body.messageID === "string" ? { messageID: body.messageID } : {}),
          ...(isRecord(body) && typeof body.label === "string" ? { label: body.label } : {}),
          source: "manual",
          time: { created: now, updated: now },
        }
        checkpoints.set(sessionID, [...(checkpoints.get(sessionID) ?? []), checkpoint])
        return Response.json(checkpoint, { status: 200 })
      }

      const checkpointsMatch = pathname.match(/^\/session\/([^/]+)\/checkpoints$/)
      if (checkpointsMatch && req.method === "GET") {
        return Response.json(checkpoints.get(checkpointsMatch[1]!) ?? [], { status: 200 })
      }

      const rewindMatch = pathname.match(/^\/session\/([^/]+)\/rewind$/)
      if (rewindMatch && req.method === "POST") {
        const sessionID = rewindMatch[1]!
        const body = await readBody(req)
        const checkpointID = isRecord(body) && typeof body.checkpointID === "string" ? body.checkpointID : "chk_missing"
        return Response.json({
          checkpointID,
          affectedFiles: [`${sessions.get(sessionID)?.directory ?? "/mock"}/file.txt`],
        })
      }

      const forkMatch = pathname.match(/^\/session\/([^/]+)\/fork$/)
      if (forkMatch && req.method === "POST") {
        const sessionID = forkMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = (await readBody(req)) as { messageID?: string }
        const captured: CapturedForkRequest = {
          sessionID,
          directory,
          messageID: body?.messageID,
        }
        capturedForks.push(captured)
        return forkHandler(captured)
      }

      const childrenMatch = pathname.match(/^\/session\/([^/]+)\/children$/)
      if (childrenMatch && req.method === "GET") {
        return Response.json(Array.from(sessions.values()).filter((session) => session.parentID === childrenMatch[1]))
      }

      const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/)
      if (abortMatch && req.method === "POST") {
        const sessionID = abortMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const captured: CapturedAbortRequest = { sessionID, directory }
        capturedAborts.push(captured)
        return abortHandler(captured)
      }

      const summarizeMatch = pathname.match(/^\/session\/([^/]+)\/summarize$/)
      if (summarizeMatch && req.method === "POST") {
        const sessionID = summarizeMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        if (!isRecord(body)) return Response.json({ message: "invalid summarize body" }, { status: 400 })
        const captured: CapturedSummarizeRequest = { sessionID, directory, body }
        capturedSummaries.push(captured)
        return summarizeHandler(captured)
      }

      const controlResponseMatch = pathname.match(/^\/session\/([^/]+)\/control-response$/)
      if (controlResponseMatch && req.method === "POST") {
        const sessionID = controlResponseMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        if (!isControlResponseBody(body)) {
          return Response.json({ message: "invalid control response body" }, { status: 400 })
        }
        if (!sessions.has(sessionID)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        if (controlResponseDelayMs > 0) await sleep(controlResponseDelayMs)
        const captured: CapturedControlResponseRequest = { sessionID, directory, body }
        capturedControlResponses.push(captured)
        const pending = pendingControlRequests.get(body.requestID)
        const resolved = !!pending && pending.sessionID === sessionID && pending.subtype === body.subtype
        if (resolved) pendingControlRequests.delete(body.requestID)
        return Response.json({ resolved }, { status: 200 })
      }

      const controlCancelMatch = pathname.match(/^\/session\/([^/]+)\/control-cancel$/)
      if (controlCancelMatch && req.method === "POST") {
        const sessionID = controlCancelMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const body = await readBody(req)
        if (!isControlCancelBody(body)) {
          return Response.json({ message: "invalid control cancel body" }, { status: 400 })
        }
        if (!sessions.has(sessionID)) {
          return Response.json({ message: "not found" }, { status: 404 })
        }
        const captured: CapturedControlCancelRequest = { sessionID, directory, body }
        capturedControlCancels.push(captured)
        const pending = pendingControlRequests.get(body.requestID)
        const cancelled = !!pending && pending.sessionID === sessionID && pending.subtype === body.subtype
        if (cancelled) pendingControlRequests.delete(body.requestID)
        return Response.json({ cancelled }, { status: 200 })
      }

      const controlListMatch = pathname.match(/^\/session\/([^/]+)\/control-requests$/)
      if (controlListMatch && req.method === "GET") {
        const sessionID = controlListMatch[1]!
        const directory = url.searchParams.get("directory") ?? undefined
        const captured: CapturedControlListRequest = { sessionID, directory }
        capturedControlLists.push(captured)
        return controlListHandler(captured)
      }

      return new Response(`unhandled ${req.method} ${pathname}`, { status: 404 })
    },
  })

  const baseUrl = `http://${server.hostname}:${server.port}`

  return {
    baseUrl,
    sessions,
    checkpoints,
    todos,
    transcripts,
    runtimeConfigs,
    capturedMessages,
    capturedPromptAsync,
    capturedCommands,
    capturedAborts,
    capturedSummaries,
    capturedForks,
    capturedControlResponses,
    capturedControlCancels,
    capturedControlLists,
    capturedRuntimeConfigPatches,
    capturedSessionCreates,
    capturedSessionUpdates,
    capturedSessionDeletes,
    pendingControlRequests,
    requests: () => requestCount,
    sseConnections: () => sseControllers.size,
    sseAborts: () => sseAbortCount,
    sseRequests: () => sseRequestCount,
    emit,
    addControlRequest: (request) => {
      pendingControlRequests.set(request.id, request)
    },
    closeSseConnections: () => {
      for (const controller of sseControllers) {
        try {
          controller.close()
        } catch {
          // ignore
        }
      }
      sseControllers.clear()
    },
    skipNextConnected: () => {
      skipNextConnectedEvent = true
    },
    setTodoDelay: (ms) => {
      todoDelayMs = ms
    },
    setCreateHandler: (h) => {
      createHandler = h
    },
    setMessageHandler: (h) => {
      messageHandler = h
    },
    setPromptAsyncHandler: (h) => {
      promptAsyncHandler = h
    },
    setCommandHandler: (h) => {
      commandHandler = h
    },
    setSummarizeHandler: (h) => {
      summarizeHandler = h
    },
    setRuntimeConfigPatchHandler: (h) => {
      runtimeConfigPatchHandler = h
    },
    setAbortHandler: (h) => {
      abortHandler = h
    },
    setForkHandler: (h) => {
      forkHandler = h
    },
    setControlListHandler: (h) => {
      controlListHandler = h
    },
    setControlResponseDelay: (ms) => {
      controlResponseDelayMs = ms
    },
    setEventCloseAfterConnected: (enabled) => {
      closeEventConnectionsAfterConnected = enabled
    },
    setEventFailure: (enabled) => {
      failEventConnections = enabled
    },
    async stop() {
      for (const controller of sseControllers) {
        try {
          controller.close()
        } catch {
          // ignore
        }
      }
      sseControllers.clear()
      await Promise.race([server.stop(true), new Promise((resolve) => setTimeout(resolve, 250))])
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for promise")), ms))
}

export async function waitFor<T>(read: () => T | undefined, attempts = 50): Promise<T> {
  const value = read()
  if (value !== undefined) return value
  if (attempts === 0) throw new Error("timed out waiting for condition")
  await sleep(10)
  return waitFor(read, attempts - 1)
}
