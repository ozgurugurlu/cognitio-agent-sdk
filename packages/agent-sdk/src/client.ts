import { sdkError } from "./errors.js"
import type { Session as CognitioSession } from "./internal/runtime-client/index.js"
import type {
  ClientOptions,
  RuntimeMcpServer,
  SdkMcpServer,
  SessionCreateOptions,
  SessionListFilter,
  SessionResumeOptions,
} from "./types.js"
import { resolveTransport, type Transport } from "./transport/index.js"
import { Session } from "./session.js"
import { assertOk } from "./internal/errors.js"
import { applyCreateDefaults, normalizeRuntimeConfig } from "./internal/runtime-config.js"
import { startSdkMcpServers, stopSdkMcpHosts, type SdkMcpHost } from "./tools/mcp-server.js"

/**
 * An owned connection to a Cognitio runtime and its session handles. Closing it tears down local resources and an SDK-spawned server.
 */
export interface AgentClient {
  readonly transportKind: Transport["kind"]
  readonly baseUrl: string
  readonly sessions: SessionNamespace
  /**
   * Close all client-owned handles and transport resources. A remote server itself remains running.
   * @returns Completion after owned cleanup has settled.
   * @throws A cleanup failure or aggregate of failures.
   */
  close(): Promise<void>
}

/**
 * Session creation, discovery, attachment, branching and deletion operations scoped through an AgentClient.
 */
export interface SessionNamespace {
  /**
   * Create and attach a fresh runtime session.
   * @param options - Working directory, metadata and runtime policy.
   * @returns A session with a ready callback dispatcher.
   * @throws Configuration or transport errors.
   */
  create(options?: SessionCreateOptions): Promise<Session>
  /**
   * Attach to a persisted session without applying overrides. Reuses an active local handle.
   * @param sessionId - Existing runtime session ID.
   * @returns The attached session.
   * @throws If the session cannot be located.
   */
  get(sessionId: string): Promise<Session>
  /**
   * List persisted session metadata matching optional filters.
   * @param filter - Directory, tags and pagination filters.
   * @returns Matching session records.
   * @throws Transport errors.
   */
  list(filter?: SessionListFilter): Promise<CognitioSession[]>
  /** Attach and optionally apply runtime overrides before starting the local dispatcher. Active handles reject overrides. */
  resume(sessionId: string, options?: SessionResumeOptions): Promise<Session>
  /**
   * Branch a transcript into a new session and attach its SDK resources.
   * @param sessionId - Source session ID.
   * @param options - Optional message boundary, metadata and runtime overrides.
   * @returns The independent fork.
   * @throws If the source or boundary is invalid.
   */
  fork(
    sessionId: string,
    options?: {
      messageId?: string
      title?: string
      runtimeConfig?: SessionCreateOptions["runtimeConfig"]
      permission?: SessionCreateOptions["permission"]
    },
  ): Promise<Session>
  /**
   * Delete a server session after releasing an active local handle.
   * @param sessionId - Session to delete.
   * @returns Completion when deletion succeeds.
   * @throws Transport or cleanup errors.
   */
  delete(sessionId: string): Promise<void>
  /**
   * Attach to the latest matching persisted session.
   * @param options - Optional working-directory filter.
   * @returns The selected session handle.
   * @throws If no matching session is available.
   */
  continue(options?: { cwd?: string }): Promise<Session>
}

/**
 * Create a session client against a remote runtime or an isolated local server.
 * @param options - Connection, process, workspace, and control-channel options.
 * @returns A client that owns its session handles and local server process.
 * @throws If the local binary cannot start or the connection configuration is invalid.
 */
export async function createAgentClient(options?: ClientOptions): Promise<AgentClient> {
  const transport = await resolveTransport(options)
  const directory = options?.directory
  const workspaceId = options?.workspaceId
  const sessionRoutes = new Map<string, { directory: string; workspace?: string }>()
  const activeSessions = new Map<string, Session>()
  const attachments = new Map<string, Promise<Session>>()
  const deletions = new Map<string, Promise<void>>()

  function wrap(session: CognitioSession, createOptions?: SessionCreateOptions, sdkMcpHosts?: SdkMcpHost[]): Session {
    // `session.directory` is the canonical cwd assigned by the server;
    // trust it so every subsequent send/stream/abort targets the right dir.
    sessionRoutes.set(session.id, {
      directory: session.directory,
      workspace: session.workspaceID ?? workspaceId,
    })
    return new Session({
      client: transport.client,
      session,
      directory: session.directory,
      workspaceId: session.workspaceID ?? workspaceId,
      runtimeConfig: createOptions?.runtimeConfig,
      sdkMcpHosts,
      control: options?.control,
      createOptions,
      onClose: (sessionId, handle) => {
        if (activeSessions.get(sessionId) === handle) activeSessions.delete(sessionId)
      },
    })
  }

  async function wrapStarted(
    session: CognitioSession,
    createOptions?: SessionCreateOptions,
    sdkMcpHosts?: SdkMcpHost[],
  ): Promise<Session> {
    const active = activeSessions.get(session.id)
    if (active) return active
    const handle = wrap(session, createOptions, sdkMcpHosts)
    try {
      await handle.startDispatcher()
      activeSessions.set(handle.id, handle)
      return handle
    } catch (error) {
      const cleanup = await handle.close().then(
        () => [],
        (cleanupError) => [cleanupError],
      )
      if (cleanup.length) throw new AggregateError([error, ...cleanup], `Failed to start session ${session.id}`)
      throw error
    }
  }

  async function routeFor(sessionId: string): Promise<{ directory: string; workspace?: string }> {
    const known = sessionRoutes.get(sessionId)
    if (known) return known

    const direct = await transport.client.session.get({
      sessionID: sessionId,
      directory,
      workspace: workspaceId,
    })
    if (direct.error === undefined && direct.data !== undefined) {
      sessionRoutes.set(sessionId, {
        directory: direct.data.directory,
        workspace: direct.data.workspaceID ?? workspaceId,
      })
      return sessionRoutes.get(sessionId)!
    }

    const byID = await transport.client.session.get({
      sessionID: sessionId,
      directory: "",
      workspace: workspaceId,
    })
    if (byID.error === undefined && byID.data !== undefined) {
      sessionRoutes.set(sessionId, {
        directory: byID.data.directory,
        workspace: byID.data.workspaceID ?? workspaceId,
      })
      return sessionRoutes.get(sessionId)!
    }

    const listed = await transport.client.experimental.session.list({
      directory: "",
      workspace: workspaceId,
      archived: true,
    })
    assertOk(listed, `Failed to locate session ${sessionId}`)

    const matched = listed.data.find((item) => item.id === sessionId)
    if (!matched) {
      throw sdkError("session_conflict", `Failed to locate session ${sessionId}`)
    }

    const route = {
      directory: matched.directory,
      workspace: matched.workspaceID ?? workspaceId,
    }
    sessionRoutes.set(sessionId, route)
    return route
  }

  async function removeFailedSession(session: CognitioSession, sdkMcpHosts: SdkMcpHost[]): Promise<void> {
    const stopped = await Promise.allSettled([stopSdkMcpHosts(sdkMcpHosts)])
    const deleted = await Promise.allSettled([
      transport.client.session
        .delete({
          sessionID: session.id,
          directory: session.directory,
          workspace: session.workspaceID ?? workspaceId,
        })
        .then((result) => assertOk(result, `Failed to roll back session ${session.id}`)),
    ])
    sessionRoutes.delete(session.id)
    activeSessions.delete(session.id)
    const cleanup = [...stopped, ...deleted]
    const errors = cleanup.filter((item) => item.status === "rejected").map((item) => item.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `Failed to roll back session ${session.id}`)
  }

  function localSdkMcpServers(runtimeConfig: SessionCreateOptions["runtimeConfig"]) {
    return runtimeConfig?.sdkMcpServers?.filter(isSdkMcpServer)
  }

  function assertHttpSdkMcpSupport(servers: SdkMcpServer[] | undefined): void {
    if (transport.kind !== "remote" || !servers?.some((server) => server.transport !== "direct")) return
    throw sdkError("session_conflict", "runtimeConfig.sdkMcpServers with HTTP transport require local spawn transport")
  }

  async function materializeRuntimeConfig(
    session: CognitioSession,
    runtimeConfig: SessionCreateOptions["runtimeConfig"],
    options?: { forcePatch?: boolean },
  ): Promise<SdkMcpHost[]> {
    const servers = localSdkMcpServers(runtimeConfig)
    assertHttpSdkMcpSupport(servers)
    const http = servers?.filter((server) => server.transport !== "direct")
    const materialized = http?.length
      ? await startSdkMcpServers(http, {
          sessionId: session.id,
        })
      : { hosts: [], specs: [] }
    if (!options?.forcePatch && materialized.specs.length === 0) return materialized.hosts
    try {
      const patched = await transport.client.session.runtimeConfig.patch({
        sessionID: session.id,
        directory: session.directory,
        workspace: session.workspaceID ?? workspaceId,
        runtimeConfig: normalizeRuntimeConfig(runtimeConfig, {
          ...(materialized.specs.length ? { sdkMcpServers: materialized.specs } : {}),
        }),
      })
      assertOk(patched, "Failed to apply runtime config")
      return materialized.hosts
    } catch (error) {
      const cleanup = await stopSdkMcpHosts(materialized.hosts).then(
        () => [],
        (cleanupError) => [cleanupError],
      )
      if (cleanup.length) throw new AggregateError([error, ...cleanup], "Failed to apply runtime config")
      throw error
    }
  }

  const pendingSessionOperations = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  let closeStarted = false

  function runSessionOperation<T>(start: () => Promise<T>): Promise<T> {
    if (closeStarted) return Promise.reject(sdkError("closed", "Agent client is closed"))
    const operation = Promise.resolve().then(start)
    pendingSessionOperations.add(operation)
    operation
      .finally(() => {
        pendingSessionOperations.delete(operation)
      })
      .catch(() => {})
    return operation
  }

  function attach(sessionId: string, overrides?: SessionResumeOptions): Promise<Session> {
    if (deletions.has(sessionId))
      return Promise.reject(sdkError("session_conflict", `Session ${sessionId} is being deleted`))
    const configured = overrides !== undefined && Object.values(overrides).some((value) => value !== undefined)
    const current = activeSessions.get(sessionId)
    const pending = attachments.get(sessionId)
    if (current || pending) {
      if (configured)
        return Promise.reject(
          sdkError(
            "session_conflict",
            `Session ${sessionId} already has an active handle; close it before applying resume overrides`,
          ),
        )
      return current ? Promise.resolve(current) : pending!
    }
    // Validate before network I/O; in-flight attachment ownership is synchronous.
    normalizeRuntimeConfig(overrides?.runtimeConfig)
    assertHttpSdkMcpSupport(localSdkMcpServers(overrides?.runtimeConfig))
    const operation = attachOnce(sessionId, overrides)
    attachments.set(sessionId, operation)
    void operation
      .finally(() => {
        if (attachments.get(sessionId) === operation) attachments.delete(sessionId)
      })
      .catch(() => {})
    return operation
  }

  async function attachOnce(sessionId: string, overrides?: SessionResumeOptions): Promise<Session> {
    const route = await routeFor(sessionId)
    const parameters = { sessionID: sessionId, directory: route.directory, workspace: route.workspace }
    const loaded = await transport.client.session.get(parameters)
    assertOk(loaded, `Failed to load session ${sessionId}`)
    if (overrides === undefined) return wrapStarted(loaded.data)
    const snapshot = await transport.client.session.runtimeConfig.get(parameters)
    assertOk(snapshot, `Failed to load runtime config for ${sessionId}`)
    let hosts: SdkMcpHost[] = []
    let runtimeChanged = false
    let metadataChanged = false
    try {
      // Set the rollback flag before materialization: its PATCH can succeed even
      // when the response is lost, so rollback must restore the whole snapshot.
      runtimeChanged = overrides.runtimeConfig !== undefined
      hosts = await materializeRuntimeConfig(loaded.data, overrides.runtimeConfig, { forcePatch: runtimeChanged })
      metadataChanged = overrides.title !== undefined || overrides.permission !== undefined
      const configured = metadataChanged
        ? await transport.client.session
            .update({ ...parameters, title: overrides.title, permission: overrides.permission })
            .then((result) => {
              assertOk(result, `Failed to configure resumed session ${sessionId}`)
              return result.data
            })
        : loaded.data
      return await wrapStarted(configured, { ...overrides, cwd: loaded.data.directory }, hosts)
    } catch (error) {
      const cleanup: unknown[] = []
      const restore = async () => {
        if (runtimeChanged) {
          assertOk(
            await transport.client.session.runtimeConfig.clear(parameters),
            `Failed to reset runtime config for ${sessionId}`,
          )
          assertOk(
            await transport.client.session.runtimeConfig.patch({
              ...parameters,
              runtimeConfig: snapshot.data.runtimeConfig,
            }),
            `Failed to restore runtime config for ${sessionId}`,
          )
        }
        if (metadataChanged)
          assertOk(
            await transport.client.session.update({
              ...parameters,
              title: loaded.data.title,
              permission: loaded.data.permission ?? [],
            }),
            `Failed to restore resumed session ${sessionId}`,
          )
      }
      await stopSdkMcpHosts(hosts).catch((failure) => cleanup.push(failure))
      await restore().catch((failure) => cleanup.push(failure))
      if (cleanup.length)
        throw new AggregateError([error, ...cleanup], `Failed to resume and restore session ${sessionId}`)
      throw error
    }
  }

  const sessionMethods = {
    async create(createOptions) {
      // Session-create defaults (neutral prompt, isolated settingSources) are
      // computed once and flow into the create body, the MCP re-PATCH, and the
      // Session handle so every consumer sees the same effective config.
      const effectiveCreateOptions: SessionCreateOptions = {
        ...(createOptions ?? {}),
        runtimeConfig: applyCreateDefaults(createOptions?.runtimeConfig, {
          isolated: transport.isolated === true,
        }),
      }
      assertHttpSdkMcpSupport(localSdkMcpServers(effectiveCreateOptions.runtimeConfig))
      const runtimeConfig = normalizeRuntimeConfig(effectiveCreateOptions.runtimeConfig)
      const result = await transport.client.session.create({
        directory: effectiveCreateOptions.cwd ?? directory,
        workspace: workspaceId,
        parentID: effectiveCreateOptions.parentId,
        title: effectiveCreateOptions.title,
        permission: effectiveCreateOptions.permission,
        runtimeConfig,
      })
      assertOk(result, "Failed to create session")
      let sdkMcpHosts: SdkMcpHost[] = []
      try {
        sdkMcpHosts = await materializeRuntimeConfig(result.data, effectiveCreateOptions.runtimeConfig)
      } catch (error) {
        const cleanup = await removeFailedSession(result.data, sdkMcpHosts).then(
          () => [],
          (cleanupError) => [cleanupError],
        )
        if (cleanup.length) throw new AggregateError([error, ...cleanup], "Failed to create configured session")
        throw error
      }
      try {
        return await wrapStarted(result.data, effectiveCreateOptions, sdkMcpHosts)
      } catch (error) {
        const cleanup = await removeFailedSession(result.data, sdkMcpHosts).then(
          () => [],
          (cleanupError) => [cleanupError],
        )
        if (cleanup.length) throw new AggregateError([error, ...cleanup], "Failed to start configured session")
        throw error
      }
    },
    async get(sessionId) {
      return attach(sessionId)
    },
    async list(filter) {
      const result = await transport.client.session.list({
        directory: filter?.cwd ?? directory,
        workspace: workspaceId,
        roots: filter?.roots,
        start: filter?.start,
        search: filter?.search,
        tag: filter?.tag,
        limit: filter?.limit,
      })
      assertOk(result, "Failed to list sessions")
      result.data.forEach((item) => {
        sessionRoutes.set(item.id, {
          directory: item.directory,
          workspace: item.workspaceID ?? workspaceId,
        })
      })
      return result.data
    },
    async fork(sessionId, options) {
      normalizeRuntimeConfig(options?.runtimeConfig)
      assertHttpSdkMcpSupport(localSdkMcpServers(options?.runtimeConfig))
      const route = await routeFor(sessionId)
      const result = await transport.client.session.fork({
        sessionID: sessionId,
        messageID: options?.messageId,
        directory: route.directory,
        workspace: route.workspace,
      })
      assertOk(result, `Failed to fork session ${sessionId}`)
      const forked = result.data
      let sdkMcpHosts: SdkMcpHost[] = []
      try {
        sdkMcpHosts = await materializeRuntimeConfig(forked, options?.runtimeConfig, {
          forcePatch: options?.runtimeConfig !== undefined,
        })
        const configured =
          options?.title !== undefined || options?.permission !== undefined
            ? await transport.client.session
                .update({
                  sessionID: forked.id,
                  directory: forked.directory,
                  workspace: forked.workspaceID ?? workspaceId,
                  title: options.title,
                  permission: options.permission,
                })
                .then((updated) => {
                  assertOk(updated, `Failed to configure forked session ${forked.id}`)
                  return updated.data
                })
            : forked
        return await wrapStarted(
          configured,
          {
            title: options?.title,
            runtimeConfig: options?.runtimeConfig,
            permission: options?.permission,
          },
          sdkMcpHosts,
        )
      } catch (error) {
        const active = activeSessions.get(forked.id)
        const closed = await Promise.allSettled([active?.close() ?? Promise.resolve()])
        const removed = await Promise.allSettled([removeFailedSession(forked, sdkMcpHosts)])
        const errors = [...closed, ...removed].filter((item) => item.status === "rejected").map((item) => item.reason)
        if (errors.length)
          throw new AggregateError([error, ...errors], `Failed to configure forked session ${forked.id}`)
        throw error
      }
    },
    delete(sessionId) {
      const pending = deletions.get(sessionId)
      if (pending) return pending
      const operation = deleteSession(sessionId)
      deletions.set(sessionId, operation)
      void operation.finally(() => deletions.delete(sessionId)).catch(() => {})
      return operation
    },
    async continue(options) {
      const result = await transport.client.experimental.session.list({
        directory: options?.cwd ?? directory,
        workspace: workspaceId,
        roots: true,
        limit: 1,
        archived: false,
      })
      assertOk(result, "Failed to continue latest session")
      const session = result.data[0]
      if (!session) {
        throw sdkError(
          "session_conflict",
          `No non-archived root session found${(options?.cwd ?? directory) ? ` in ${options?.cwd ?? directory}` : ""}`,
        )
      }
      return attach(session.id)
    },
  } satisfies Omit<SessionNamespace, "resume">

  async function deleteSession(sessionId: string) {
    // Let an earlier attachment finish or roll back before deleting its state.
    // New attachments are excluded by the per-session deletion marker.
    await attachments.get(sessionId)?.catch(() => {})
    const active = activeSessions.get(sessionId)
    if (active) await active.close()
    const route = await routeFor(sessionId)
    const result = await transport.client.session.delete({
      sessionID: sessionId,
      directory: route.directory,
      workspace: route.workspace,
    })
    assertOk(result, `Failed to delete session ${sessionId}`)
    sessionRoutes.delete(sessionId)
    activeSessions.delete(sessionId)
  }

  const sessions: SessionNamespace = {
    create(options) {
      return runSessionOperation(() => sessionMethods.create(options))
    },
    get(sessionId) {
      return runSessionOperation(() => sessionMethods.get(sessionId))
    },
    list(filter) {
      return runSessionOperation(() => sessionMethods.list(filter))
    },
    resume(sessionId, overrides) {
      return runSessionOperation(() => attach(sessionId, overrides))
    },
    fork(sessionId, options) {
      return runSessionOperation(() => sessionMethods.fork(sessionId, options))
    },
    delete(sessionId) {
      return runSessionOperation(() => sessionMethods.delete(sessionId))
    },
    continue(options) {
      return runSessionOperation(() => sessionMethods.continue(options))
    },
  }

  const closeClient = async () => {
    await Promise.allSettled([...pendingSessionOperations])
    // Every session's cleanup runs to completion BEFORE the transport is
    // torn down — Promise.all would reject on the first failure and race the
    // remaining sessions' MCP/dispatcher cleanup against server kill +
    // scratch removal. Errors are collected and rethrown after transport
    // close so nothing is lost.
    const results = await Promise.allSettled(Array.from(activeSessions.values()).map((session) => session.close()))
    activeSessions.clear()
    const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason)
    try {
      await transport.close()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "failed to close agent client")
  }

  return {
    transportKind: transport.kind,
    baseUrl: transport.baseUrl,
    sessions,
    close() {
      if (closing) return closing
      closeStarted = true
      closing = closeClient()
      return closing
    },
  }
}

function isSdkMcpServer(server: RuntimeMcpServer): server is SdkMcpServer {
  return server.type === undefined || server.type === "sdk"
}
