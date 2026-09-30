#!/usr/bin/env node

import http from "node:http"

const [command, ...args] = process.argv.slice(2)

if (command !== "serve") {
  console.error(`unsupported fake cognitio command: ${command ?? "none"}`)
  process.exit(1)
}

const hostname = args.find((arg) => arg.startsWith("--hostname="))?.split("=")[1] ?? "127.0.0.1"
const requestedPort = Number(args.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? "4096")
// Additive env knobs; unset means the default behavior below is unchanged.
//   FAKE_READY_DELAY_MS: delay the readiness line by N ms
//   FAKE_SIGTERM_IGNORE: "1" → survive SIGTERM so only SIGKILL can end this process
//   FAKE_SERVER_VERSION: what GET /global/health reports; unset means "the
//     version this SDK expects", so a PATH-resolved fake passes the
//     post-readiness compatibility check exactly as a real binary would.
//     Setting it to anything else exercises the mismatch path.
const ignoreSigterm = process.env.FAKE_SIGTERM_IGNORE === "1"
// Keep in sync with EXPECTED_SERVER_VERSION; test/packaging.test.ts pins it.
const serverVersion = process.env.FAKE_SERVER_VERSION ?? "1.14.19+cognitio.runtime.4"
//   FAKE_HEALTH_DELAY_MS: hold /global/health open for N ms, so a test can abort
//     deterministically inside the post-readiness compatibility-check window.
const healthDelay = Number(process.env.FAKE_HEALTH_DELAY_MS ?? "0")
let sigtermCount = 0
const sessions = new Map()
const runtimeConfigs = new Map()
const pendingControlRequests = new Map()
const sseClients = new Set()
let nextSessionIndex = 1

function sessionPayload(id, directory) {
  return {
    id,
    slug: id,
    projectID: "proj-fake-spawn",
    directory,
    title: "fake",
    version: "0.0.0-fake",
    time: { created: 0, updated: 0 },
  }
}

function effectiveRuntimeConfig(config) {
  const plugins = Array.isArray(config.plugins) ? config.plugins.filter(isObject) : []
  const skills = [
    ...(Array.isArray(config.skills)
      ? config.skills
          .filter((skill) => isObject(skill) && typeof skill.name === "string")
          .map((skill) => ({ name: skill.name, source: "runtime" }))
      : []),
    ...plugins.flatMap((plugin) =>
      Array.isArray(plugin.skills)
        ? plugin.skills
            .filter((skill) => isObject(skill) && typeof skill.name === "string")
            .map((skill) => ({ name: `${plugin.name}:${skill.name}`, source: "plugin", pluginName: plugin.name }))
        : [],
    ),
  ]
  const commands = [
    ...(Array.isArray(config.commands)
      ? config.commands
          .filter((command) => isObject(command) && typeof command.name === "string")
          .map((command) => ({ name: command.name, source: "runtime" }))
      : []),
    ...(Array.isArray(config.skills)
      ? config.skills
          .filter((skill) => isObject(skill) && typeof skill.name === "string")
          .map((skill) => ({ name: skill.name, source: "skill" }))
      : []),
    ...plugins.flatMap((plugin) => [
      ...(Array.isArray(plugin.commands)
        ? plugin.commands
            .filter((command) => isObject(command) && typeof command.name === "string")
            .map((command) => ({ name: `${plugin.name}:${command.name}`, source: "plugin", pluginName: plugin.name }))
        : []),
      ...(Array.isArray(plugin.skills)
        ? plugin.skills
            .filter((skill) => isObject(skill) && typeof skill.name === "string")
            .map((skill) => ({ name: `${plugin.name}:${skill.name}`, source: "skill", pluginName: plugin.name }))
        : []),
    ]),
  ]
  const hookCounts = new Map()
  if (config.hooks && typeof config.hooks === "object") {
    Object.entries(config.hooks).forEach(([event, entries]) => {
      hookCounts.set(event, (hookCounts.get(event) ?? 0) + (Array.isArray(entries) ? entries.length : 0))
    })
  }
  plugins.forEach((plugin) => {
    if (!isObject(plugin.hooks)) return
    Object.entries(plugin.hooks).forEach(([event, entries]) => {
      hookCounts.set(event, (hookCounts.get(event) ?? 0) + (Array.isArray(entries) ? entries.length : 0))
    })
  })
  const systemPrompt =
    config.systemPrompt === undefined
      ? { mode: "default", hasAppend: hasSystemPromptAppend(config) }
      : typeof config.systemPrompt === "string"
        ? { mode: "custom", hasAppend: hasSystemPromptAppend(config) }
        : isObject(config.systemPrompt)
          ? {
              mode: "preset",
              preset: typeof config.systemPrompt.preset === "string" ? config.systemPrompt.preset : undefined,
              hasAppend: hasSystemPromptAppend(config),
            }
          : { mode: "default", hasAppend: hasSystemPromptAppend(config) }
  return {
    ...Object.fromEntries(
      ["model", "maxTurns", "maxBudgetUsd", "permissionMode", "autoPermissionClassifierModel"]
        .map((key) => [key, config[key]])
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
      source: plugin.type === "claude" ? "claude" : "inline",
      skillCount: Array.isArray(plugin.skills) ? plugin.skills.length : 0,
      commandCount: Array.isArray(plugin.commands) ? plugin.commands.length : 0,
      agentCount: isObject(plugin.agents) ? Object.keys(plugin.agents).length : 0,
      hookEventCount: isObject(plugin.hooks) ? Object.keys(plugin.hooks).length : 0,
      mcpServerCount: Array.isArray(plugin.mcpServers) ? plugin.mcpServers.length : 0,
    })),
  }
}

function hasSystemPromptAppend(config) {
  return (
    typeof config.appendSystemPrompt === "string" ||
    (isObject(config.systemPrompt) && typeof config.systemPrompt.append === "string")
  )
}

function respondJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function emit(event) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const res of sseClients) {
    res.write(chunk)
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve(body)
      }
    })
  })
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function isControlSubtype(value) {
  return ["can_use_tool", "hook_callback", "elicitation", "mcp_message"].includes(value)
}

function isControlResponseBody(value) {
  return isObject(value) && isUuid(value.requestID) && isControlSubtype(value.subtype) && isObject(value.response)
}

function isControlCancelBody(value) {
  return isObject(value) && isUuid(value.requestID) && isControlSubtype(value.subtype)
}

function requestMessageID(body) {
  return isObject(body) && typeof body.messageID === "string" ? body.messageID : undefined
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${hostname}:${requestedPort}`}`)
  const pathname = url.pathname

  if (pathname === "/event" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    sseClients.add(res)
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
    req.on("close", () => {
      sseClients.delete(res)
    })
    return
  }

  if (pathname === "/session" && req.method === "POST") {
    const directory = url.searchParams.get("directory") ?? `/fake/${nextSessionIndex}`
    const body = await readBody(req)
    const id = `sess-${nextSessionIndex++}`
    sessions.set(id, { id, directory })
    if (isObject(body) && isObject(body.runtimeConfig)) runtimeConfigs.set(id, body.runtimeConfig)
    respondJson(res, 200, sessionPayload(id, directory))
    return
  }

  if (pathname === "/session" && req.method === "GET") {
    respondJson(
      res,
      200,
      [...sessions.values()].map((session) => sessionPayload(session.id, session.directory)),
    )
    return
  }

  if (pathname === "/experimental/session" && req.method === "GET") {
    respondJson(
      res,
      200,
      [...sessions.values()].map((session) => sessionPayload(session.id, session.directory)),
    )
    return
  }

  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
  if (sessionMatch && req.method === "GET") {
    const sessionID = sessionMatch[1]
    const session = sessions.get(sessionID)
    if (!session) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    respondJson(res, 200, sessionPayload(session.id, session.directory))
    return
  }

  const childrenMatch = pathname.match(/^\/session\/([^/]+)\/children$/)
  if (childrenMatch && req.method === "GET") {
    respondJson(res, 200, [])
    return
  }

  const runtimeMcpScopesMatch = pathname.match(/^\/session\/([^/]+)\/runtime-config\/mcp-scopes$/)
  if (runtimeMcpScopesMatch && req.method === "DELETE") {
    const sessionID = runtimeMcpScopesMatch[1]
    if (!sessions.has(sessionID)) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    respondJson(res, 200, true)
    return
  }

  const runtimeConfigMatch = pathname.match(/^\/session\/([^/]+)\/runtime-config$/)
  if (runtimeConfigMatch) {
    const sessionID = runtimeConfigMatch[1]
    if (!sessions.has(sessionID)) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    if (req.method === "GET") {
      const runtimeConfig = runtimeConfigs.get(sessionID) ?? {}
      respondJson(res, 200, {
        sessionID,
        runtimeConfig,
        effective: effectiveRuntimeConfig(runtimeConfig),
      })
      return
    }
    if (req.method === "PATCH") {
      const body = await readBody(req)
      const runtimeConfig = { ...(runtimeConfigs.get(sessionID) ?? {}), ...body }
      runtimeConfigs.set(sessionID, runtimeConfig)
      respondJson(res, 200, runtimeConfig)
      return
    }
    if (req.method === "DELETE") {
      runtimeConfigs.delete(sessionID)
      respondJson(res, 200, true)
      return
    }
  }

  const promptMatch = pathname.match(/^\/session\/([^/]+)\/message$/)
  if (promptMatch && req.method === "POST") {
    await readBody(req)
    respondJson(res, 200, {
      info: { id: `assistant-${promptMatch[1]}` },
      parts: [],
    })
    return
  }

  const promptAsyncMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
  if (promptAsyncMatch && req.method === "POST") {
    const sessionID = promptAsyncMatch[1]
    const body = await readBody(req)
    setTimeout(() => {
      emit({
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID: "assistant-stream",
          partID: "part-1",
          field: "text",
          delta: "hello from fake cognitio",
        },
      })
    }, 10)
    setTimeout(() => {
      emit({
        type: "session.result",
        properties: {
          sessionID,
          parentMessageID: requestMessageID(body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
    }, 20)
    setTimeout(() => {
      emit({
        type: "session.idle",
        properties: { sessionID },
      })
    }, 25)
    res.writeHead(204)
    res.end()
    return
  }

  const commandMatch = pathname.match(/^\/session\/([^/]+)\/command$/)
  if (commandMatch && req.method === "POST") {
    const sessionID = commandMatch[1]
    const body = await readBody(req)
    setTimeout(() => {
      emit({
        type: "session.result",
        properties: {
          sessionID,
          parentMessageID: requestMessageID(body),
          subtype: "success",
          numTurns: 1,
          totalCostUsd: 0,
        },
      })
    }, 20)
    setTimeout(() => {
      emit({
        type: "session.idle",
        properties: { sessionID },
      })
    }, 25)
    res.writeHead(204)
    res.end()
    return
  }

  const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/)
  if (abortMatch && req.method === "POST") {
    respondJson(res, 200, true)
    return
  }

  const summarizeMatch = pathname.match(/^\/session\/([^/]+)\/summarize$/)
  if (summarizeMatch && req.method === "POST") {
    await readBody(req)
    const sessionID = summarizeMatch[1]
    setTimeout(() => {
      emit({
        type: "system.compact_boundary",
        properties: {
          sessionID,
          messageID: "assistant-compact",
          auto: false,
          overflow: false,
          trigger: "manual",
          preCompactTokenCount: 123,
          compactionId: "msg_compact",
          preservedMessageIds: ["msg_keep"],
        },
      })
    }, 10)
    respondJson(res, 200, true)
    return
  }

  const controlResponseMatch = pathname.match(/^\/session\/([^/]+)\/control-response$/)
  if (controlResponseMatch && req.method === "POST") {
    const sessionID = controlResponseMatch[1]
    const body = await readBody(req)
    if (!isControlResponseBody(body)) {
      respondJson(res, 400, { message: "invalid control response body" })
      return
    }
    if (!sessions.has(sessionID)) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    const pending = pendingControlRequests.get(body.requestID)
    const resolved = !!pending && pending.sessionID === sessionID && pending.subtype === body.subtype
    if (resolved) pendingControlRequests.delete(body.requestID)
    respondJson(res, 200, { resolved })
    return
  }

  const controlCancelMatch = pathname.match(/^\/session\/([^/]+)\/control-cancel$/)
  if (controlCancelMatch && req.method === "POST") {
    const sessionID = controlCancelMatch[1]
    const body = await readBody(req)
    if (!isControlCancelBody(body)) {
      respondJson(res, 400, { message: "invalid control cancel body" })
      return
    }
    if (!sessions.has(sessionID)) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    const pending = pendingControlRequests.get(body.requestID)
    const cancelled = !!pending && pending.sessionID === sessionID && pending.subtype === body.subtype
    if (cancelled) pendingControlRequests.delete(body.requestID)
    respondJson(res, 200, { cancelled })
    return
  }

  const controlListMatch = pathname.match(/^\/session\/([^/]+)\/control-requests$/)
  if (controlListMatch && req.method === "GET") {
    const sessionID = controlListMatch[1]
    if (!sessions.has(sessionID)) {
      respondJson(res, 404, { message: "not found" })
      return
    }
    respondJson(
      res,
      200,
      [...pendingControlRequests.values()].filter((request) => request.sessionID === sessionID),
    )
    return
  }

  // The post-readiness compatibility gate in the vendored server hits this
  // before any session work, for every implicitly-resolved binary.
  if (pathname === "/global/health" && req.method === "GET") {
    const answer = () => respondJson(res, 200, { healthy: true, version: serverVersion })
    if (healthDelay > 0) setTimeout(answer, healthDelay)
    else answer()
    return
  }

  if (pathname === "/debug/env" && req.method === "GET") {
    respondJson(res, 200, process.env)
    return
  }

  if (pathname === "/debug/pid" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(String(process.pid))
    return
  }

  // Lets a test wait for a delivered SIGTERM instead of sleeping, which is the
  // only observable proof that an awaitable teardown has actually started.
  if (pathname === "/debug/signals" && req.method === "GET") {
    respondJson(res, 200, { sigterm: sigtermCount })
    return
  }

  respondJson(res, 404, {
    message: `unhandled ${req.method ?? "GET"} ${pathname}`,
  })
})

// Without this, EADDRINUSE surfaces as an uncaught exception whose message
// buries the real cause under a node:events stack.
server.on("error", (error) => {
  console.error(`fake cognitio server failed to listen on ${hostname}:${requestedPort}: ${error.message}`)
  process.exit(1)
})

server.listen(requestedPort, hostname, () => {
  const address = server.address()
  const port = typeof address === "object" && address !== null && "port" in address ? address.port : requestedPort
  const announce = () => console.log(`agent server listening at http://${hostname}:${port}`)
  const readyDelay = Number(process.env.FAKE_READY_DELAY_MS ?? "0")
  if (readyDelay > 0) setTimeout(announce, readyDelay)
  else announce()
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (signal === "SIGTERM") sigtermCount += 1
    // A wedged child: SIGTERM stays observable through /debug/signals but is
    // never fatal, so only an awaitable SIGKILL escalation ends this process.
    if (signal === "SIGTERM" && ignoreSigterm) return
    server.close(() => process.exit(0))
  })
}
