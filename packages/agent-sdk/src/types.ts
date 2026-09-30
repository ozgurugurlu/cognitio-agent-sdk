/**
 * Public type surface for cognitio-agent-sdk.
 *
 * Serializable policies, session messages, local callback definitions, and lifecycle options.
 */

import type { ChildProcess } from "node:child_process"
import type { ReadResourceResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js"
import type {
  Session as WireCognitioSession,
  Message as WireCognitioMessage,
  Part as WireCognitioPart,
  Event as WireCognitioEvent,
  SessionCheckpoint as CognitioCheckpoint,
  SessionRewindResult as CognitioRewindResult,
  Todo,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
  PermissionRuleset as WirePermissionRuleset,
  Auth as WireAuth,
  Config as WireCognitioConfig,
} from "./internal/runtime-client/index.js"
import type { SpawnServerRequest } from "./internal/runtime-client/index.js"
import type { KnownModelId } from "./models.generated.js"

export type { SpawnServerRequest }
import type {
  OAuth as WireOAuth,
  ApiAuth as WireApiAuth,
  WellKnownAuth as WireWellKnownAuth,
} from "./internal/runtime-client/index.js"
export type {
  KnownModelId,
  AnthropicModelId,
  OpenaiModelId,
  GoogleModelId,
  XaiModelId,
  GroqModelId,
  MistralModelId,
  DeepseekModelId,
} from "./models.generated.js"

/**
 * A model id in `provider/model` form. Known ids receive editor completions,
 * while arbitrary provider and newly released model ids remain valid.
 *
 * @example
 * ```ts
 * const model: ModelId = "private-provider/reviewer-v2"
 * ```
 */
export type ModelId = KnownModelId | (string & {})

// --- Re-exports for consumer convenience ---------------------------------
export type {
  CognitioCheckpoint,
  CognitioRewindResult,
  Todo,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
}

// --- Client & transport --------------------------------------------------

/**
 * Options to `createAgentClient`.
 *
 * - Pass `baseUrl` to connect to an already-running server (remote transport).
 * - Omit `baseUrl` to spawn a local `cognitio serve` via the existing SDK.
 */
export interface ClientOptions {
  /** Absolute URL of a running cognitio server. If set, no server is spawned. */
  baseUrl?: string
  /** Headers sent on every remote HTTP/SSE request, including Authorization. Requires baseUrl. */
  headers?: Record<string, string>
  /** Working directory sent to the server on session creation. */
  directory?: string
  /** Optional workspace id passed through to the server. */
  workspaceId?: string
  /** Override spawn behavior. Not used when `baseUrl` is provided. */
  spawn?: SpawnOptions
  /** Control-channel dispatcher readiness and reconnect tuning. */
  control?: ControlOptions
}

/**
 * Configuration for an SDK-owned runtime process. Local spawning is isolated by default. Explicit binary paths and custom process factories are caller-owned compatibility escape hatches.
 */
export interface SpawnOptions {
  /** Bind address for an owned runtime (loopback by default). */
  hostname?: string
  /** Port for an owned runtime; zero requests an available port. */
  port?: number
  /** Milliseconds to wait for the readiness line before rejecting startup. */
  timeout?: number
  /** Abort startup and the associated child process. */
  signal?: AbortSignal
  /**
   * Hermetic spawn: the server runs with COGNITIO_ISOLATED=1, a scratch
   * HOME/XDG world, and an allowlisted environment. Config/persona/state
   * isolation only — this is NOT an OS or tool sandbox.
   * @defaultValue true
   */
  isolated?: boolean
  /** Literal env vars for the child. In isolated mode reserved keys (HOME, XDG_*, TMPDIR, COGNITIO_ISOLATED, ...) are rejected. */
  env?: Record<string, string>
  /** Names of parent env vars to forward in isolated mode. COGNITIO_* names are rejected — use env/auth/config. */
  passEnv?: string[]
  /** Credentials injected via COGNITIO_AUTH_CONTENT. In isolated mode this is always set (empty record by default) so the server never reads a host auth.json. */
  auth?: AuthContent
  /** Config injected via COGNITIO_CONFIG_CONTENT (never a host file). */
  config?: CognitioConfig
  /** Parent directory for the SDK-owned scratch dir (isolated only). The SDK creates and removes its own child inside it. */
  scratchDir?: string
  /** Keep the owned scratch dir on close (isolated only); shutdown still runs. */
  keepScratch?: boolean
  /**
   * Explicit server binary. Overrides `COGNITIO_BIN_PATH`, the bundled platform
   * package, and `PATH`.
   *
   * Relative paths resolve against `process.cwd()`. A bare command name is
   * rejected — leaving `binaryPath` unset is how you ask for a `PATH` lookup.
   * A path that does not exist or is not executable throws rather than falling
   * through: an explicit choice that does not work is a caller error.
   *
   * Skips the post-readiness compatibility check, since you chose the binary.
   */
  binaryPath?: string
  /**
   * Replace the default child spawn — containers, VMs, remote hosts.
   *
   * Receives the already-resolved command/args/env/signal and is called exactly
   * once. The returned object must implement `on`, `once`, `off`, `kill`, `unref`,
   * piped `stdout`/`stderr`, `pid`, and nullable/optional `exitCode`/`signalCode`. Skips the
   * post-readiness compatibility check, since you own the process.
   */
  spawnProcess?: (request: SpawnServerRequest) => ChildProcess
  /** Grace period in ms between SIGTERM and SIGKILL on close (default 5000). */
  shutdownTimeout?: number
  /**
   * Track the spawned server for best-effort direct-child cleanup on process
   * exit and unref it after readiness. The facade enables this by default;
   * the low-level transport leaves it disabled unless requested.
   *
   * Sole-listener SIGINT/SIGTERM handlers await child termination. A host
   * signal handler retains responsibility for shutdown. The synchronous exit sweep cannot await SIGKILL escalation, kill a
   * descendant tree, or remove owned scratch safely. Prefer `close()` or
   * facade `shutdown()` for deterministic cleanup.
   *
   * @defaultValue `false`
   */
  autoCleanup?: boolean
}

/** Credential map injected as COGNITIO_AUTH_CONTENT. Values use the server's generated Auth union — the server-side schema decode is the authority. */
export type AuthContent = Record<string, Auth>

/**
 * Timing and reconnect options for the session control dispatcher. Callback requests must be answered before their server-side deadlines.
 */
export interface ControlOptions {
  /** Milliseconds to wait for the local control dispatcher to become ready. */
  readyTimeoutMs?: number
  /** Bounded reconnection attempts and exponential-delay limits in milliseconds. */
  reconnect?: {
    maxAttempts?: number
    initialDelayMs?: number
    maxDelayMs?: number
  }
}

/** Identifies how the client is connected to a Cognitio server. */
export type TransportKind = "spawn" | "remote"

// --- Session / runtime config -------------------------------------------

/**
 * Runtime authorization mode. A mode controls approval policy; it does not provide filesystem or process sandboxing.
 */
export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions" | "auto"

/**
 * A custom prompt string/object or a built-in prompt preset. The default preset is the coding profile; none omits the preset.
 */
export type SystemPromptSpec =
  | string
  | { type: "preset"; preset: "default" | "none"; append?: string }
  | { type: "custom"; prompt: string }

/**
 * Per-session runtime configuration applied to each accepted turn. Local
 * callbacks stay in the SDK process; the server stores serializable descriptors.
 * Runtime configuration is ephemeral and must be supplied after a server restart.
 */
export interface RuntimeConfig {
  /** Replace the base prompt with a string/custom prompt, or explicitly select the coding preset. */
  systemPrompt?: SystemPromptSpec
  /** Full custom system prompt (sugar for a custom systemPrompt). Cannot be combined with systemPrompt. */
  instructions?: string
  /** Append application instructions after the selected base system prompt. */
  appendSystemPrompt?: string
  /** Provider/model identifier used for the main agent turn. */
  model?: ModelId
  /** Provider-specific reasoning effort; unsupported combinations are rejected. */
  effort?: "low" | "medium" | "high" | "max"
  /** Provider reasoning configuration; unsupported model/provider combinations fail explicitly. */
  thinkingConfig?: ThinkingConfig
  /** Positive maximum number of assistant turns before error_max_turns. */
  maxTurns?: number
  /** Positive estimated USD budget; a reached limit ends with error_max_budget. Provider accounting is authoritative. */
  maxBudgetUsd?: number
  /** Approval policy for unresolved tool requests. This does not create an OS sandbox. */
  permissionMode?: PermissionMode
  /** Provider/model used to classify unresolved permissions in auto mode. */
  autoPermissionClassifierModel?: ModelId
  /** Nonempty tool allowlist, including scoped expressions such as bash(npm:*). An empty array adds no allowlist restriction; use disallowedTools: ["*"] to hide ordinary tools. Matching grants can bypass the permission callback. */
  allowedTools?: string[]
  /** Tool denylist. ["*"] disables tool execution, including the runtime's StructuredOutput tool. Use deterministic deny rules for operations that must never be approved. */
  disallowedTools?: string[]
  /** Instruction/config resource sources to load. SDK sessions default to an empty array. */
  settingSources?: Array<"user" | "project" | "local">
  /** Session-scoped helper and subagent definitions, keyed by name. */
  agents?: Record<string, AgentDefinition>
  /** Programmatic reusable skill descriptions and content. */
  skills?: SkillDefinition[]
  /** Programmatic commands invoked by Session.command(name, arguments). */
  commands?: CommandDefinition[]
  /** Inline plugin bundles or local Claude-format plugin directories. */
  plugins?: PluginSpec[]
  /** Callbacks keyed by lifecycle event. Callbacks remain local and must be rebound after restarting the application. An empty object clears prior hooks on resume. */
  hooks?: HookRegistration
  /** Answer unresolved tool approval requests. Explicit allow rules can approve a tool before this callback runs. Set false to disable a prior callback on resume. */
  canUseTool?: CanUseToolCallback | false
  /** SDK-hosted or external MCP descriptors. An explicit empty array clears prior MCP registrations on resume. */
  sdkMcpServers?: RuntimeMcpServer[]
  /** Control deferred tool discovery. Directly loaded tools remain governed by normal tool policy. */
  enableToolSearch?: boolean | "auto" | "always" | "never"
  /** Enable automatic file checkpointing. Requires a Git-backed workspace with runtime snapshots enabled. */
  enableFileCheckpointing?: boolean
  /** Expected structured JSON output schema and bounded schema retry policy. */
  outputFormat?: OutputFormatSpec
  /** V2 awaits tasks within the current turn. Detached durable jobs are outside this release. */
  backgroundTaskPolicy?: { mode: "foreground" }
  /** Fine-grained file checkpoint policy. */
  checkpointing?: CheckpointingConfig
  /** Per-session automatic compaction and summary formatting. */
  compaction?: { auto?: boolean; includeFiles?: boolean }
  /** Include working directory and platform context in the model's system prompt. */
  includeEnvironment?: boolean
}

/** Extended reasoning configuration mapped to the selected provider. */
export type ThinkingConfig = { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budgetTokens: number }

/** Checkpoint creation policy; beforeTools defaults to true when checkpointing is enabled. */
export interface CheckpointingConfig {
  /** Enable automatic checkpoint policy. */
  enabled?: boolean
  /** Capture before eligible tool mutations when automatic checkpoints are enabled. Defaults to true. */
  beforeTools?: boolean
  /** Capture a file snapshot before context compaction when enabled. */
  beforeCompaction?: boolean
}

/** Overrides applied atomically before a resumed handle starts its local control dispatcher. */
export interface SessionResumeOptions {
  /** Explicit policy fields to merge into the stored configuration before attaching. */
  runtimeConfig?: RuntimeConfig
  /** Replace the persisted session title. */
  title?: string
  /** Replace persisted permission rules. */
  permission?: PermissionRuleset
}

/**
 * Options for a new server session, including its working directory, metadata and ephemeral runtime configuration.
 */
export interface SessionCreateOptions {
  /** Working directory on the runtime host. */
  cwd?: string
  /** Optional initial session title. */
  title?: string
  /** Optional parent session identifier. */
  parentId?: string
  /** Session-scoped policy and local callbacks. */
  runtimeConfig?: RuntimeConfig
  /** Persisted ordered permission rules. */
  permission?: PermissionRuleset
}

/**
 * Filters for persisted sessions. Directory/tag/root filters narrow results; start and limit control the returned window.
 */
export interface SessionListFilter {
  /** Limit results to this working directory. */
  cwd?: string
  /** Only sessions containing this tag. */
  tag?: string
  /** When true, only sessions without a parent. */
  roots?: boolean
  /** Case-insensitive title search. */
  search?: string
  /** Return sessions updated at or after this Unix timestamp in milliseconds. */
  start?: number
  /** Maximum number of sessions to return. */
  limit?: number
}

/** Snapshot returned by `session.getAppliedSettings()`. */
export interface AppliedSettings {
  sessionId: string
  effort?: RuntimeConfig["effort"]
  thinkingConfig?: ThinkingConfig
  checkpointing?: CheckpointingConfig
  backgroundTaskPolicy?: RuntimeConfig["backgroundTaskPolicy"]
  compaction?: RuntimeConfig["compaction"]
  includeEnvironment?: boolean
  model?: ModelId
  maxTurns?: number
  maxBudgetUsd?: number
  permissionMode?: PermissionMode
  systemPrompt?: {
    /** "neutral" = the SDK-injected neutral base prompt (detected via the stored config). */
    mode: "default" | "custom" | "preset" | "neutral"
    preset?: "default" | "none"
    hasAppend: boolean
  }
  appendSystemPrompt?: { length: number }
  settingSources: Array<"user" | "project" | "local">
  canUseTool?: { registered: boolean }
  hookCounts?: Partial<Record<HookEventName, number>>
  autoPermissionClassifierModel?: ModelId
  tools: {
    allowed: string[]
    disallowed: string[]
  }
  /** Names of hook events with at least one registered callback. */
  registeredHooks: HookEventName[]
  /** Names of agent definitions available for subagent dispatch. */
  agents: string[]
  skills: Array<{ name: string; source: "runtime" | "plugin"; pluginName?: string }>
  commands: Array<{ name: string; source: "runtime" | "plugin" | "skill"; pluginName?: string }>
  plugins: Array<{
    name: string
    source: "inline" | "claude"
    skillCount: number
    commandCount: number
    agentCount: number
    hookEventCount: number
    mcpServerCount: number
    diagnostics?: string[]
  }>
}

// --- Messages (normalized stream) ----------------------------------------

/**
 * Normalized stream messages surfaced by `session.stream()`. Original runtime
 * event payloads are available in `raw` where applicable.
 */
export type AgentMessage =
  | {
      type: "system"
      subtype: "system.compact_boundary"
      trigger?: "auto" | "manual"
      preCompactTokenCount?: number
      compactionId?: string
      preservedMessageIds?: string[]
      summaryText?: string
      raw?: unknown
    }
  | {
      type: "system"
      subtype: string
      trigger?: never
      preCompactTokenCount?: never
      compactionId?: never
      preservedMessageIds?: never
      summaryText?: never
      raw?: unknown
    }
  | { type: "user"; message: CognitioMessage; parts?: CognitioPart[]; raw?: unknown }
  | {
      type: "assistant"
      message: CognitioMessage
      parts?: CognitioPart[]
      text?: string
      reasoning?: string
      raw?: unknown
    }
  | { type: "partial"; messageId: string; partId: string; field: string; delta: string; raw?: unknown }
  | { type: "part"; part: CognitioPart; raw?: unknown }
  | { type: "todo.updated"; sessionId: string; todos: TodoItem[]; raw?: unknown }
  | { type: "checkpoint.created"; checkpoint: CheckpointHandle; raw?: unknown }
  | { type: "session.rewound"; checkpointId: string; affectedFiles: string[]; raw?: unknown }
  | {
      type: "permission.request"
      requestId: string
      tool: string
      input: unknown
      raw?: unknown
    }
  | {
      type: "tool.use"
      toolUseId: string
      name: string
      input: unknown
      raw?: unknown
    }
  | {
      type: "tool.result"
      toolUseId: string
      output: unknown
      raw?: unknown
    }
  | {
      type: "subagent.start"
      rootSessionId: string
      parentSessionId: string
      childSessionId: string
      messageId: string
      agent: string
      taskId: string
      spawnMode: "fresh" | "inherit"
      toolCallId?: string
      raw?: unknown
    }
  | {
      type: "subagent.progress"
      rootSessionId: string
      parentSessionId: string
      childSessionId: string
      messageId: string
      agent: string
      taskId: string
      spawnMode: "fresh" | "inherit"
      status: string
      title?: string
      toolCallId?: string
      raw?: unknown
    }
  | {
      type: "subagent.stop"
      rootSessionId: string
      parentSessionId: string
      childSessionId: string
      messageId: string
      agent: string
      taskId: string
      spawnMode: "fresh" | "inherit"
      status: "completed" | "error" | "cancelled"
      result?: string
      error?: string
      toolCallId?: string
      raw?: unknown
    }
  | RateLimitEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | TaskStoppedEvent
  /**
   * Terminal message of a turn. `text` mirrors `result.text` so a consumer
   * that only switches on the envelope never has to reach into `result`.
   */
  | { type: "result"; result: ResultMessage; text?: string; raw?: unknown }
  | { type: "raw"; event: CognitioEvent }

// --- Observability events (Phase 10) --------------------------------------
// Task and rate-limit events are root-routed on the server (like subagent.*):
// `sessionId` is the root session your stream is attached to, while
// `activeSessionId` is the session the event actually occurred in (a subagent
// child, for nested activity).

/**
 * Emitted when a provider rate-limits a request. `retryAfterSeconds` is the
 * parsed retry-after header when present, otherwise the backoff delay the
 * server chose; it is absent when the provider marked the error
 * non-retryable (the run then fails without retrying).
 */
export interface RateLimitEvent {
  type: "rate_limit"
  sessionId: string
  activeSessionId: string
  provider: string
  model?: string
  attempt?: number
  retryAfterSeconds?: number
  message?: string
  raw?: unknown
}

/**
 * Tool-call lifecycle events (`taskId` = tool call ID, correlating with
 * `tool.use` / `tool.result` and the underlying tool part). Payloads carry
 * short summaries only — never raw commands, prompts, or tool output.
 */
export interface TaskStartedEvent {
  type: "task.started"
  sessionId: string
  activeSessionId: string
  taskId: string
  messageId: string
  partId: string
  tool: string
  agent: string
  raw?: unknown
}

/**
 * Progress update for a runtime task, associated with its parent session and task identity.
 */
export interface TaskProgressEvent {
  type: "task.progress"
  sessionId: string
  activeSessionId: string
  taskId: string
  messageId: string
  partId: string
  tool: string
  agent: string
  title?: string
  elapsedMs: number
  raw?: unknown
}

/** `still_running` heartbeats for tools that stay silent past the server's heartbeat interval. */
export interface TaskNotificationEvent {
  type: "task.notification"
  sessionId: string
  activeSessionId: string
  taskId: string
  messageId: string
  partId: string
  tool: string
  agent: string
  kind: "still_running"
  elapsedMs: number
  message?: string
  raw?: unknown
}

/**
 * Terminal lifecycle event for a stopped runtime task, including its final status.
 */
export interface TaskStoppedEvent {
  type: "task.stopped"
  sessionId: string
  activeSessionId: string
  taskId: string
  messageId: string
  partId: string
  tool: string
  agent: string
  status: "completed" | "error" | "interrupted"
  durationMs: number
  title?: string
  error?: string
  raw?: unknown
}

/** Terminal event yielded at the end of every successful or failed run. */
export interface ResultMessage {
  subtype:
    | "success"
    | "error_max_turns"
    | "error_max_budget"
    | "error_during_execution"
    | "error_aborted"
    | "error_max_structured_output_retries"
  sessionId: string
  messageId?: string
  parentMessageId?: string
  stopReason?: string
  /**
   * Assistant text from every text part of the turn's final assistant
   * message, identified by `messageId`.
   *
   * Identical to the `text` on the `assistant` stream message with the same
   * `messageId`, so this and the last streamed assistant text can never
   * disagree.
   *
   * `undefined` when the turn produced no assistant text (a tool-only final
   * step, a result without a message id, or a hard failure before any matching
   * assistant message was observed). Use `text ?? ""` for a plain string —
   * which is exactly what `RunResult.text` does.
   *
   * Unlike Claude Agent SDK's `result` (success variant only), this is also
   * populated on error subtypes: on `error_aborted` it is the partial answer
   * produced before the interrupt.
   */
  text?: string
  turns: number
  durationMs: number
  totalCostUsd?: number
  usage?: UsageSummary
  modelUsage?: Record<string, ModelUsageSummary>
  structuredOutput?: unknown
  error?: { message: string; cause?: unknown }
}

/**
 * Token and cost accounting for a completed run, including optional provider/model breakdowns.
 */
export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  perModel?: Record<string, Omit<UsageSummary, "perModel">>
}

/**
 * Usage and pricing metadata for one provider/model within a session or result.
 */
export interface ModelUsageSummary extends Omit<UsageSummary, "perModel"> {
  costUsd: number
}

/**
 * Live cost/usage snapshot exposed by `session.usage`. Shapes match
 * `ResultMessage` so the two read the same way.
 *
 * Semantics: values accumulate from assistant messages observed on THIS
 * session handle (attached/resumed handles start at zero) and are reconciled
 * against each turn's authoritative `session.result` — so subagent
 * child-session cost appears once the turn completes, without double
 * counting. Monotonic: rewinds do not subtract.
 */
export interface SessionUsage {
  turns: number
  totalCostUsd: number
  usage: UsageSummary
  modelUsage: Record<string, ModelUsageSummary>
}

// --- Agents & subagents --------------------------------------------------

/**
 * Session-scoped subagent profile. Its prompt, model, tools and MCP servers apply to child tasks; spawnMode chooses fresh or inherited context.
 */
export interface AgentDefinition {
  prompt: string
  description?: string
  model?: ModelId
  tools?: string[]
  disallowedTools?: string[]
  mcpServers?: ExternalMcpServer[]
  permissionMode?: PermissionMode
  steps?: number
  temperature?: number
  /** fresh = new context; inherit = fork parent context. */
  spawnMode?: "fresh" | "inherit"
}

/**
 * Programmatic skill instructions and discovery metadata. A skill can restrict tools, choose a model and disable autonomous invocation.
 */
export interface SkillDefinition {
  name: string
  description: string
  content: string
  baseDir?: string
  allowedTools?: string[]
  model?: ModelId | { providerID: string; modelID: string }
  disableModelInvocation?: boolean
}

/**
 * Programmatic slash-command template with argument substitution, optional agent/model selection and tool policy.
 */
export interface CommandDefinition {
  name: string
  description?: string
  template: string
  agent?: string
  model?: ModelId
  subtask?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
}

/**
 * A named session-local bundle of skills, commands, agents, hooks and MCP server descriptors.
 */
export interface InlinePluginSpec {
  type: "inline"
  name: string
  description?: string
  version?: string
  skills?: SkillDefinition[]
  commands?: CommandDefinition[]
  agents?: Record<string, AgentDefinition>
  hooks?: HookRegistration
  mcpServers?: RuntimeMcpServer[]
}

/**
 * A local Claude-compatible plugin directory. Supported components are translated; unsupported components appear as diagnostics.
 */
export interface ClaudePluginSpec {
  type: "claude"
  path: string
}

/**
 * Either a programmatic inline plugin or a local compatible plugin directory.
 */
export type PluginSpec = InlinePluginSpec | ClaudePluginSpec

// --- Tools ---------------------------------------------------------------

/**
 * Definition of an in-process custom tool. The SDK hosts a local MCP server
 * (or, as an optimization, an in-process MCP transport) and exposes this
 * tool to the Cognitio runtime.
 */
export interface ToolDefinitionBase<Input = unknown, Output = unknown> {
  name: string
  description?: string
  execute(args: Input, ctx: ToolContext): Promise<Output> | Output
  metadata?: {
    searchHint?: string
    alwaysLoad?: boolean
  }
  annotations?: {
    readOnly?: boolean
    destructive?: boolean
    idempotent?: boolean
    openWorld?: boolean
  }
}

/**
 * A custom tool with an execution callback and either a Zod/JSON input schema or an explicit JSON Schema. Tool execution stays in the SDK process. The callback must validate invocation input before side effects; schema parsing is not automatic.
 */
export type ToolDefinition<Input = unknown, Output = unknown> = ToolDefinitionBase<Input, Output> &
  (
    | {
        /** Zod or JSON Schema. */
        inputSchema: unknown
        inputJsonSchema?: unknown
      }
    | {
        inputSchema?: undefined
        inputJsonSchema: unknown
      }
  )

/**
 * Identity and cancellation context for a caller-side tool, resource or prompt callback.
 */
export interface ToolContext {
  sessionId: string
  rootSessionId?: string
  signal: AbortSignal
  toolCallId?: string
}

/**
 * Descriptor for an SDK-owned MCP server. Direct transport supports tools; HTTP hosting additionally supports resources and prompts.
 */
export interface SdkMcpServer {
  name: string
  type?: "sdk"
  transport?: "http" | "direct"
  enabled?: boolean
  timeout?: number
  tools: ToolDefinition[]
  /** Resources served by an HTTP SDK MCP server. */
  resources?: McpResourceDefinition[]
  /** Prompt templates served by an HTTP SDK MCP server. */
  prompts?: McpPromptDefinition[]
}

/** An SDK-hosted MCP resource with a stable URI and a caller-side read callback. */
export interface McpResourceDefinition {
  name: string
  uri: string
  description?: string
  mimeType?: string
  /**
   * Read this resource for the requesting session.
   * @param context - Session identity and cancellation signal.
   * @returns MCP resource contents.
   */
  read(context: ToolContext): ReadResourceResult | Promise<ReadResourceResult>
}

/** An SDK-hosted MCP prompt; required arguments are checked before the callback runs. */
export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
  /**
   * Render this prompt after required arguments have been validated.
   * @param arguments_ - String arguments supplied by the MCP client.
   * @param context - Session identity and cancellation signal.
   * @returns MCP prompt messages.
   */
  get(arguments_: Record<string, string>, context: ToolContext): GetPromptResult | Promise<GetPromptResult>
}

/**
 * A session-owned external MCP connection over Streamable HTTP or legacy SSE. Supply explicit headers for authentication.
 */
export interface RemoteMcpServer {
  name: string
  type: "remote"
  url: string
  /** Explicit protocol, or automatic Streamable HTTP with legacy SSE fallback when omitted. */
  transport?: "http" | "sse"
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: false
  timeout?: number
}

/** Session-owned MCP subprocess. The runtime server starts and stops this process. */
export interface LocalMcpServer {
  name: string
  type: "local"
  command: string[]
  environment?: Record<string, string>
  cwd?: string
  timeout?: number
  enabled?: boolean
}

/** External MCP endpoints or subprocesses, usable by sessions, plugins, and subagents. */
export type ExternalMcpServer = RemoteMcpServer | LocalMcpServer

/**
 * Any MCP capability attached to a session: SDK-hosted functions, a remote endpoint, or a runtime-hosted subprocess.
 */
export type RuntimeMcpServer = SdkMcpServer | ExternalMcpServer

// --- Hooks (15 events) ---------------------------------------------------

/**
 * The supported Cognitio v2 lifecycle hook event names. This is not the current Claude SDK hook-name inventory.
 */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SessionEnd"
  | "SessionStateChange"
  | "BeforeShellExecution"
  | "AfterShellExecution"
  | "PermissionAsked"
  | "PermissionReplied"

/**
 * Context supplied before manual or automatic compaction, including token counts and existing instructions.
 */
export interface PreCompactHookData {
  trigger: "auto" | "manual"
  auto: boolean
  overflow?: boolean
  messageCount: number
  preCompactTokenCount: number
  customInstructions?: string
}

/**
 * Outcome supplied after compaction, including the boundary ID and preserved message metadata.
 */
export interface PostCompactHookData {
  trigger: "auto" | "manual"
  auto: boolean
  overflow?: boolean
  result: "continue" | "stop"
  compactionId?: string
  preCompactTokenCount?: number
  preservedMessageIds?: string[]
}

/**
 * Event-specific callback data: typed compaction payloads or the generic runtime event record.
 */
export type HookData<Event extends HookEventName> = Event extends "PreCompact"
  ? PreCompactHookData
  : Event extends "PostCompact"
    ? PostCompactHookData
    : Record<string, unknown>

/**
 * A hook invocation with session/tool identity, cancellation signal and event-specific data.
 */
export interface HookEventPayload<Event extends HookEventName = HookEventName> {
  event: Event
  sessionId: string
  rootSessionId?: string
  toolCallId?: string
  signal: AbortSignal
  data: HookData<Event>
}

/** Structured result shape (mirrors Claude Code hook JSON). */
export interface HookResult {
  continue?: boolean
  stopReason?: string
  permissionDecision?: PermissionDecision | "allow" | "deny" | "ask"
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: unknown
  systemMessage?: string
  additionalContext?: string
  /** Honored by `PreCompact`; multiple hook values are joined with blank lines. */
  customInstructions?: string
  initialUserMessage?: string
  /** Reserved for future compatibility; no watcher effect in v2. */
  watchPaths?: string[]
}

/**
 * A synchronous or asynchronous SDK-local callback invoked for a supported lifecycle event.
 */
export type HookCallback<Event extends HookEventName = HookEventName> = {
  /**
   * Handle an event in the SDK process.
   * @param payload - Event data and cancellation signal.
   * @returns Optional event-specific modifications or decisions.
   */
  callback(payload: HookEventPayload<Event>): Promise<HookResult | void> | HookResult | void
}["callback"]

/**
 * Completed compaction boundary with its identifier, pre-compaction token count, preserved messages and optional summary text.
 */
export interface CompactResult {
  compactionId: string
  preCompactTokenCount: number
  preservedMessageIds: string[]
  /** Text produced by the summary assistant, when available. */
  summaryText?: string
}

/**
 * Hook callback lists keyed by event name. Entries can be plain callbacks or matcher/timeout registrations.
 */
export type HookRegistration = {
  [Event in HookEventName]?: Array<HookEntry<Event> | HookCallback<Event>>
}

/**
 * A hook callback with an optional tool matcher, deadline and asynchronous-notification flag.
 */
export interface HookEntry<Event extends HookEventName = HookEventName> {
  matcher?: string | RegExp
  timeoutMs?: number
  async?: boolean
  /**
   * The SDK-local event handler. Decision fields are honored only for supported event types.
   */
  callback: HookCallback<Event>
}

// --- Permissions ---------------------------------------------------------

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string }
  | { behavior: "ask" }

/**
 * Application permission callback returning allow, deny or ask, optionally with replacement tool input.
 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { sessionId: string; rootSessionId?: string; signal: AbortSignal; toolCallId?: string },
) => Promise<PermissionDecision> | PermissionDecision

// --- Checkpoints ---------------------------------------------------------

/**
 * Identifier and metadata for a workspace file checkpoint owned by a session.
 */
export interface CheckpointHandle {
  id: string
  sessionId: string
  messageId?: string
  label?: string
  source: "manual" | "auto"
  metadata?: Record<string, unknown>
  createdAt: number
}

/**
 * Outcome of restoring a checkpoint, including the checkpoint identity and affected files.
 */
export type RewindResult = {
  checkpointId: string
  affectedFiles: string[]
}

/**
 * A persisted runtime todo entry returned by session.getTodos and the todo watcher.
 */
export type TodoItem = Todo

// --- Structured output ---------------------------------------------------

/**
 * JSON Schema output contract with a bounded schema-retry count. The generic parameter carries the expected application output type.
 */
export interface OutputFormatSpec<Output = unknown> {
  type: "json_schema"
  schema: unknown
  maxRetries?: number
  readonly __output?: Output
}
/**
 * Extract the output type from a format created with defineOutputFormat.
 */
export type OutputOf<Format> = Format extends OutputFormatSpec<infer Output> ? Output : never

// --- Prompt input --------------------------------------------------------

/**
 * One input part supported by the runtime: text, file, agent reference or subtask. Modality support depends on the selected model.
 */
export type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

/**
 * A single user turn containing optional text and typed parts.
 */
export interface PromptTurn {
  text?: string
  parts?: PromptPart[]
}

/**
 * Input to a run: text, a turn containing typed parts, or an asynchronous sequence of turns processed in order.
 */
export type PromptInput = string | PromptTurn | AsyncIterable<string | PromptTurn>

/**
 * Per-stream controls for partial-message emission and cancellation.
 */
export interface StreamOptions {
  includePartialMessages?: boolean
}

/**
 * Provider credential union accepted by spawn.auth: API key, OAuth tokens, or well-known authentication.
 */
export type Auth = WireAuth

/**
 * OAuth access/refresh credentials for an explicitly configured provider. Token expiry uses the runtime wire format.
 */
export type OAuth = WireOAuth

/**
 * An API-key credential with type api and a secret key string.
 */
export type ApiAuth = WireApiAuth

/**
 * A provider credential obtained through a configured well-known authentication endpoint.
 */
export type WellKnownAuth = WireWellKnownAuth

/**
 * Serializable instance-level runtime configuration supplied through spawn.config. For per-session policy use RuntimeConfig.
 */
export type CognitioConfig = WireCognitioConfig

/**
 * Persisted runtime session metadata, including ID, directory, title, parent and timestamps.
 */
export type CognitioSession = WireCognitioSession

/**
 * Raw persisted user or assistant message envelope from the HTTP API. Use AgentMessage for normalized SDK streams.
 */
export type CognitioMessage = WireCognitioMessage

/**
 * Raw runtime message part union, including text, files, reasoning and tool states.
 */
export type CognitioPart = WireCognitioPart

/**
 * Raw runtime event union used by the HTTP/SSE protocol. Use AgentMessage for high-level stream consumers.
 */
export type CognitioEvent = WireCognitioEvent

/**
 * Ordered runtime permission rules containing permission, pattern and action fields.
 */
export type PermissionRuleset = WirePermissionRuleset
