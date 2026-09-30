/**
 * Cognitio Agent SDK: programmable agents, tools, sessions and permissions.
 * Built on OpenCode, with a bundled runtime and a vendored HTTP client.
 */

export { createAgentClient } from "./client.js"
export type { AgentClient, SessionNamespace } from "./client.js"

export { Agent } from "./agent.js"
export type {
  AgentOptions,
  RunOptions,
  AgentStreamOptions,
  AgentSessionOptions,
  RunResult,
  AgentStream,
} from "./agent.js"
export { query } from "./query.js"
export type { QueryOptions, Query } from "./query.js"
export { shutdown } from "./internal/shared-client.js"

export { NEUTRAL_BASE_PROMPT } from "./internal/neutral-prompt.js"

export { Session } from "./session.js"
export type { SessionContext } from "./session.js"

export {
  defineTool,
  createSdkMcpServer,
  defineAgent,
  defineSkill,
  defineCommand,
  definePlugin,
  claudeCompat,
  defineHook,
  defineOutputFormat,
} from "./tools/index.js"
export { PermissionDecision } from "./permissions.js"
export { models } from "./models.js"
export { isSdkError } from "./errors.js"
export type { SdkError, SdkErrorKind } from "./errors.js"

export type {
  // Client / transport
  ClientOptions,
  ControlOptions,
  SpawnOptions,
  SpawnServerRequest,
  TransportKind,
  // Hermetic spawn
  AuthContent,
  Auth,
  OAuth,
  ApiAuth,
  WellKnownAuth,
  CognitioConfig,
  // Runtime config
  RuntimeConfig,
  ThinkingConfig,
  CheckpointingConfig,
  SessionResumeOptions,
  ModelId,
  KnownModelId,
  AnthropicModelId,
  OpenaiModelId,
  GoogleModelId,
  XaiModelId,
  GroqModelId,
  MistralModelId,
  DeepseekModelId,
  SystemPromptSpec,
  PermissionMode,
  SessionCreateOptions,
  SessionListFilter,
  AppliedSettings,
  CompactResult,
  // Stream
  AgentMessage,
  ResultMessage,
  UsageSummary,
  ModelUsageSummary,
  SessionUsage,
  PromptInput,
  PromptPart,
  PromptTurn,
  StreamOptions,
  // Observability events
  RateLimitEvent,
  TaskStartedEvent,
  TaskProgressEvent,
  TaskNotificationEvent,
  TaskStoppedEvent,
  // Agents / subagents
  AgentDefinition,
  SkillDefinition,
  CommandDefinition,
  InlinePluginSpec,
  ClaudePluginSpec,
  PluginSpec,
  // Tools
  ToolDefinition,
  ToolContext,
  SdkMcpServer,
  RemoteMcpServer,
  LocalMcpServer,
  ExternalMcpServer,
  McpResourceDefinition,
  McpPromptDefinition,
  RuntimeMcpServer,
  // Hooks
  HookEventName,
  HookEventPayload,
  HookData,
  PreCompactHookData,
  PostCompactHookData,
  HookResult,
  HookCallback,
  HookRegistration,
  HookEntry,
  // Permissions
  CanUseToolCallback,
  // Checkpoints
  CheckpointHandle,
  RewindResult,
  TodoItem,
  // Structured output
  OutputFormatSpec,
  OutputOf,
  // Re-exports from the low-level SDK
  CognitioSession,
  CognitioMessage,
  CognitioPart,
  CognitioEvent,
  PermissionRuleset,
} from "./types.js"
