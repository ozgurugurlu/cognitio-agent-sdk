import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  Agent,
  NEUTRAL_BASE_PROMPT,
  createAgentClient,
  createSdkMcpServer,
  defineAgent,
  defineCommand,
  defineOutputFormat,
  definePlugin,
  defineSkill,
  defineTool,
  query,
  shutdown,
} from "../src/index.js"
import type { AgentMessage, AgentStream, QueryOptions, ResultMessage } from "../src/index.js"
import { clientState } from "../src/internal/shared-client.js"
import { FACADE_DEFAULT_DISALLOWED_TOOLS } from "../src/internal/default-profile.js"
import { requestMessageID, sleep, startMockServer, waitFor, type MockCognitioServer } from "./mock-server.js"

/** Answer every turn with one text delta plus a matching terminal result. */
function answerWithText(mock: MockCognitioServer, text: string): void {
  mock.setPromptAsyncHandler((req) => {
    const messageID = `assistant-${req.sessionID}`
    setTimeout(() => {
      mock.emit({
        type: "message.part.delta",
        properties: {
          sessionID: req.sessionID,
          messageID,
          partID: `text-${messageID}`,
          field: "text",
          delta: text,
        },
      })
      mock.emit({
        type: "session.result",
        properties: {
          sessionID: req.sessionID,
          messageID,
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
}

/**
 * Yield one observable event and then leave the turn open, so a consumer can
 * break out of or interrupt a turn that has not produced its result yet.
 */
function answerWithOpenTurn(mock: MockCognitioServer): void {
  mock.setPromptAsyncHandler((req) => {
    setTimeout(() => {
      mock.emit({
        type: "task.started",
        properties: {
          sessionID: req.sessionID,
          activeSessionID: req.sessionID,
          taskID: "call_open",
          messageID: `assistant-${req.sessionID}`,
          partID: "prt_open",
          tool: "bash",
          agent: "build",
        },
      })
    }, 5)
    return new Response(null, { status: 204 })
  })
}

/** Turn a server-side abort into the terminal `error_aborted` result. */
function abortWithResult(mock: MockCognitioServer): void {
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
}

async function collect(stream: AgentStream): Promise<{ messages: AgentMessage[]; terminal: ResultMessage }> {
  const messages: AgentMessage[] = []
  let next = await stream.next()
  while (!next.done) {
    messages.push(next.value)
    next = await stream.next()
  }
  if (!next.value) throw new Error("Agent stream ended without a terminal result")
  return { messages, terminal: next.value }
}

function drain(stream: AgentStream): Promise<ResultMessage> {
  return collect(stream).then((collected) => collected.terminal)
}

/** Capture a rejection reason without `try`/`catch`; a sync throw still fails the test. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

function runtimeConfigOf(mock: MockCognitioServer, index = 0): Record<string, unknown> {
  const captured = mock.capturedSessionCreates[index]
  if (!captured) throw new Error(`no session.create captured at index ${index}`)
  return captured.body.runtimeConfig as Record<string, unknown>
}

/** Mirrors smoke.test.ts: replay the descriptors the server stored for an event. */
function hookDescriptors(mock: MockCognitioServer, sessionId: string, event: string): unknown {
  const hooks = mock.runtimeConfigs.get(sessionId)?.hooks
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return
  return (hooks as Record<string, unknown>)[event]
}

function sseIdle(mock: MockCognitioServer): Promise<true> {
  return waitFor(() => (mock.sseConnections() === 0 ? true : undefined))
}

function seedSession(mock: MockCognitioServer, id: string, directory: string): void {
  mock.sessions.set(id, { id, directory, title: "seed", tags: [] })
}

describe("Agent facade against a mock server", () => {
  let mock: MockCognitioServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    await shutdown()
    expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })
    await mock.stop()
    mock = undefined as never
  })

  // A turn that reached a result has already been billed, so teardown must not
  // be able to throw the answer away. Session close now surfaces SDK-MCP
  // cleanup failures instead of swallowing them, and the stream finishes before
  // handing over the terminal envelope — so without the guard in
  // `settleAfterResult` a failed cleanup PATCH replaces a perfectly good result.
  test("a delivered result survives a teardown failure, which stays observable on the handle", async () => {
    answerWithText(mock, "delivered")
    const noop = defineTool({ name: "noop", inputJsonSchema: { type: "object" }, execute: () => "ok" })
    const failing = () => Response.json({ message: "cleanup failed" }, { status: 500 })

    const agent = new Agent({ baseUrl: mock.baseUrl, tools: [noop] })
    mock.setRuntimeConfigPatchHandler(failing)

    const result = await agent.run("Answer please")
    expect(result.text).toBe("delivered")
    expect(result.isError).toBe(false)
    // Teardown really did run and really did fail.
    expect(mock.capturedRuntimeConfigPatches.length).toBeGreaterThan(0)

    // Same failure on a handle the caller kept: the result is delivered, and
    // `close()` still reports what went wrong.
    const stream = agent.stream("Answer again")
    expect(await drain(stream)).toMatchObject({ text: "delivered", subtype: "success" })
    expect(String(await rejection(stream.close()))).toMatch(/cleanup failed/)

    await rejection(agent.close())
  })

  test("query() drains one shot and exposes text on the envelope, the result, and the return value", async () => {
    answerWithText(mock, "four")

    const stream = query({ prompt: "What is 2+2?", options: { baseUrl: mock.baseUrl } })
    const { messages, terminal } = await collect(stream)

    const envelopes = messages.filter((message) => message.type === "result")
    expect(envelopes).toHaveLength(1)
    const envelope = envelopes[0]!
    expect(envelope.text).toBe("four")
    expect(envelope.text).toBe(envelope.result.text)
    expect(envelope.result.subtype).toBe("success")
    expect(terminal.text).toBe("four")
    expect(terminal.sessionId).toBe(envelope.result.sessionId)
    expect(mock.capturedSessionCreates).toHaveLength(1)
  })

  test("agent.run() returns the terminal text and creates a session matching the default profile", async () => {
    answerWithText(mock, "summary")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const result = await agent.run("Summarize the repository\nsecond line is dropped")

    expect(result.text).toBe("summary")
    expect(result.isError).toBe(false)
    expect(result.subtype).toBe("success")

    expect(mock.capturedSessionCreates).toHaveLength(1)
    // D10: an explicit, non-default title derived from the prompt's first line.
    expect(mock.capturedSessionCreates[0]!.body.title).toBe("Summarize the repository")
    const runtimeConfig = runtimeConfigOf(mock)
    expect(runtimeConfig.settingSources).toEqual([])
    expect(runtimeConfig.disallowedTools).toEqual(FACADE_DEFAULT_DISALLOWED_TOOLS)
    // The facade profile itself never sets systemPrompt (D5); the low-level
    // client's create-time defaults inject the neutral base prompt, so the
    // create body on the wire does carry it.
    expect(runtimeConfig.systemPrompt).toBe(NEUTRAL_BASE_PROMPT)

    await agent.close()
  })

  test("sequential run() calls share one client and allocate one fresh session each", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const ids: string[] = []
    for (const index of [0, 1, 2]) {
      const result = await agent.run(`turn ${index}`)
      ids.push(result.sessionId)
      // Each transient session releases its dispatcher before the next one starts.
      await sseIdle(mock)
      expect(clientState().dedicated).toBe(1)
    }

    expect(new Set(ids).size).toBe(3)
    expect(mock.capturedSessionCreates).toHaveLength(3)

    await agent.close()
    expect(clientState().dedicated).toBe(0)
  })

  test("every entry point refuses work after agent.close(), and run() rejects rather than throwing", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    await agent.run("warm up")
    await agent.close()

    expect(() => agent.stream("late")).toThrow(/Agent is closed/)
    const reason = await rejection(agent.run("late"))
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toMatch(/Agent is closed/)
    await expect(agent.run("late")).rejects.toThrow(/Agent is closed/)
    await expect(agent.createSession()).rejects.toThrow(/Agent is closed/)
    await expect(agent.resume("sess-1")).rejects.toThrow(/Agent is closed/)
    await expect(agent.client()).rejects.toThrow(/Agent is closed/)
  })

  test("concurrent run() calls complete on distinct sessions with no in-flight guard error", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const [first, second] = await Promise.all([agent.run("alpha"), agent.run("beta")])

    expect(first.subtype).toBe("success")
    expect(second.subtype).toBe("success")
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(mock.capturedSessionCreates).toHaveLength(2)
    expect(clientState().dedicated).toBe(1)

    await agent.close()
  })

  test("breaking out of a stream aborts the turn, drops the SSE, and closes the transient session", async () => {
    answerWithOpenTurn(mock)

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("stop early")
    const sessionId = await stream.sessionId()
    const abortsBefore = mock.sseAborts()

    for await (const message of stream) {
      if (message.type === "task.started") break
    }

    await sseIdle(mock)
    expect(mock.sseAborts()).toBeGreaterThan(abortsBefore)
    const aborted = await waitFor(() =>
      mock.capturedAborts.some((request) => request.sessionID === sessionId) ? true : undefined,
    )
    expect(aborted).toBe(true)
    await expect(stream.sessionId()).rejects.toThrow(/Agent stream is closed/)

    await agent.close()
  })

  test("interrupt() ends the active turn with error_aborted and a second interrupt is a no-op", async () => {
    answerWithOpenTurn(mock)
    abortWithResult(mock)

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("long running")
    const collected = collect(stream)
    await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))

    await stream.interrupt()
    const { terminal } = await collected
    expect(terminal.subtype).toBe("error_aborted")
    expect(mock.capturedAborts).toHaveLength(1)

    await stream.interrupt()
    expect(mock.capturedAborts).toHaveLength(1)

    await agent.close()
  })

  // The two plan documents look like they disagree about streaming input:
  // WP7 says `interrupt()` only ends the active turn and a later turn may still
  // run, while the tests row says "turn 2 never sent". Both hold, for different
  // controls — `interrupt()` is turn-scoped, an `AbortSignal` is query-scoped.
  // These two tests pin that distinction so neither can drift.
  test("interrupt() on a streaming-input query ends only the active turn and the next turn still runs", async () => {
    abortWithResult(mock)
    mock.setPromptAsyncHandler((req) => {
      // Leave turn 1 open so the interrupt has something to cancel; answer
      // turn 2 normally so the query can finish.
      if (mock.capturedPromptAsync.length > 1) {
        const messageID = `assistant-second-${req.sessionID}`
        setTimeout(() => {
          mock.emit({
            type: "session.result",
            properties: {
              sessionID: req.sessionID,
              messageID,
              parentMessageID: requestMessageID(req.body),
              subtype: "success",
              numTurns: 1,
              totalCostUsd: 0,
            },
          })
          mock.emit({ type: "session.idle", properties: { sessionID: req.sessionID } })
        }, 5)
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 204 })
    })

    let reachedSecondYield = false
    const prompt = (async function* () {
      yield "turn one"
      reachedSecondYield = true
      yield "turn two"
    })()

    const stream = query({ prompt, options: { baseUrl: mock.baseUrl } })
    const collected = collect(stream)
    await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))
    await stream.interrupt()

    const { messages, terminal } = await collected
    const subtypes = messages.flatMap((message) => (message.type === "result" ? [message.result.subtype] : []))
    expect(subtypes).toEqual(["error_aborted", "success"])
    expect(terminal.subtype).toBe("success")
    expect(mock.capturedPromptAsync).toHaveLength(2)
    expect(mock.capturedAborts).toHaveLength(1)
    expect(reachedSecondYield).toBe(true)
  })

  test("aborting the signal on a streaming-input query ends the query, so turn 2 is never sent", async () => {
    answerWithOpenTurn(mock)
    abortWithResult(mock)

    let reachedSecondYield = false
    const prompt = (async function* () {
      yield "turn one"
      reachedSecondYield = true
      yield "turn two"
    })()

    const controller = new AbortController()
    const stream = query({ prompt, options: { baseUrl: mock.baseUrl, signal: controller.signal } })
    const collected = collect(stream)
    await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))
    controller.abort()

    const { terminal } = await collected
    expect(terminal.subtype).toBe("error_aborted")
    expect(mock.capturedPromptAsync).toHaveLength(1)
    expect(mock.capturedAborts).toHaveLength(1)
    expect(reachedSecondYield).toBe(false)
    await sseIdle(mock)
  })

  test("sessionId() starts the stream lazily and creates exactly one session", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("lazy start")
    expect(mock.capturedSessionCreates).toHaveLength(0)

    const sessionId = await stream.sessionId()
    expect(mock.capturedSessionCreates).toHaveLength(1)
    expect(mock.sessions.has(sessionId)).toBe(true)
    expect(await stream.sessionId()).toBe(sessionId)
    expect(mock.capturedSessionCreates).toHaveLength(1)

    await stream.close()
    await agent.close()
  })

  test("a failing session create rejects both sessionId() and next() without an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    mock.setCreateHandler(() => Response.json({ message: "create refused" }, { status: 500 }))

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("doomed")
    const viaSessionId = rejection(stream.sessionId())
    const viaNext = rejection(stream.next())
    const [sessionIdReason, nextReason] = await Promise.all([viaSessionId, viaNext])

    expect(sessionIdReason).toBeInstanceOf(Error)
    expect((sessionIdReason as Error).message).toMatch(/Failed to create session/)
    expect(nextReason).toBeInstanceOf(Error)
    expect((nextReason as Error).message).toMatch(/Failed to create session/)

    await agent.close()
    // Give the loop a real turn so a stray rejection would have been reported.
    await sleep(20)
    process.off("unhandledRejection", onUnhandled)
    expect(unhandled).toEqual([])
  })

  test("closing a never-iterated stream allocates neither a session nor a client", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("never consumed")

    await stream.close()

    expect(mock.capturedSessionCreates).toHaveLength(0)
    expect(clientState().dedicated).toBe(0)
    await agent.close()
  })

  test("agent.close() reclaims a started stream that nobody finished", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("abandoned")
    await stream.sessionId()
    await waitFor(() => (mock.sseConnections() >= 1 ? true : undefined))

    await agent.close()

    await sseIdle(mock)
    await expect(stream.next()).resolves.toMatchObject({ done: true })
  })

  test("run(prompt, {signal}) aborts the active turn and resolves with a terminal abort result", async () => {
    answerWithOpenTurn(mock)
    abortWithResult(mock)

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const controller = new AbortController()
    const running = agent.run("long running", { signal: controller.signal })
    await waitFor(() => (mock.capturedPromptAsync.length === 1 ? true : undefined))

    controller.abort()
    const result = await running

    expect(result.subtype).toBe("error_aborted")
    expect(result.isError).toBe(true)
    expect(mock.capturedAborts).toHaveLength(1)

    await agent.close()
  })

  test("an injected client survives agent.close() while a dedicated client is closed with it", async () => {
    answerWithText(mock, "ok")

    const borrowed = await createAgentClient({ baseUrl: mock.baseUrl })
    const borrowing = new Agent({ client: borrowed })
    expect((await borrowing.run("borrowed")).text).toBe("ok")
    await borrowing.close()

    const survivor = await borrowed.sessions.create({ title: "still answering" })
    expect(survivor.id).toBeTruthy()
    await survivor.close()

    const owning = new Agent({ baseUrl: mock.baseUrl })
    const dedicated = await owning.client()
    expect((await owning.run("dedicated")).text).toBe("ok")
    await owning.close()

    await expect(dedicated.sessions.create({ title: "too late" })).rejects.toThrow(/client is closed/)
    await borrowed.close()
  })

  test("tools are published as one direct SDK MCP server named sdk in the create body", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({
      baseUrl: mock.baseUrl,
      tools: [
        defineTool({
          name: "echo",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
          execute: (input: { value: string }) => ({ echoed: input.value }),
        }),
      ],
    })
    await agent.run("use the tool")

    const servers = runtimeConfigOf(mock).sdkMcpServers as Array<Record<string, unknown>>
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ name: "sdk", type: "sdk", transport: "direct" })
    expect((servers[0]!.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["echo"])

    await agent.close()
  })

  test("createSession() creates one session with the default profile and the no-prompt default title", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession()

    expect(mock.capturedSessionCreates).toHaveLength(1)
    // D10: createSession() has no prompt to derive a title from, so
    // deriveAgentTitle falls back to its documented default rather than letting
    // the server generate one.
    expect(mock.capturedSessionCreates[0]!.body.title).toBe("Agent session")
    expect(mock.sessions.get(session.id)?.title).toBe("Agent session")
    const runtimeConfig = runtimeConfigOf(mock)
    expect(runtimeConfig.settingSources).toEqual([])
    expect(runtimeConfig.disallowedTools).toEqual(FACADE_DEFAULT_DISALLOWED_TOOLS)
    expect(runtimeConfig.systemPrompt).toBe(NEUTRAL_BASE_PROMPT)

    await agent.close()
  })

  test("createSession({title}) wins over the default title", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession({ title: "Release review" })

    expect(mock.capturedSessionCreates[0]!.body.title).toBe("Release review")
    expect(mock.sessions.get(session.id)?.title).toBe("Release review")

    await agent.close()
  })

  test("a createSession() handle serves several turns on one session id, unlike run()", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession()

    const first = await session.send("first turn")
    const second = await session.send("second turn")
    const streamed: AgentMessage[] = []
    for await (const message of session.stream("third turn")) streamed.push(message)

    expect([first.sessionId, second.sessionId]).toEqual([session.id, session.id])
    expect(streamed.flatMap((message) => (message.type === "result" ? [message.result.sessionId] : []))).toEqual([
      session.id,
    ])
    // The whole point versus run(): three turns, one server session.
    expect(mock.capturedSessionCreates).toHaveLength(1)
    expect(mock.capturedPromptAsync.map((request) => request.sessionID)).toEqual([session.id, session.id, session.id])

    await agent.close()
  })

  test("createSession({parentId}) forwards the parent to the create request", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession({ parentId: "sess-parent" })

    expect(mock.capturedSessionCreates[0]!.body.parentID).toBe("sess-parent")
    expect(mock.sessions.get(session.id)?.parentID).toBe("sess-parent")

    await agent.close()
  })

  test("createSession() puts cwd on the create request's directory and model/permissionMode in runtime config", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession({
      cwd: "/mock/session-cwd",
      model: "anthropic/claude-sonnet-4-5",
      permissionMode: "dontAsk",
    })

    // cwd rides the create request's `directory`, not its body (D-P13-5: never
    // ClientOptions.directory, so one server still serves several cwds).
    expect(mock.capturedSessionCreates[0]!.directory).toBe("/mock/session-cwd")
    expect(session.directory).toBe("/mock/session-cwd")
    expect(runtimeConfigOf(mock)).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      permissionMode: "dontAsk",
    })

    await agent.close()
  })

  test("agent.close() closes a session handed out by createSession()", async () => {
    answerWithText(mock, "ok")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.createSession()
    expect((await session.send("before close")).subtype).toBe("success")

    await agent.close()

    await expect(session.send("after close")).rejects.toThrow(/is closed/)
  })

  test("stream setModel and setPermissionMode patch the live session, then refuse once it completes", async () => {
    answerWithOpenTurn(mock)

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const stream = agent.stream("mid-stream controls")
    const sessionId = await stream.sessionId()
    expect(await stream.next()).toMatchObject({ done: false, value: { type: "task.started" } })

    await stream.setModel("anthropic/claude-sonnet-4-5")
    await stream.setPermissionMode("dontAsk")

    expect(mock.capturedRuntimeConfigPatches.map((patch) => [patch.sessionID, patch.body])).toEqual([
      [sessionId, { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } }],
      [sessionId, { permissionMode: "dontAsk" }],
    ])

    // Close the open turn so the stream reaches its terminal result.
    mock.emit({
      type: "session.result",
      properties: {
        sessionID: sessionId,
        messageID: `assistant-${sessionId}`,
        parentMessageID: requestMessageID(mock.capturedPromptAsync[0]!.body),
        subtype: "success",
        numTurns: 1,
        totalCostUsd: 0,
      },
    })
    mock.emit({ type: "session.idle", properties: { sessionID: sessionId } })
    expect((await drain(stream)).subtype).toBe("success")

    // WP7: the two setters throw after completion, while sessionId() reports the
    // same closed-stream error it reports after an early break.
    await expect(stream.setModel("anthropic/claude-haiku-4-5")).rejects.toThrow(/Agent stream is closed/)
    await expect(stream.setPermissionMode("plan")).rejects.toThrow(/Agent stream is closed/)
    await expect(stream.sessionId()).rejects.toThrow(/Agent stream is closed/)
    // Guards, not late writes: nothing further reached the server.
    expect(mock.capturedRuntimeConfigPatches).toHaveLength(2)
    await expect(stream.next()).resolves.toMatchObject({ done: true, value: { subtype: "success" } })

    await agent.close()
  })
})

describe("binary resolution reaches the facade, and never the remote transport", () => {
  let mock: MockCognitioServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    await shutdown().catch(() => {})
    await mock.stop()
  })

  test("a remote transport resolves no binary and never calls spawnProcess", async () => {
    // A baseUrl consumer must never touch the resolution chain — no
    // require.resolve, no PATH lookup, and above all no child process.
    let spawned = 0
    const client = await createAgentClient({
      baseUrl: mock.baseUrl,
      spawn: {
        binaryPath: "/definitely/not/a/real/binary",
        spawnProcess() {
          spawned += 1
          throw new Error("the remote transport must not spawn")
        },
      },
    })
    try {
      expect(client.transportKind).toBe("remote")
      expect(client.baseUrl).toBe(mock.baseUrl)
      const session = await client.sessions.create({})
      await session.close()
      expect(spawned).toBe(0)
    } finally {
      await client.close()
    }
  })

  test("binaryPath and spawnProcess reach the spawner through createAgentClient, Agent, and query", async () => {
    const seen: Array<{ command: string; args: string[] }> = []
    // One spawner, reused by all three entry points, so identity through the
    // option merge is asserted too: an option bag that copies callbacks would
    // still work, but one that drops or re-wraps them would not.
    const spawnProcess = (request: { command: string; args: string[] }) => {
      seen.push({ command: request.command, args: request.args })
      throw new Error("stop here: the request is what is under test")
    }
    // Any real executable will do — spawnProcess throws before it is run. The
    // resolver rejects a non-executable path, which is itself the point: an
    // explicit choice that cannot work is a caller error, not a fallback.
    const binaryPath = process.execPath

    await expect(createAgentClient({ spawn: { binaryPath, spawnProcess } })).rejects.toThrow("stop here")
    await expect(new Agent({ spawn: { binaryPath, spawnProcess } }).run("hi")).rejects.toThrow("stop here")
    const handle = query({ prompt: "hi", options: { spawn: { binaryPath, spawnProcess } } })
    await expect(handle.next()).rejects.toThrow("stop here")

    expect(seen).toHaveLength(3)
    for (const request of seen) {
      // `binaryPath` won resolution — the bare name never reached the spawner.
      expect(request.command).toBe(binaryPath)
      expect(request.args[0]).toBe("serve")
    }
  })
})

describe("Agent facade resume and fork contract", () => {
  let mock: MockCognitioServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    await shutdown()
    expect(clientState()).toEqual({ canonical: false, dedicated: 0, pending: 0, settling: false })
    await mock.stop()
    mock = undefined as never
  })

  test("a second query() with resume reaches the first query's session without a second create", async () => {
    answerWithText(mock, "ok")

    const first = await drain(query({ prompt: "first", options: { baseUrl: mock.baseUrl } }))
    const second = await drain(query({ prompt: "second", options: { resume: first.sessionId, baseUrl: mock.baseUrl } }))

    expect(second.sessionId).toBe(first.sessionId)
    expect(mock.capturedSessionCreates).toHaveLength(1)
    expect(mock.capturedPromptAsync.map((request) => request.sessionID)).toEqual([first.sessionId, first.sessionId])
  })

  test("resume applies model, permissionMode, and title after attaching", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")
    answerWithText(mock, "resumed")

    const terminal = await drain(
      query({
        prompt: "continue the review",
        options: {
          baseUrl: mock.baseUrl,
          resume: "sess-seed",
          model: "anthropic/claude-sonnet-4-5",
          permissionMode: "dontAsk",
          title: "Resumed review",
        },
      }),
    )

    expect(terminal.sessionId).toBe("sess-seed")
    expect(mock.capturedSessionCreates).toHaveLength(0)
    expect(mock.capturedSessionUpdates).toHaveLength(1)
    expect(mock.capturedSessionUpdates[0]).toMatchObject({
      sessionID: "sess-seed",
      body: { title: "Resumed review" },
    })
    expect(mock.sessions.get("sess-seed")?.title).toBe("Resumed review")

    const patches = mock.capturedRuntimeConfigPatches
    expect(patches.every((patch) => patch.sessionID === "sess-seed")).toBe(true)
    expect(patches.map((patch) => patch.body)).toContainEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      permissionMode: "dontAsk",
    })
  })

  test("resume rejects working-directory changes synchronously", () => {
    for (const field of ["cwd", "directory"] as const) {
      expect(() =>
        query({ prompt: "continue", options: { [field]: "/tmp/new", resume: "sess-seed", baseUrl: mock.baseUrl } }),
      ).toThrow(new RegExp(`Cannot apply "${field}" when resuming`))
    }
    expect(mock.requests()).toBe(0)
  })

  test("forkSession applies the neutral profile, and hooks and SDK tools run on the fork", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")
    answerWithText(mock, "forked answer")
    let hookToolCallId: string | undefined

    const stream = query({
      prompt: "retry another way",
      options: {
        baseUrl: mock.baseUrl,
        resume: "sess-seed",
        forkSession: true,
        forkMessageId: "msg_boundary",
        hooks: {
          PreToolUse: [
            {
              matcher: /bash/,
              callback: (payload) => {
                hookToolCallId = payload.toolCallId
                return { permissionDecision: "allow" }
              },
            },
          ],
        },
        tools: [
          defineTool({
            name: "echo",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            execute: (input: { value: string }) => ({ echoed: input.value }),
          }),
        ],
      },
    })
    const forkId = await stream.sessionId()

    expect(mock.capturedSessionCreates).toHaveLength(0)
    expect(mock.capturedForks).toHaveLength(1)
    expect(mock.capturedForks[0]).toMatchObject({ sessionID: "sess-seed", messageID: "msg_boundary" })
    expect(forkId).not.toBe("sess-seed")

    // The server stores no runtimeConfig for a fork, so the facade profile
    // lands as an explicit runtime-config PATCH on the new session id.
    const patch = mock.capturedRuntimeConfigPatches.find((request) => request.sessionID === forkId)
    expect(patch).toBeDefined()
    expect(patch!.body).toMatchObject({
      systemPrompt: NEUTRAL_BASE_PROMPT,
      settingSources: [],
      disallowedTools: FACADE_DEFAULT_DISALLOWED_TOOLS,
      sdkMcpServers: [{ name: "sdk", type: "sdk", transport: "direct" }],
    })
    expect(mock.capturedSessionUpdates).toMatchObject([{ sessionID: forkId, body: { title: "retry another way" } }])

    const hookRequestID = crypto.randomUUID()
    mock.emit({
      type: "control.request",
      properties: {
        id: hookRequestID,
        sessionID: forkId,
        subtype: "hook_callback",
        payload: {
          event: "PreToolUse",
          target: "bash",
          data: { toolName: "bash", callID: "call-fork" },
          descriptors: hookDescriptors(mock, forkId, "PreToolUse"),
        },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    const hookResponse = await waitFor(() =>
      mock.capturedControlResponses.find((request) => request.body.requestID === hookRequestID),
    )
    expect(hookResponse.body.response).toMatchObject({
      continue: true,
      permissionDecision: { behavior: "allow" },
    })
    expect(hookToolCallId).toBe("call-fork")

    const toolRequestID = crypto.randomUUID()
    mock.emit({
      type: "control.request",
      properties: {
        id: toolRequestID,
        sessionID: forkId,
        subtype: "mcp_message",
        payload: {
          server: "sdk",
          tool: "echo",
          input: { value: "hi" },
          rootSessionID: forkId,
          toolCallId: "call-tool",
        },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    const toolResponse = await waitFor(() =>
      mock.capturedControlResponses.find((request) => request.body.requestID === toolRequestID),
    )
    expect(toolResponse.body.response).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ echoed: "hi" }) }],
    })

    const terminal = await drain(stream)
    expect(terminal.sessionId).toBe(forkId)
    expect(terminal.text).toBe("forked answer")
  })

  // The third client-local mechanism on a fork. `canUseTool` is a function, so
  // it can never reach the server in the fork's runtimeConfig — it only works if
  // the fork's own dispatcher registered the callback. Both decisions are
  // exercised so an "always allow" stub could not pass.
  test("forkSession wires canUseTool on the fork and delivers both of its decisions", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")
    answerWithText(mock, "forked answer")
    const seen: Array<{ toolName: string; input: Record<string, unknown> }> = []

    const stream = query({
      prompt: "retry another way",
      options: {
        baseUrl: mock.baseUrl,
        resume: "sess-seed",
        forkSession: true,
        forkMessageId: "msg_boundary",
        canUseTool: (toolName, input) => {
          seen.push({ toolName, input })
          return toolName === "bash" && input.command === "rm -rf /"
            ? { behavior: "deny", message: "not on my fork" }
            : { behavior: "allow", updatedInput: { ...input, audited: true } }
        },
      },
    })
    const forkId = await stream.sessionId()

    expect(mock.capturedForks).toMatchObject([{ sessionID: "sess-seed", messageID: "msg_boundary" }])
    expect(forkId).not.toBe("sess-seed")
    // A function cannot be serialized: the fork's runtimeConfig reaches the
    // server as a bare `true` marker, so the decision itself can only come from
    // a client-local registration on the fork's own dispatcher.
    expect(mock.runtimeConfigs.get(forkId)?.canUseTool).toBe(true)

    const denyRequestID = crypto.randomUUID()
    mock.emit({
      type: "control.request",
      properties: {
        id: denyRequestID,
        sessionID: forkId,
        subtype: "can_use_tool",
        payload: { toolName: "bash", input: { command: "rm -rf /" } },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    const denied = await waitFor(() =>
      mock.capturedControlResponses.find((request) => request.body.requestID === denyRequestID),
    )
    expect(denied.sessionID).toBe(forkId)
    expect(denied.body).toEqual({
      requestID: denyRequestID,
      subtype: "can_use_tool",
      response: { behavior: "deny", message: "not on my fork" },
    })

    const allowRequestID = crypto.randomUUID()
    mock.emit({
      type: "control.request",
      properties: {
        id: allowRequestID,
        sessionID: forkId,
        subtype: "can_use_tool",
        payload: { toolName: "read", input: { filePath: "/mock/seed/notes.md" } },
        createdAt: Date.now(),
        timeoutMs: 30_000,
      },
    })
    const allowed = await waitFor(() =>
      mock.capturedControlResponses.find((request) => request.body.requestID === allowRequestID),
    )
    expect(allowed.body).toEqual({
      requestID: allowRequestID,
      subtype: "can_use_tool",
      response: { behavior: "allow", updatedInput: { filePath: "/mock/seed/notes.md", audited: true } },
    })
    expect(seen).toEqual([
      { toolName: "bash", input: { command: "rm -rf /" } },
      { toolName: "read", input: { filePath: "/mock/seed/notes.md" } },
    ])

    const terminal = await drain(stream)
    expect(terminal.sessionId).toBe(forkId)
    expect(terminal.text).toBe("forked answer")
  })

  test("resume on a fresh dedicated isolated server throws, while spawn isolated:false is accepted", async () => {
    const attempt = () => query({ prompt: "continue", options: { resume: "sess-seed", spawn: {} } })

    expect(attempt).toThrow(/Cannot resume or fork from a fresh dedicated isolated server/)
    expect(attempt).toThrow(/canonical process-global server/)
    expect(attempt).toThrow(/baseUrl/)
    expect(attempt).toThrow(/injected client/)

    const accepted = query({ prompt: "continue", options: { resume: "sess-seed", spawn: { isolated: false } } })
    await accepted.close()
    expect(mock.requests()).toBe(0)
    expect(clientState().dedicated).toBe(0)
  })

  test("a cwd or directory override is refused word for word by both agent.fork() and query({forkSession})", async () => {
    const rows: Array<[string, { cwd?: string; directory?: string }]> = [
      ["cwd", { cwd: "/mock/elsewhere" }],
      ["directory", { directory: "/mock/elsewhere" }],
    ]

    for (const [field, override] of rows) {
      const expected =
        `Cannot apply "${field}" when forking: Cognitio forks inherit the source session directory. ` +
        "Omit it or create a fresh session."
      const agent = new Agent({ baseUrl: mock.baseUrl, ...override })
      const viaAgent = await rejection(agent.fork("sess-seed"))
      const attempt = () =>
        query({
          prompt: "retry another way",
          options: { ...override, baseUrl: mock.baseUrl, resume: "sess-seed", forkSession: true },
        })

      expect(viaAgent).toBeInstanceOf(Error)
      expect((viaAgent as Error).message).toBe(expected)
      // query() hands back a handle rather than a promise, so it reports this
      // synchronously.
      expect(attempt).toThrow(expected)
      const viaQuery = await rejection(Promise.resolve().then(attempt))
      // agent.ts and query.ts each own a copy of this string; pin them to one
      // contract so neither can drift.
      expect((viaQuery as Error).message).toBe((viaAgent as Error).message)

      await agent.close()
    }

    // Both paths refuse before reaching the server.
    expect(mock.requests()).toBe(0)
  })

  test("agent.fork() forks once and configures the new session with the facade profile", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")
    answerWithText(mock, "forked")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const fork = await agent.fork("sess-seed")

    expect(mock.capturedForks).toHaveLength(1)
    expect(mock.capturedForks[0]).toMatchObject({ sessionID: "sess-seed" })
    expect(mock.capturedForks[0]!.messageID).toBeUndefined()
    expect(mock.capturedSessionCreates).toHaveLength(0)
    expect(fork.id).not.toBe("sess-seed")
    expect(fork.directory).toBe("/mock/seed")

    // The server stores no runtimeConfig for a fork, so the profile has to arrive
    // as an explicit PATCH — on the new session id only, never the source.
    expect(mock.capturedRuntimeConfigPatches.map((request) => request.sessionID)).toEqual([fork.id])
    expect(mock.capturedRuntimeConfigPatches[0]!.body).toMatchObject({
      systemPrompt: NEUTRAL_BASE_PROMPT,
      settingSources: [],
      disallowedTools: FACADE_DEFAULT_DISALLOWED_TOOLS,
    })
    expect(mock.capturedSessionUpdates).toMatchObject([{ sessionID: fork.id, body: { title: "Agent session" } }])
    expect((await fork.send("continue on the fork")).sessionId).toBe(fork.id)

    await agent.close()
  })

  test("agent.fork(id, {messageId}) forwards the source message boundary", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    await agent.fork("sess-seed", { messageId: "msg_boundary" })

    expect(mock.capturedForks).toMatchObject([{ sessionID: "sess-seed", messageID: "msg_boundary" }])

    await agent.close()
  })

  // The hint is the whole point of wrapping this error: the raw low-level
  // message says the session was not found, which reads like a caller mistake
  // when the real cause is usually that the canonical server was replaced.
  test("a missing session is reported with the per-process server hint on both resume and fork", async () => {
    const agent = new Agent({ baseUrl: mock.baseUrl })
    const expected =
      /Failed to locate session ses_missing\. The canonical server is process-local and shutdown\(\) ends it; use the canonical client, baseUrl, or an injected client that owns this session\./

    expect(String(await rejection(agent.resume("ses_missing")))).toMatch(expected)
    expect(String(await rejection(agent.fork("ses_missing")))).toMatch(expected)

    await agent.close()
  })

  test("agent.resume() attaches once and memoizes one working handle per session id", async () => {
    seedSession(mock, "sess-seed", "/mock/seed")
    answerWithText(mock, "resumed")

    const agent = new Agent({ baseUrl: mock.baseUrl })
    const session = await agent.resume("sess-seed")

    expect(session.id).toBe("sess-seed")
    expect(mock.capturedSessionCreates).toHaveLength(0)
    // A bare profile supplies no model, permissionMode, or title, so attach
    // applies nothing.
    expect(mock.capturedSessionUpdates).toEqual([])
    expect(mock.capturedRuntimeConfigPatches).toEqual([])
    expect((await session.send("continue the review")).sessionId).toBe("sess-seed")

    // Memoized through the Agent's live-session map, so one server session never
    // ends up with two facade owners racing dispatchers on it.
    expect(await agent.resume("sess-seed")).toBe(session)

    await agent.close()
  })
})
