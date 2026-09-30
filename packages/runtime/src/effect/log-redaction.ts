import { createHash } from "node:crypto"
import type { OtlpLogger, OtlpResource } from "effect/unstable/observability"

// Runtime diagnostics contain prompts, shell arguments, MCP stderr and provider
// errors. Export operational metadata, never infer that an arbitrary log body
// is safe because it lacks a recognizable credential pattern. Local logs keep
// their existing diagnostic detail; AI span input/output opt-ins are separate.
const services = new Set([
  "acp-agent",
  "acp-command",
  "acp-session-manager",
  "bash-tool",
  "bus",
  "config",
  "db",
  "default",
  "fence",
  "file",
  "file.watcher",
  "format",
  "heap",
  "ide",
  "instruction",
  "json-migration",
  "llm",
  "logging",
  "lsp",
  "lsp.client",
  "lsp.server",
  "mcp",
  "mcp.oauth",
  "mcp.oauth-callback",
  "mdns",
  "models.dev",
  "patch",
  "permission",
  "plugin",
  "plugin.codex",
  "plugin.copilot",
  "project",
  "provider",
  "pty",
  "question",
  "ripgrep",
  "server",
  "server.sync",
  "server.workspace",
  "session",
  "session.compaction",
  "session.processor",
  "session.projector",
  "session.prompt",
  "session.revert",
  "share-next",
  "skill",
  "skill-discovery",
  "snapshot",
  "storage",
  "tool.registry",
  "truncation",
  "tui.config",
  "tui.migrate",
  "tui.plugin",
  "vcs",
  "workspace-router",
  "workspace-sync",
  "worktree",
])
const numbers = new Set([
  "fiberId",
  "duration",
  "elapsed",
  "latency",
  "count",
  "size",
  "attempt",
  "attempts",
  "retry",
  "retries",
  "retryAfterMs",
  "delay",
  "timeout",
  "maxRetries",
  "statusCode",
  "http.response.status_code",
  "tokens",
  "cost",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "dropped",
  "droppedCount",
  "pid",
  "port",
  "depth",
  "limit",
  "offset",
])
const booleans = new Set(["success", "enabled", "cached", "allowed", "denied", "aborted", "cancelled"])
const outcomes = new Set([
  "started",
  "completed",
  "success",
  "failure",
  "failed",
  "error",
  "pending",
  "running",
  "idle",
  "busy",
  "stopped",
  "closed",
  "connected",
  "disconnected",
  "cancelled",
  "canceled",
  "aborted",
  "allowed",
  "denied",
  "allow",
  "deny",
  "ask",
  "once",
  "always",
  "reject",
  "timeout",
  "rate_limited",
])
const identifiers = new Set([
  "session.id",
  "sessionID",
  "messageID",
  "parentID",
  "projectID",
  "workspaceID",
  "providerID",
  "modelID",
  "toolCallId",
  "toolCallID",
  "run_id",
  "cognitio.run_id",
])
const frameworkIDs: Record<string, RegExp> = {
  "session.id": /^ses_[a-zA-Z0-9]{20,40}$/,
  sessionID: /^ses_[a-zA-Z0-9]{20,40}$/,
  messageID: /^msg_[a-zA-Z0-9]{20,40}$/,
  parentID: /^(ses|msg)_[a-zA-Z0-9]{20,40}$/,
  workspaceID: /^wrk_[a-zA-Z0-9]{20,40}$/,
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function attribute(entry: OtlpResource.KeyValue): OtlpResource.KeyValue[] {
  if (entry.key === "service" && typeof entry.value.stringValue === "string") {
    return services.has(entry.value.stringValue)
      ? [{ key: entry.key, value: { stringValue: entry.value.stringValue } }]
      : [{ key: "service.hash", value: { stringValue: hash(entry.value.stringValue) } }]
  }
  if (numbers.has(entry.key)) {
    const value = entry.value.intValue ?? entry.value.doubleValue
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? [{ key: entry.key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } }]
      : []
  }
  if (booleans.has(entry.key))
    return typeof entry.value.boolValue === "boolean"
      ? [{ key: entry.key, value: { boolValue: entry.value.boolValue } }]
      : []
  if (["status", "outcome", "action", "decision"].includes(entry.key)) {
    return typeof entry.value.stringValue === "string" && outcomes.has(entry.value.stringValue)
      ? [{ key: entry.key, value: { stringValue: entry.value.stringValue } }]
      : []
  }
  if (entry.key === "method") {
    return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(entry.value.stringValue ?? "")
      ? [{ key: entry.key, value: { stringValue: entry.value.stringValue } }]
      : []
  }
  if (identifiers.has(entry.key) && typeof entry.value.stringValue === "string") {
    // Preserve runtime-generated IDs for direct correlation. User-supplied
    // model/provider labels and opaque identifiers get a stable opaque hash.
    if (frameworkIDs[entry.key]?.test(entry.value.stringValue))
      return [{ key: entry.key, value: { stringValue: entry.value.stringValue } }]
    return [{ key: `${entry.key}.hash`, value: { stringValue: hash(entry.value.stringValue) } }]
  }
  return []
}

/** Redact log payloads at the export boundary, without changing local output. */
export function redactLogData(data: OtlpLogger.LogsData): OtlpLogger.LogsData {
  return {
    resourceLogs: data.resourceLogs.map((resource) => ({
      ...resource,
      scopeLogs: resource.scopeLogs.map((scope) => ({
        ...scope,
        logRecords: scope.logRecords?.map((record) => {
          const attributes = record.attributes.flatMap(attribute)
          return {
            ...record,
            body: { stringValue: "[redacted]" },
            attributes,
            droppedAttributesCount: record.droppedAttributesCount + record.attributes.length - attributes.length,
          }
        }),
      })),
    })),
  }
}
