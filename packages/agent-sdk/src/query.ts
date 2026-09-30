import { sdkError } from "./errors.js"
import {
  AGENT_FRESH_STREAM,
  AGENT_SESSION_STREAM,
  AGENT_VALIDATE_FORK,
  AGENT_VALIDATE_RESUME,
  Agent,
  type AgentOptions,
  type AgentStreamOptions,
} from "./agent.js"
import type { AgentStream } from "./internal/agent-stream.js"
import { deriveAgentTitle } from "./internal/default-profile.js"
import type { PromptInput } from "./types.js"

/**
 * Migration-oriented one-shot query options.
 *
 * The call shape follows Claude Agent SDK conventions, but Cognitio stream
 * message shapes remain native to this package. Resume applies explicit
 * runtime overrides and reattaches supplied callbacks before work starts;
 * changing the existing working directory is rejected. A configured fork applies
 * the full facade profile to the new session.
 *
 * @example
 * ```ts
 * const options: QueryOptions = {
 *   model: "anthropic/claude-sonnet-4-5",
 *   resume: "ses_existing",
 * }
 * ```
 */
export interface QueryOptions extends AgentOptions {
  /** Yield partial delta envelopes. */
  includePartialMessages?: boolean
  /** Abort the active turn without changing iterator ownership. */
  signal?: AbortSignal
  /** Existing session id to attach to or fork. */
  resume?: string
  /** Fork `resume` instead of attaching to it. Requires `resume`. */
  forkSession?: boolean
  /** Optional fork boundary. Requires `forkSession: true`. */
  forkMessageId?: string
}

/**
 * The same controllable async-iterator surface returned by `Agent.stream()`.
 *
 * @example
 * ```ts
 * const result: Query = query({ prompt: "What is 2+2?" })
 * ```
 */
export type Query = AgentStream

/**
 * Create a lazy one-shot Agent query.
 *
 * The private Agent is closed when iteration completes, fails, is returned
 * early, or `close()` is called. Its canonical server remains process-global;
 * use `shutdown()` for global teardown. Startup is lazy, so a never-consumed
 * query allocates no session; call `close()` when abandoning a started handle.
 *
 * A fresh dedicated isolated server cannot reach a session stored by another
 * server. For resume/fork, use the canonical client, `baseUrl`, an injected
 * client, or `spawn: { isolated: false }`.
 *
 * @param input - Prompt and flat facade options.
 * @returns A synchronous, lazy Agent stream.
 * @throws Synchronously for invalid options or unsupported resume/fork combinations.
 * @example
 * ```ts
 * import { query } from "cognitio-agent-sdk"
 *
 * for await (const message of query({ prompt: "What is 2+2?" })) {
 *   if (message.type === "result") console.log(message.text)
 * }
 * ```
 */
export function query(input: { prompt: PromptInput; options?: QueryOptions }): Query {
  if (input.options?.forkSession && input.options.resume === undefined) {
    throw sdkError("configuration", 'query option "forkSession" requires "resume"')
  }
  if (input.options?.forkMessageId !== undefined && !input.options.forkSession) {
    throw sdkError("configuration", 'query option "forkMessageId" requires "forkSession: true"')
  }
  if (input.options?.forkSession && (input.options.cwd !== undefined || input.options.directory !== undefined)) {
    const field = input.options.cwd !== undefined ? "cwd" : "directory"
    throw sdkError(
      "configuration",
      `Cannot apply "${field}" when forking: Cognitio forks inherit the source session directory. Omit it or create a fresh session.`,
    )
  }

  const agent = new Agent(agentOptions(input.options, input.prompt))
  // Both branches report an unreachable server before returning a handle, so
  // `query({resume})` never defers that failure to the first `next()`.
  if (input.options?.resume !== undefined) {
    if (input.options.forkSession) agent[AGENT_VALIDATE_FORK]()
    else agent[AGENT_VALIDATE_RESUME]()
  }
  const streamOptions: AgentStreamOptions = {
    ...(input.options?.includePartialMessages !== undefined
      ? { includePartialMessages: input.options.includePartialMessages }
      : {}),
    ...(input.options?.signal !== undefined ? { signal: input.options.signal } : {}),
  }
  const finish = () => agent.close()
  if (input.options?.resume === undefined) {
    return agent[AGENT_FRESH_STREAM](input.prompt, streamOptions, finish)
  }
  return agent[AGENT_SESSION_STREAM](
    () =>
      input.options!.forkSession
        ? agent.fork(input.options!.resume!, {
            messageId: input.options!.forkMessageId,
          })
        : agent.resume(input.options!.resume!),
    input.prompt,
    streamOptions,
    finish,
  )
}

function agentOptions(options: QueryOptions | undefined, prompt: PromptInput): AgentOptions | undefined {
  if (!options) return
  const queryOnly = new Set(["includePartialMessages", "signal", "resume", "forkSession", "forkMessageId"])
  return {
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !queryOnly.has(key))),
    ...(options.forkSession && options.title === undefined ? { title: deriveAgentTitle(prompt) } : {}),
  } as AgentOptions
}
