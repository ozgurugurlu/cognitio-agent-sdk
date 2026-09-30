import { Slug } from "@cognitio/shared/util/slug"
import { AppFileSystem } from "@cognitio/shared/filesystem"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionMetrics } from "@/effect/metrics"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata, type LanguageModelUsage } from "ai"
import { Flag } from "../flag/flag"
import { InstallationVersion } from "../installation/version"

import { Database, NotFoundError, eq, and, gte, isNull, desc, like, inArray, lt, sql } from "../storage"
import { SyncEvent } from "../sync"
import type { SQL } from "../storage"
import { PartTable, SessionCheckpointTable, SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage"
import { Log } from "../util"
import { updateSchema } from "../util/update-schema"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { InstanceState } from "@/effect"
import { Snapshot } from "@/snapshot"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { RuntimePlugin } from "@/plugin/runtime"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRuntimeConfig } from "./runtime-config"
import { HookBridge } from "./hook-bridge"

import type { Provider } from "@/provider"
import { Permission } from "@/permission"
import { Global } from "@/global"
import { Effect, Layer, Option, Context } from "effect"

const log = Log.create({ service: "session" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function normalizeTags(tags: string[] | undefined) {
  if (!tags) return []
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)))
}

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert
    ? {
        ...row.revert,
        checkpointId: row.revert.checkpointId ?? row.revert.snapshot,
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    parentID: row.parent_id ?? undefined,
    forkedFrom: row.fork_of ?? undefined,
    title: row.title,
    tags: normalizeTags(row.tags ?? undefined),
    version: row.version,
    summary,
    share,
    revert,
    permission: row.permission ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    fork_of: info.forkedFrom,
    slug: info.slug,
    directory: info.directory,
    title: info.title,
    tags: normalizeTags(info.tags),
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

export const Info = z
  .object({
    id: SessionID.zod,
    slug: z.string(),
    projectID: ProjectID.zod,
    workspaceID: WorkspaceID.zod.optional(),
    directory: z.string(),
    parentID: SessionID.zod.optional(),
    forkedFrom: SessionID.zod.optional(),
    summary: z
      .object({
        additions: z.number(),
        deletions: z.number(),
        files: z.number(),
        diffs: Snapshot.FileDiff.array().optional(),
      })
      .optional(),
    share: z
      .object({
        url: z.string(),
      })
      .optional(),
    title: z.string(),
    tags: z.string().array().default([]),
    version: z.string(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      compacting: z.number().optional(),
      archived: z.number().optional(),
    }),
    permission: Permission.Ruleset.zod.optional(),
    revert: z
      .object({
        messageID: MessageID.zod,
        partID: PartID.zod.optional(),
        snapshot: z.string().optional(),
        checkpointId: z.string().optional(),
        diff: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    ref: "Session",
  })
export type Info = z.output<typeof Info>

export const ProjectInfo = z
  .object({
    id: ProjectID.zod,
    name: z.string().optional(),
    worktree: z.string(),
  })
  .meta({
    ref: "ProjectSummary",
  })
export type ProjectInfo = z.output<typeof ProjectInfo>

export const GlobalInfo = Info.extend({
  project: ProjectInfo.nullable(),
}).meta({
  ref: "GlobalSession",
})
export type GlobalInfo = z.output<typeof GlobalInfo>

export const CreateInput = z
  .object({
    parentID: SessionID.zod.optional(),
    title: z.string().optional(),
    permission: Info.shape.permission,
    workspaceID: WorkspaceID.zod.optional(),
    runtimeConfig: SessionRuntimeConfig.RuntimeConfig.optional(),
  })
  .optional()
export type CreateInput = z.output<typeof CreateInput>

export const ForkInput = z.object({ sessionID: SessionID.zod, messageID: MessageID.zod.optional() })
export const GetInput = SessionID.zod
export const ChildrenInput = SessionID.zod
export const RemoveInput = SessionID.zod
export const SetTitleInput = z.object({ sessionID: SessionID.zod, title: z.string() })
export const SetTagsInput = z.object({ sessionID: SessionID.zod, tags: z.string().array() })
export const SetArchivedInput = z.object({ sessionID: SessionID.zod, time: z.number().optional() })
export const SetPermissionInput = z.object({ sessionID: SessionID.zod, permission: Permission.Ruleset.zod })
export const SetRevertInput = z.object({
  sessionID: SessionID.zod,
  revert: Info.shape.revert,
  summary: Info.shape.summary,
})
export const MessagesInput = z.object({ sessionID: SessionID.zod, limit: z.number().optional() })

export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: updateSchema(Info).extend({
        share: updateSchema(Info.shape.share.unwrap()).optional(),
        time: updateSchema(Info.shape.time).optional(),
      }),
    }),
    busSchema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Deleted: SyncEvent.define({
    type: "session.deleted",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Diff: BusEvent.define(
    "session.diff",
    z.object({
      sessionID: SessionID.zod,
      diff: Snapshot.FileDiff.array(),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    z.object({
      sessionID: SessionID.zod.optional(),
      // z.lazy defers access to break circular dep: session → message-v2 → provider → plugin → session
      error: z.lazy(() => MessageV2.Assistant.shape.error),
    }),
  ),
  Result: BusEvent.define(
    "session.result",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod.optional(),
      parentMessageID: MessageID.zod.optional(),
      subtype: z.enum([
        "success",
        "error_aborted",
        "error_during_execution",
        "error_max_turns",
        "error_max_budget",
        "error_max_structured_output_retries",
      ]),
      stopReason: z.string().optional(),
      finalText: z.string().optional(),
      numTurns: z.number().int().nonnegative().optional(),
      totalCostUsd: z.number().optional(),
      usage: MessageV2.Assistant.shape.tokens.optional(),
      modelUsage: z
        .record(
          z.string(),
          z.object({
            tokens: MessageV2.Assistant.shape.tokens,
            cost: z.number(),
          }),
        )
        .optional(),
      error: z
        .object({
          name: z.string(),
          message: z.string(),
        })
        .optional(),
      structuredOutput: z.any().optional(),
    }),
  ),
  SubagentStarted: BusEvent.define(
    "subagent.started",
    z.object({
      sessionID: SessionID.zod,
      parentSessionID: SessionID.zod,
      childSessionID: SessionID.zod,
      agent: z.string(),
      messageID: MessageID.zod,
      callID: z.string().optional(),
      taskID: SessionID.zod,
      spawnMode: z.enum(["fresh", "inherit"]),
    }),
  ),
  SubagentProgress: BusEvent.define(
    "subagent.progress",
    z.object({
      sessionID: SessionID.zod,
      parentSessionID: SessionID.zod,
      childSessionID: SessionID.zod,
      agent: z.string(),
      messageID: MessageID.zod,
      callID: z.string().optional(),
      taskID: SessionID.zod,
      spawnMode: z.enum(["fresh", "inherit"]),
      status: z.string(),
      title: z.string().optional(),
    }),
  ),
  SubagentStopped: BusEvent.define(
    "subagent.stopped",
    z.object({
      sessionID: SessionID.zod,
      parentSessionID: SessionID.zod,
      childSessionID: SessionID.zod,
      agent: z.string(),
      messageID: MessageID.zod,
      callID: z.string().optional(),
      taskID: SessionID.zod,
      spawnMode: z.enum(["fresh", "inherit"]),
      status: z.enum(["completed", "error", "cancelled"]),
      result: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  // Observability events (Phase 10). Root-routed like subagent.*: `sessionID`
  // carries the root session so parent SDK streams observe child activity;
  // `activeSessionID` is the session the event actually happened in.
  //
  // `retryAfterSeconds` is the parsed retry-after header when present,
  // otherwise the backoff delay actually chosen; absent on the non-retryable
  // (halt) path.
  RateLimitHit: BusEvent.define(
    "session.rate_limit_hit",
    z.object({
      sessionID: SessionID.zod,
      activeSessionID: SessionID.zod,
      provider: z.string(),
      model: z.string().optional(),
      attempt: z.number().int().positive().optional(),
      retryAfterSeconds: z.number().nonnegative().optional(),
      message: z.string().optional(),
    }),
  ),
  // Task events describe individual tool-call executions (taskID = tool call
  // ID). Payloads deliberately exclude raw commands, prompts, stdout, and
  // stack traces so they can be forwarded to dashboards standalone; title /
  // message / error are short, truncated summaries (titles are tool-provided
  // and may contain relative paths or glob patterns).
  TaskStarted: BusEvent.define(
    "task.started",
    z.object({
      sessionID: SessionID.zod,
      activeSessionID: SessionID.zod,
      taskID: z.string(),
      messageID: MessageID.zod,
      partID: z.string(),
      tool: z.string(),
      agent: z.string(),
    }),
  ),
  TaskProgress: BusEvent.define(
    "task.progress",
    z.object({
      sessionID: SessionID.zod,
      activeSessionID: SessionID.zod,
      taskID: z.string(),
      messageID: MessageID.zod,
      partID: z.string(),
      tool: z.string(),
      agent: z.string(),
      title: z.string().optional(),
      elapsedMs: z.number().nonnegative(),
    }),
  ),
  TaskNotification: BusEvent.define(
    "task.notification",
    z.object({
      sessionID: SessionID.zod,
      activeSessionID: SessionID.zod,
      taskID: z.string(),
      messageID: MessageID.zod,
      partID: z.string(),
      tool: z.string(),
      agent: z.string(),
      kind: z.enum(["still_running"]),
      elapsedMs: z.number().nonnegative(),
      message: z.string().optional(),
    }),
  ),
  TaskStopped: BusEvent.define(
    "task.stopped",
    z.object({
      sessionID: SessionID.zod,
      activeSessionID: SessionID.zod,
      taskID: z.string(),
      messageID: MessageID.zod,
      partID: z.string(),
      tool: z.string(),
      agent: z.string(),
      status: z.enum(["completed", "error", "interrupted"]),
      durationMs: z.number().nonnegative(),
      title: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
}

export function plan(input: { slug: string; time: { created: number } }) {
  const base = Instance.project.vcs
    ? path.join(Instance.worktree, ".cognitio", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: LanguageModelUsage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return value
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.outputTokenDetails?.reasoningTokens ?? input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(
    input.usage.inputTokenDetails?.cacheReadTokens ?? input.usage.cachedInputTokens ?? 0,
  )
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.inputTokenDetails?.cacheWriteTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const costInfo =
    input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost
  return {
    cost: safe(
      new Decimal(0)
        .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
        .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
        // TODO: update models.dev to have better pricing model, for now:
        // charge reasoning tokens at the same rate as output tokens
        .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
        .toNumber(),
    ),
    tokens,
  }
}

export class BusyError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Session ${sessionID} is busy`)
  }
}

export interface Interface {
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    permission?: Permission.Ruleset
    workspaceID?: WorkspaceID
    runtimeConfig?: SessionRuntimeConfig.RuntimeConfig
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setTags: (input: { sessionID: SessionID; tags: string[] }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: Permission.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[]>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  readonly updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<MessageV2.Part | undefined>
  readonly updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/Session") {}

type Patch = z.infer<typeof Event.Updated.schema>["info"]

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

export const layer: Layer.Layer<Service, never, Bus.Service | Storage.Service | SessionRuntimeConfig.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const storage = yield* Storage.Service
      const runtimeConfig = yield* SessionRuntimeConfig.Service

      const createNext = Effect.fn("Session.createNext")(function* (input: {
        id?: SessionID
        title?: string
        parentID?: SessionID
        forkedFrom?: SessionID
        workspaceID?: WorkspaceID
        directory: string
        permission?: Permission.Ruleset
        tags?: string[]
      }) {
        const ctx = yield* InstanceState.context
        const result: Info = {
          id: SessionID.descending(input.id),
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: ctx.project.id,
          directory: input.directory,
          workspaceID: input.workspaceID,
          parentID: input.parentID,
          forkedFrom: input.forkedFrom,
          title: input.title ?? createDefaultTitle(!!input.parentID),
          tags: normalizeTags(input.tags),
          permission: input.permission,
          time: {
            created: Date.now(),
            updated: Date.now(),
          },
        }
        log.info("created", result)

        // Counts every session record: roots, forks, and subagent children all
        // funnel through createNext.
        yield* SessionMetrics.recordSession()
        yield* Effect.sync(() => SyncEvent.run(Event.Created, { sessionID: result.id, info: result }))

        if (!Flag.COGNITIO_EXPERIMENTAL_WORKSPACES) {
          // This only exist for backwards compatibility. We should not be
          // manually publishing this event; it is a sync event now
          yield* bus.publish(Event.Updated, {
            sessionID: result.id,
            info: result,
          })
        }

        return result
      })

      const get = Effect.fn("Session.get")(function* (id: SessionID) {
        const row = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
        return fromRow(row)
      })

      const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
        const rows = yield* db((d) =>
          d
            .select()
            .from(SessionTable)
            .where(and(eq(SessionTable.parent_id, parentID)))
            .all(),
        )
        return rows.map(fromRow)
      })

      const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
        try {
          const session = yield* get(sessionID)
          const kids = yield* children(sessionID)
          for (const child of kids) {
            yield* remove(child.id)
          }
          const plugin = yield* Effect.serviceOption(Plugin.Service)
          if (Option.isSome(plugin)) {
            yield* plugin.value.trigger("session.end", { sessionID }, {}).pipe(Effect.catchCause(() => Effect.void))
          }
          yield* HookBridge.notify({ sessionID, event: "SessionEnd", data: {} })
          yield* runtimeConfig.clear(sessionID).pipe(Effect.catchCause(() => Effect.void))
          yield* RuntimePlugin.clear(sessionID).pipe(Effect.catchCause(() => Effect.void))
          const mcp = yield* Effect.serviceOption(MCP.Service)
          if (Option.isSome(mcp)) yield* mcp.value.clearRuntime(sessionID).pipe(Effect.catchCause(() => Effect.void))

          // `remove` needs to work in all cases, such as a broken
          // sessions that run cleanup. In certain cases these will
          // run without any instance state, so we need to turn off
          // publishing of events in that case
          const hasInstance = yield* InstanceState.directory.pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )

          yield* Effect.sync(() => {
            SyncEvent.run(Event.Deleted, { sessionID, info: session }, { publish: hasInstance })
            SyncEvent.remove(sessionID)
          })
        } catch (e) {
          log.error(e)
        }
      })

      const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => SyncEvent.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg }))
          return msg
        }).pipe(Effect.withSpan("Session.updateMessage"))

      const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            SyncEvent.run(MessageV2.Event.PartUpdated, {
              sessionID: part.sessionID,
              part: structuredClone(part),
              time: Date.now(),
            }),
          )
          return part
        }).pipe(Effect.withSpan("Session.updatePart"))

      const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
        const row = Database.use((db) =>
          db
            .select()
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, input.sessionID),
                eq(PartTable.message_id, input.messageID),
                eq(PartTable.id, input.partID),
              ),
            )
            .get(),
        )
        if (!row) return
        return {
          ...row.data,
          id: row.id,
          sessionID: row.session_id,
          messageID: row.message_id,
        } as MessageV2.Part
      })

      const create = Effect.fn("Session.create")(function* (input?: {
        parentID?: SessionID
        title?: string
        permission?: Permission.Ruleset
        workspaceID?: WorkspaceID
        runtimeConfig?: SessionRuntimeConfig.RuntimeConfig
      }) {
        const directory = yield* InstanceState.directory
        const workspace = yield* InstanceState.workspaceID
        if (input?.runtimeConfig?.plugins !== undefined) {
          yield* RuntimePlugin.materialize({ plugins: input.runtimeConfig.plugins })
        }
        const result = yield* createNext({
          parentID: input?.parentID,
          directory,
          title: input?.title,
          permission: input?.permission,
          workspaceID: workspace,
        })
        if (input?.runtimeConfig) {
          const next = yield* runtimeConfig.set({ sessionID: result.id, config: input.runtimeConfig })
          const mcp = yield* Effect.serviceOption(MCP.Service)
          if (
            Option.isSome(mcp) &&
            (input.runtimeConfig.sdkMcpServers !== undefined || input.runtimeConfig.plugins !== undefined)
          ) {
            const expanded = yield* RuntimePlugin.expand(next, result.id)
            yield* mcp.value.syncRuntime(result.id, expanded.sdkMcpServers ?? [])
          }
        }
        const plugin = yield* Effect.serviceOption(Plugin.Service)
        if (Option.isSome(plugin)) {
          yield* plugin.value
            .trigger("session.start", { sessionID: result.id }, {})
            .pipe(Effect.catchCause(() => Effect.void))
        }
        yield* HookBridge.notify({ sessionID: result.id, event: "SessionStart", data: {} })
        return result
      })

      const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
        const original = yield* get(input.sessionID)
        const msgs = yield* messages({ sessionID: input.sessionID })
        const cutoff = input.messageID ? msgs.findIndex((msg) => msg.info.id === input.messageID) : -1
        if (input.messageID && cutoff === -1) {
          throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
        }
        const title = getForkedTitle(original.title)
        const session = yield* createNext({
          directory: original.directory,
          workspaceID: original.workspaceID,
          parentID: original.id,
          // Marks the lineage boundary: forks keep parent_id for listing/UX,
          // but control/observability routing must treat them as roots.
          forkedFrom: original.id,
          title,
          tags: original.tags,
          permission: original.permission,
        })
        const inherited = structuredClone(yield* runtimeConfig.get(input.sessionID))
        // Callback IDs belong to the original client connection, so bare forks
        // inherit serializable policy but require callbacks to be reattached.
        delete inherited.hooks
        delete inherited.canUseTool
        const independentMcp = (server: SessionRuntimeConfig.RuntimeMcpServer) =>
          server.type !== "sdk" && !(server.type === "remote" && server.ownership === "sdk")
        inherited.sdkMcpServers = inherited.sdkMcpServers?.filter(independentMcp)
        if (inherited.plugins)
          inherited.plugins = inherited.plugins.map((plugin) => {
            if (plugin.type !== "inline") return plugin
            const copy = { ...plugin }
            delete copy.hooks
            copy.mcpServers = copy.mcpServers?.filter(independentMcp)
            return copy
          })
        yield* runtimeConfig.set({ sessionID: session.id, config: inherited })
        const idMap = new Map<string, MessageID>()

        for (const [index, msg] of msgs.entries()) {
          if (cutoff >= 0 && index > cutoff) break
          const newID = MessageID.ascending()
          idMap.set(msg.info.id, newID)

          const source = msg.info
          const parentMessageID = source.parentMessageID ? idMap.get(source.parentMessageID) : undefined
          const cloned =
            source.role === "assistant"
              ? yield* Effect.gen(function* () {
                  const parentID = idMap.get(source.parentID)
                  if (!parentID) {
                    log.warn("skipping forked assistant with unmapped parent", {
                      sourceSessionID: input.sessionID,
                      forkedSessionID: session.id,
                      messageID: source.id,
                      parentID: source.parentID,
                    })
                    return
                  }
                  const { parentID: _ignoredParentID, parentMessageID: _ignoredParentMessageID, ...rest } = source
                  return yield* updateMessage({
                    ...rest,
                    sessionID: session.id,
                    id: newID,
                    parentID,
                    ...(parentMessageID && { parentMessageID }),
                  } satisfies MessageV2.Assistant)
                })
              : yield* Effect.gen(function* () {
                  const { parentMessageID: _ignoredParentMessageID, ...rest } = source
                  return yield* updateMessage({
                    ...rest,
                    sessionID: session.id,
                    id: newID,
                    ...(parentMessageID && { parentMessageID }),
                  } satisfies MessageV2.User)
                })
          if (!cloned) continue

          for (const part of msg.parts) {
            yield* updatePart({
              ...part,
              id: PartID.ascending(),
              messageID: cloned.id,
              sessionID: session.id,
            })
          }
        }
        yield* db((d) => {
          const rows = d
            .select()
            .from(SessionCheckpointTable)
            .where(eq(SessionCheckpointTable.session_id, input.sessionID))
            .all()
          const values = rows.flatMap((row) => {
            const messageID = row.message_id ? idMap.get(row.message_id) : undefined
            if (row.message_id && !messageID) return []
            return [
              {
                ...row,
                session_id: session.id,
                message_id: messageID ?? null,
              },
            ]
          })
          if (values.length > 0) d.insert(SessionCheckpointTable).values(values).run()
        })
        return session
      })

      const patch = (sessionID: SessionID, info: Patch) =>
        Effect.sync(() => SyncEvent.run(Event.Updated, { sessionID, info }))

      const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
        yield* patch(sessionID, { time: { updated: Date.now() } })
      })

      const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
        yield* patch(input.sessionID, { title: input.title })
      })

      const setTags = Effect.fn("Session.setTags")(function* (input: { sessionID: SessionID; tags: string[] }) {
        yield* patch(input.sessionID, { tags: normalizeTags(input.tags), time: { updated: Date.now() } })
      })

      const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
        yield* patch(input.sessionID, { time: { archived: input.time } })
      })

      const setPermission = Effect.fn("Session.setPermission")(function* (input: {
        sessionID: SessionID
        permission: Permission.Ruleset
      }) {
        yield* patch(input.sessionID, { permission: input.permission, time: { updated: Date.now() } })
      })

      const setRevert = Effect.fn("Session.setRevert")(function* (input: {
        sessionID: SessionID
        revert: Info["revert"]
        summary: Info["summary"]
      }) {
        yield* patch(input.sessionID, { summary: input.summary, time: { updated: Date.now() }, revert: input.revert })
      })

      const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
        yield* patch(sessionID, { time: { updated: Date.now() }, revert: null })
      })

      const setSummary = Effect.fn("Session.setSummary")(function* (input: {
        sessionID: SessionID
        summary: Info["summary"]
      }) {
        yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary })
      })

      const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
        return yield* storage
          .read<Snapshot.FileDiff[]>(["session_diff", sessionID])
          .pipe(Effect.orElseSucceed((): Snapshot.FileDiff[] => []))
      })

      const messages = Effect.fn("Session.messages")(function* (input: { sessionID: SessionID; limit?: number }) {
        if (input.limit) {
          return MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).items
        }
        return Array.from(MessageV2.stream(input.sessionID)).reverse()
      })

      const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
        sessionID: SessionID
        messageID: MessageID
      }) {
        yield* Effect.sync(() =>
          SyncEvent.run(MessageV2.Event.Removed, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          }),
        )
        return input.messageID
      })

      const removePart = Effect.fn("Session.removePart")(function* (input: {
        sessionID: SessionID
        messageID: MessageID
        partID: PartID
      }) {
        yield* Effect.sync(() =>
          SyncEvent.run(MessageV2.Event.PartRemoved, {
            sessionID: input.sessionID,
            messageID: input.messageID,
            partID: input.partID,
          }),
        )
        return input.partID
      })

      const updatePartDelta = Effect.fnUntraced(function* (input: {
        sessionID: SessionID
        messageID: MessageID
        partID: PartID
        field: string
        delta: string
      }) {
        yield* bus.publish(MessageV2.Event.PartDelta, input)
      })

      /** Finds the first message matching the predicate, searching newest-first. */
      const findMessage = Effect.fn("Session.findMessage")(function* (
        sessionID: SessionID,
        predicate: (msg: MessageV2.WithParts) => boolean,
      ) {
        for (const item of MessageV2.stream(sessionID)) {
          if (predicate(item)) return Option.some(item)
        }
        return Option.none<MessageV2.WithParts>()
      })

      return Service.of({
        create,
        fork,
        touch,
        get,
        setTitle,
        setTags,
        setArchived,
        setPermission,
        setRevert,
        clearRevert,
        setSummary,
        diff,
        messages,
        children,
        remove,
        updateMessage,
        removeMessage,
        removePart,
        updatePart,
        getPart,
        updatePartDelta,
        findMessage,
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SessionRuntimeConfig.defaultLayer),
)

export function* list(input?: {
  directory?: string
  workspaceID?: WorkspaceID
  roots?: boolean
  start?: number
  search?: string
  tag?: string
  limit?: number
}) {
  const project = Instance.project
  const conditions = [eq(SessionTable.project_id, project.id)]

  if (input?.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (!Flag.COGNITIO_EXPERIMENTAL_WORKSPACES) {
    if (input?.directory) {
      // Instance creation stores canonical host paths, including symlink resolution.
      conditions.push(eq(SessionTable.directory, AppFileSystem.resolve(input.directory)))
    }
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (input?.tag) {
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${SessionTable.tags}) WHERE value = ${input.tag})`)
  }

  const limit = input?.limit ?? 100

  const rows = Database.use((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(...conditions))
      .orderBy(desc(SessionTable.time_updated))
      .limit(limit)
      .all(),
  )
  for (const row of rows) {
    yield fromRow(row)
  }
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  tag?: string
  limit?: number
  archived?: boolean
}) {
  const conditions: SQL[] = []

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, AppFileSystem.resolve(input.directory)))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor) {
    conditions.push(lt(SessionTable.time_updated, input.cursor))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (input?.tag) {
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${SessionTable.tags}) WHERE value = ${input.tag})`)
  }
  if (!input?.archived) {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  const rows = Database.use((db) => {
    const query =
      conditions.length > 0
        ? db
            .select()
            .from(SessionTable)
            .where(and(...conditions))
        : db.select().from(SessionTable)
    return query.orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(limit).all()
  })

  const ids = [...new Set(rows.map((row) => row.project_id))]
  const projects = new Map<string, ProjectInfo>()

  if (ids.length > 0) {
    const items = Database.use((db) =>
      db
        .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all(),
    )
    for (const item of items) {
      projects.set(item.id, {
        id: item.id,
        name: item.name ?? undefined,
        worktree: item.worktree,
      })
    }
  }

  for (const row of rows) {
    const project = projects.get(row.project_id) ?? null
    yield { ...fromRow(row), project }
  }
}
