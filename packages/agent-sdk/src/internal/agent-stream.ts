import { sdkError } from "../errors.js"
import type { Session } from "../session.js"
import type { AgentMessage, ModelId, PermissionMode, ResultMessage } from "../types.js"

interface StartedAgentStream {
  session: Session
  iterator: AsyncGenerator<AgentMessage, ResultMessage, void>
}

interface AgentStreamContext {
  start: () => Promise<StartedAgentStream>
  singleTurn: boolean
  signal?: AbortSignal
  onUntrack: () => void
  onFinish?: () => Promise<void>
}

/**
 * A normalized Agent event stream with active-session controls.
 *
 * `interrupt()` affects the current turn. `close()` disposes the iterator and
 * transient Session and is idempotent. Session startup is lazy.
 *
 * @example
 * ```ts
 * const stream: AgentStream = agent.stream("Explain this change.")
 * console.log(await stream.sessionId())
 * for await (const message of stream) console.log(message.type)
 * ```
 */
export interface AgentStream extends AsyncGenerator<AgentMessage, ResultMessage, void> {
  /**
   * Start lazily when needed and return the server session id.
   *
   * @returns The transient server session id.
   * @throws When session creation fails or the stream is already closed.
   * @example
   * ```ts
   * console.log(await stream.sessionId())
   * ```
   */
  sessionId(): Promise<string>
  /**
   * Abort the active turn without disposing a multi-turn iterator.
   *
   * @returns A promise settled after the abort request.
   * @throws When startup or the abort request fails.
   * @example
   * ```ts
   * await stream.interrupt()
   * ```
   */
  interrupt(): Promise<void>
  /**
   * Change the active session's permission mode.
   *
   * @param mode - New runtime permission mode.
   * @returns A promise settled after the server applies the mode.
   * @throws When the stream is closed or the request fails.
   * @example
   * ```ts
   * await stream.setPermissionMode("dontAsk")
   * ```
   */
  setPermissionMode(mode: PermissionMode): Promise<void>
  /**
   * Change the active session's model.
   *
   * @param model - New `provider/model` id.
   * @returns A promise settled after the server applies the model.
   * @throws When the stream is closed, the id is invalid, or the request fails.
   * @example
   * ```ts
   * await stream.setModel("anthropic/claude-sonnet-4-5")
   * ```
   */
  setModel(model: ModelId): Promise<void>
  /**
   * Dispose the stream and its transient session idempotently.
   *
   * @returns A promise settled after owned resources are handled.
   * @throws When one or more teardown stages fail.
   * @example
   * ```ts
   * await stream.close()
   * ```
   */
  close(): Promise<void>
}

/**
 * Build the delegating stream handle returned by `Agent.stream()`.
 *
 * A plain object rather than a native generator, so the control methods are
 * visible to TypeScript and `return()` has somewhere to run teardown. Startup
 * is deferred to the first `next()`, `sessionId()`, or control call, and
 * teardown is memoized so every exit path — completion, rejection, `return()`,
 * `close()`, and the owning Agent's `close()` — runs it exactly once.
 *
 * @param context - Session factory, turn shape, optional abort signal, and owner callbacks.
 * @returns A lazily started, idempotently disposable Agent stream.
 */
export function createAgentStream(context: AgentStreamContext): AgentStream {
  let startPromise: Promise<StartedAgentStream> | undefined
  let finishPromise: Promise<void> | undefined
  let terminalResult: ResultMessage | undefined
  let untracked = false
  let finished = false

  const ensureStarted = () => {
    if (startPromise) return startPromise
    if (finished) return Promise.reject(sdkError("closed", "Agent stream is closed"))
    if (context.signal?.aborted) {
      return Promise.reject(context.signal.reason ?? sdkError("closed", "Agent stream was aborted before start"))
    }
    startPromise = context.start()
    startPromise.catch(() => {})
    return startPromise
  }

  const untrack = () => {
    if (untracked) return
    untracked = true
    context.onUntrack()
  }

  const finish = (options?: { settledIterator?: boolean }): Promise<void> => {
    if (finishPromise) return finishPromise
    finished = true
    // Untracking before any teardown is load-bearing, not tidiness. `query()`
    // sets `onFinish` to close its private Agent, and Agent.close() sweeps the
    // streams it still tracks — so a stream that stayed tracked here would end
    // up awaiting a teardown that is awaiting this very promise.
    untrack()
    context.signal?.removeEventListener("abort", onAbort)
    finishPromise = (async () => {
      const errors: unknown[] = []
      const started = startPromise
        ? await startPromise.then(
            (value) => value,
            () => undefined,
          )
        : undefined
      if (started) {
        if (options?.settledIterator) {
          const returned = await Promise.allSettled([started.iterator.return(terminalResult as ResultMessage)])
          errors.push(...returned.filter((item) => item.status === "rejected").map((item) => item.reason))
          const closed = await Promise.allSettled([started.session.close()])
          errors.push(...closed.filter((item) => item.status === "rejected").map((item) => item.reason))
        } else {
          const cleanup = await Promise.allSettled([
            started.iterator.return(terminalResult as ResultMessage),
            started.session.close(),
          ])
          errors.push(...cleanup.filter((item) => item.status === "rejected").map((item) => item.reason))
        }
      }
      if (context.onFinish) {
        await context.onFinish().catch((error) => {
          errors.push(error)
        })
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "Failed to close Agent stream")
    })()
    return finishPromise
  }

  const fail = async (error: unknown, options?: { settledIterator?: boolean }): Promise<never> => {
    const cleanup = await finish(options).then(
      () => undefined,
      (cleanupError) => cleanupError,
    )
    if (cleanup !== undefined && cleanup !== error) {
      throw new AggregateError([error, cleanup], "Agent stream failed and could not be closed")
    }
    throw error
  }

  /**
   * Tear down after a terminal result has been captured, without letting the
   * teardown outcome replace it.
   *
   * The turn already ran and was billed, so losing the answer to a failed
   * housekeeping call — server-side SDK-MCP cleanup, for instance — would be
   * strictly worse than losing the report of that failure.
   *
   * The rejection is not discarded. `finish()` is memoized, so a caller holding
   * the handle still observes it from `close()`. `run()` has no handle to ask,
   * and deliberately trades that report for the result: its session is
   * transient and about to be discarded either way.
   */
  const settleAfterResult = () => finish({ settledIterator: true }).catch(() => {})

  const startOrFinish = async () => {
    try {
      return await ensureStarted()
    } catch (error) {
      return fail(error)
    }
  }

  // Never starts the stream: aborting a handle nobody has iterated must not
  // spawn a server and create a session that no teardown path owns. An
  // unstarted stream has no turn to interrupt, and `ensureStarted` already
  // refuses to start once the signal is aborted.
  const onAbort = () => {
    if (!startPromise) return
    void startPromise.then((started) => started.session.interrupt()).catch(() => {})
  }
  context.signal?.addEventListener("abort", onAbort, { once: true })

  const stream: AgentStream = {
    async next() {
      if (terminalResult) {
        return {
          done: true,
          value: terminalResult,
        }
      }
      if (finished) {
        return {
          done: true,
          value: undefined as never,
        }
      }
      try {
        const next = await ensureStarted().then((started) => started.iterator.next())
        if (next.done) {
          terminalResult = next.value
          await settleAfterResult()
          return next
        }
        if (next.value.type === "result" && (context.singleTurn || context.signal?.aborted)) {
          terminalResult = next.value.result
          await settleAfterResult()
        }
        return next
      } catch (error) {
        return fail(error, { settledIterator: true })
      }
    },
    async return(value) {
      if (value !== undefined) terminalResult = await value
      await finish()
      return {
        done: true,
        value: terminalResult as ResultMessage,
      }
    },
    async throw(error) {
      if (finished) throw error
      const started = await startOrFinish()
      try {
        const result = await started.iterator.throw(error)
        if (result.done) terminalResult = result.value
        await finish({ settledIterator: true })
        return result
      } catch (thrown) {
        return fail(thrown, { settledIterator: true })
      }
    },
    [Symbol.asyncIterator]() {
      return stream
    },
    async sessionId() {
      if (finished) throw sdkError("closed", "Agent stream is closed")
      return (await startOrFinish()).session.id
    },
    async interrupt() {
      if (finished) return
      await startOrFinish().then((started) => started.session.interrupt())
    },
    async setPermissionMode(mode) {
      if (finished) throw sdkError("closed", "Agent stream is closed")
      await startOrFinish().then((started) => started.session.setPermissionMode(mode))
    },
    async setModel(model) {
      if (finished) throw sdkError("closed", "Agent stream is closed")
      await startOrFinish().then((started) => started.session.setModel(model))
    },
    close() {
      return finish()
    },
  }
  return stream
}
