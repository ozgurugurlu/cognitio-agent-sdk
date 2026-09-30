import type { ChildProcess } from "node:child_process"
import { spawn as spawnChild } from "node:child_process"
import { Agent, createSdkMcpServer, defineTool, query } from "../../src/index.js"
import type {
  AgentOptions,
  AgentSessionOptions,
  AgentStream,
  AgentStreamOptions,
  ModelId,
  PermissionRuleset,
  PromptInput,
  Query,
  QueryOptions,
  SpawnServerRequest,
  ResultMessage,
  RunOptions,
  RunResult,
  Session,
} from "../../src/index.js"

declare const arbitraryModel: string
declare const prompt: PromptInput
declare const permission: PermissionRuleset
declare const result: RunResult

const model: ModelId = arbitraryModel
const stringModel: string = model
const options: AgentOptions = {
  model: arbitraryModel,
  permission,
}
const typedTool = defineTool({
  name: "typed",
  inputSchema: { type: "object" },
  execute: (input: { value: string }) => input.value,
})
const toolOptions: AgentOptions = {
  tools: [typedTool],
  sdkMcpServers: [createSdkMcpServer({ name: "typed", tools: [typedTool] })],
}
const runOptions: RunOptions = {
  model: arbitraryModel,
  permission,
  signal: new AbortController().signal,
}
const streamOptions: AgentStreamOptions = {
  ...runOptions,
  includePartialMessages: false,
}
const sessionOptions: AgentSessionOptions = {
  model: arbitraryModel,
  permission,
  parentId: "ses_parent",
}
const queryOptions: QueryOptions = {
  model: arbitraryModel,
  permission,
  signal: new AbortController().signal,
  resume: "ses_existing",
}

const agent: Agent = new Agent(options)
const stream: AgentStream = agent.stream(prompt, streamOptions)
const queried: Query = query({ prompt, options: queryOptions })
const run: Promise<RunResult> = agent.run(prompt, runOptions)
const session: Promise<Session> = agent.createSession(sessionOptions)
const resultText: string = result.text
const resultError: boolean = result.isError
const terminal: ResultMessage = result
const sessionId: Promise<string> = stream.sessionId()
const interrupted: Promise<void> = stream.interrupt()

const invalidAgent: AgentOptions = {
  // @ts-expect-error AgentOptions accepts runtime fields directly, never a nested runtimeConfig.
  runtimeConfig: {},
}
const invalidRun: RunOptions = {
  // @ts-expect-error Per-run raw runtimeConfig is intentionally unsupported.
  runtimeConfig: {},
}
const invalidStream: AgentStreamOptions = {
  // @ts-expect-error Per-stream raw runtimeConfig is intentionally unsupported.
  runtimeConfig: {},
}
const invalidSessionRuntime: AgentSessionOptions = {
  // @ts-expect-error Long-lived sessions accept the curated flat fields only.
  runtimeConfig: {},
}
const invalidSessionSignal: AgentSessionOptions = {
  // @ts-expect-error A creation-only session option must not advertise turn cancellation.
  signal: new AbortController().signal,
}
const invalidQuery: QueryOptions = {
  // @ts-expect-error QueryOptions exposes AgentOptions directly, never nested runtimeConfig.
  runtimeConfig: {},
}

// --- Phase 14: binary resolution on the public spawn surface ----------------

/** `binaryPath` is a plain string option, reachable from every entry point. */
const spawnBinaryPath: AgentOptions = { spawn: { binaryPath: "/opt/cognitio/bin/cognitio" } }

/**
 * `spawnProcess` receives the resolved request and returns a node ChildProcess.
 *
 * Deliberately Node-specific: it is the only shape that composes with the
 * vendored process helpers without reopening P13's termination guarantees, and
 * Python's analogue is `subprocess.Popen`. Recorded in the close-out as a known
 * exception to the language-neutral option rule (portability rule §7).
 */
const spawnCustomProcess: AgentOptions = {
  spawn: {
    spawnProcess: (request: SpawnServerRequest): ChildProcess => {
      const command: string = request.command
      const args: string[] = request.args
      const env: Record<string, string> = request.env
      const signal: AbortSignal | undefined = request.signal
      void [command, args, env, signal]
      return spawnChild(command, args, { env })
    },
  },
}

/** A number is not a path. */
// @ts-expect-error binaryPath must be a string
const invalidBinaryPath: AgentOptions = { spawn: { binaryPath: 42 } }

void [
  arbitraryModel,
  model,
  stringModel,
  spawnBinaryPath,
  spawnCustomProcess,
  invalidBinaryPath,
  options,
  toolOptions,
  typedTool,
  runOptions,
  streamOptions,
  sessionOptions,
  queryOptions,
  agent,
  stream,
  queried,
  run,
  session,
  resultText,
  resultError,
  terminal,
  sessionId,
  interrupted,
  invalidAgent,
  invalidRun,
  invalidStream,
  invalidSessionRuntime,
  invalidSessionSignal,
  invalidQuery,
]
