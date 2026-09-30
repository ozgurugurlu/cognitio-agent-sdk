import { describe, expect, test } from "bun:test"
import { Agent, defineTool, query } from "../src/index.js"
import type { AgentClient, AgentOptions, PromptInput, ToolDefinition } from "../src/index.js"
import {
  deriveAgentTitle,
  FACADE_DEFAULT_DISALLOWED_TOOLS,
  FACADE_DEFAULT_SPAWN,
  resolveAgentProfile,
  type AgentProfileInput,
} from "../src/internal/default-profile.js"
import { normalizeRuntimeConfig } from "../src/internal/runtime-config.js"
import { claimFacadeSession } from "../src/internal/session-ownership.js"

const permission = [{ permission: "read", pattern: "*", action: "allow" as const }]
const borrowedClient = {
  transportKind: "remote",
  baseUrl: "http://127.0.0.1:4096",
  sessions: {} as AgentClient["sessions"],
  close: async () => {},
} satisfies AgentClient

// Mirrors `Session.isDefaultTitle` verbatim (packages/runtime/src/session/session.ts:40-51)
// so the D10 collision escape is checked against the rule `ensureTitle` really
// applies, not against a paraphrase of it.
const PARENT_TITLE_PREFIX = "New session - "
const CHILD_TITLE_PREFIX = "Child session - "

function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${PARENT_TITLE_PREFIX}|${CHILD_TITLE_PREFIX})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

function tool(name: string): ToolDefinition {
  return defineTool({
    name,
    inputJsonSchema: { type: "object" },
    execute: () => "ok",
  })
}

function dedicated(options: AgentProfileInput) {
  const connection = resolveAgentProfile(options).connection
  if (connection.kind !== "dedicated") throw new Error("expected a dedicated profile")
  return connection.options
}

async function* promptTurns() {
  yield "streamed turn"
}

/** A bare WeakMap key: the ownership registry never touches client members. */
function clientKey(): AgentClient {
  return {} as AgentClient
}

describe("facade default profile", () => {
  test("uses the neutral, headless canonical session profile", () => {
    const profile = resolveAgentProfile()

    expect(profile.connection).toEqual({ kind: "canonical" })
    expect(profile.create).toEqual({
      runtimeConfig: {
        settingSources: [],
        disallowedTools: FACADE_DEFAULT_DISALLOWED_TOOLS,
      },
    })
    expect(profile.create.runtimeConfig?.systemPrompt).toBeUndefined()
    expect(profile.create.runtimeConfig?.instructions).toBeUndefined()
    expect(profile.providedRuntimeKeys).toEqual([])
    expect(profile.providedCreateKeys).toEqual([])
    expect(FACADE_DEFAULT_SPAWN).toEqual({
      isolated: true,
      hostname: "127.0.0.1",
      port: 0,
      timeout: 30_000,
      autoCleanup: true,
      config: {
        lsp: false,
        formatter: false,
        agent: {
          title: {
            disable: true,
          },
        },
      },
    })
  })

  test("treats undefined as inheritance and false, empty strings, and empty arrays as overrides", () => {
    expect(
      resolveAgentProfile({
        settingSources: undefined,
        allowedTools: undefined,
        disallowedTools: undefined,
      }).create.runtimeConfig,
    ).toEqual({
      settingSources: [],
      disallowedTools: FACADE_DEFAULT_DISALLOWED_TOOLS,
    })

    const profile = resolveAgentProfile({
      cwd: "",
      title: "",
      instructions: "",
      settingSources: [],
      disallowedTools: [],
      enableFileCheckpointing: false,
      permission,
    })
    expect(profile.connection.kind).toBe("canonical")
    expect(profile.create).toEqual({
      cwd: "",
      title: "",
      permission,
      runtimeConfig: {
        instructions: "",
        settingSources: [],
        disallowedTools: [],
        enableFileCheckpointing: false,
      },
    })
    expect(profile.providedRuntimeKeys).toEqual([
      "instructions",
      "disallowedTools",
      "settingSources",
      "enableFileCheckpointing",
    ])
    expect(profile.providedCreateKeys).toEqual(["cwd", "title", "permission"])
  })

  // The constants are shared by reference into resolved profiles and into the
  // canonical client, so freezing is what makes that sharing safe rather than
  // merely unused. Asserted because the close-out claims it as a fix.
  test("the facade default constants are deeply frozen, so a resolved profile cannot poison them", () => {
    expect(Object.isFrozen(FACADE_DEFAULT_SPAWN)).toBe(true)
    expect(Object.isFrozen(FACADE_DEFAULT_SPAWN.config)).toBe(true)
    expect(Object.isFrozen(FACADE_DEFAULT_SPAWN.config?.agent)).toBe(true)
    expect(Object.isFrozen(FACADE_DEFAULT_SPAWN.config?.agent?.title)).toBe(true)
    expect(Object.isFrozen(FACADE_DEFAULT_DISALLOWED_TOOLS)).toBe(true)

    // The levels mergeFacadeSpawn allocates stay writable, so nothing legitimate
    // breaks; only the shared leaves are locked.
    const spawn = dedicated({ spawn: { config: { agent: { reviewer: { prompt: "x" } } } } }).spawn
    expect(Object.isFrozen(spawn)).toBe(false)
    expect(Object.isFrozen(spawn?.config)).toBe(false)
    expect(Object.isFrozen(spawn?.config?.agent)).toBe(false)
    // ...and the leaf it did not touch is the frozen shared one.
    expect(Object.isFrozen(spawn?.config?.agent?.title)).toBe(true)
  })

  test("replaces rather than unions the facade deny defaults", () => {
    // A union would make re-enabling `todowrite` impossible, so a caller-supplied
    // deny list is the whole deny list.
    const runtimeConfig = resolveAgentProfile({ disallowedTools: ["bash"] }).create.runtimeConfig
    expect(runtimeConfig?.disallowedTools).toEqual(["bash"])
    expect(runtimeConfig).toEqual({
      disallowedTools: ["bash"],
      settingSources: [],
    })

    // The default list is copied per resolution, so one Agent mutating its own
    // profile cannot poison the module constant for the next one.
    const defaults = resolveAgentProfile().create.runtimeConfig?.disallowedTools
    expect(defaults).toEqual(FACADE_DEFAULT_DISALLOWED_TOOLS)
    expect(defaults).not.toBe(FACADE_DEFAULT_DISALLOWED_TOOLS)
  })

  test("drops only the facade deny defaults when an allowlist is supplied", () => {
    expect(resolveAgentProfile({ allowedTools: [] }).create.runtimeConfig).toEqual({
      allowedTools: [],
      settingSources: [],
    })
    expect(
      resolveAgentProfile({
        allowedTools: ["read"],
        disallowedTools: ["bash"],
      }).create.runtimeConfig,
    ).toEqual({
      allowedTools: ["read"],
      disallowedTools: ["bash"],
      settingSources: [],
    })
  })

  test("keeps runtime, cwd, directory, title, and tools on the canonical connection", () => {
    ;[
      { model: "anthropic/claude-sonnet-4-5" },
      { cwd: "/repo" },
      { directory: "/repo" },
      { title: "" },
      { tools: [] },
      { permission },
      {
        baseUrl: undefined,
        spawn: undefined,
        control: undefined,
        workspaceId: undefined,
        client: undefined,
      },
    ].forEach((options) => {
      expect(resolveAgentProfile(options as AgentProfileInput).connection.kind).toBe("canonical")
    })
  })
})

describe("facade connection decisions", () => {
  test("selects dedicated and injected ownership without leaking spawn defaults into remote clients", () => {
    expect(resolveAgentProfile({ client: borrowedClient, cwd: "/repo" }).connection).toEqual({
      kind: "injected",
      client: borrowedClient,
    })
    expect(resolveAgentProfile({ baseUrl: "http://127.0.0.1:4096" }).connection).toEqual({
      kind: "dedicated",
      options: { baseUrl: "http://127.0.0.1:4096" },
    })
    expect(dedicated({ control: {} })).toEqual({
      spawn: FACADE_DEFAULT_SPAWN,
      control: {},
    })
    expect(dedicated({ workspaceId: "" })).toEqual({
      spawn: FACADE_DEFAULT_SPAWN,
      workspaceId: "",
    })
  })

  test("rejects ambiguous or invalid connection choices synchronously", () => {
    ;[
      {
        options: { cwd: "/a", directory: "/b" },
        message: /cwd.*directory.*match/,
      },
      {
        options: { baseUrl: "http://127.0.0.1:4096", spawn: {} },
        message: /baseUrl.*spawn.*cannot be combined/,
      },
      {
        options: { baseUrl: "" },
        message: /baseUrl.*non-empty/,
      },
      {
        options: { baseUrl: "   " },
        message: /baseUrl.*non-empty/,
      },
      {
        options: { client: borrowedClient, baseUrl: "http://127.0.0.1:4096" },
        message: /client.*baseUrl/,
      },
      {
        options: { client: borrowedClient, spawn: {} },
        message: /client.*spawn/,
      },
      {
        options: { client: borrowedClient, control: {} },
        message: /client.*control/,
      },
      {
        options: { client: borrowedClient, workspaceId: "" },
        message: /client.*workspaceId/,
      },
    ].forEach((entry) => {
      expect(() => resolveAgentProfile(entry.options as AgentProfileInput)).toThrow(entry.message)
      expect(() => new Agent(entry.options as AgentOptions)).toThrow(entry.message)
    })
  })

  test("keeps session-level discovery off even when the server process is not isolated", () => {
    // `spawn.isolated` governs the server *process* world; `settingSources`
    // governs *session-level* discovery of AGENTS.md, project skills, and
    // commands. Tying them would let `isolated: false` ("let me use my host
    // auth") silently pull the host coding persona into a neutral agent.
    const profile = resolveAgentProfile({ spawn: { isolated: false } })
    expect(profile.create.runtimeConfig?.settingSources).toEqual([])
    expect(profile.create.runtimeConfig?.disallowedTools).toEqual(FACADE_DEFAULT_DISALLOWED_TOOLS)
    expect(profile.providedRuntimeKeys).toEqual([])
    expect(dedicated({ spawn: { isolated: false } }).spawn?.isolated).toBe(false)

    // Only an explicit caller list changes it.
    expect(
      resolveAgentProfile({ spawn: { isolated: false }, settingSources: ["project"] }).create.runtimeConfig
        ?.settingSources,
    ).toEqual(["project"])
  })

  test("merges spawn config by top-level key and by agent name, replacing a named agent wholesale", () => {
    // Overriding one agent keeps the facade's title.disable, so an unrelated
    // agent override cannot silently restore the per-session title LLM call.
    expect(
      dedicated({ spawn: { config: { agent: { reviewer: { prompt: "review" } } } } }).spawn?.config?.agent,
    ).toEqual({
      title: { disable: true },
      reviewer: { prompt: "review" },
    })

    // An unrelated top-level config key keeps every facade default.
    expect(dedicated({ spawn: { config: { model: "anthropic/claude-sonnet-4-5" } } }).spawn?.config).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      lsp: false,
      formatter: false,
      agent: { title: { disable: true } },
    })

    // Naming `title` means the caller owns its definition, `disable` included.
    expect(
      dedicated({
        spawn: {
          isolated: false,
          hostname: "",
          timeout: 0,
          autoCleanup: false,
          keepScratch: false,
          passEnv: [],
          env: {},
          config: {
            lsp: true,
            formatter: true,
            agent: {
              title: {
                model: "anthropic/claude-sonnet-4-5",
              },
              reviewer: {
                disable: false,
                prompt: "",
              },
            },
          },
        },
      }).spawn,
    ).toEqual({
      isolated: false,
      hostname: "",
      port: 0,
      timeout: 0,
      autoCleanup: false,
      keepScratch: false,
      passEnv: [],
      env: {},
      config: {
        lsp: true,
        formatter: true,
        agent: {
          title: {
            model: "anthropic/claude-sonnet-4-5",
          },
          reviewer: {
            disable: false,
            prompt: "",
          },
        },
      },
    })

    // `undefined` inherits at every merged level; inside a replaced agent
    // object there is nothing left to inherit from, so `disable` is simply
    // absent and the title agent is live again.
    const inherited = dedicated({
      spawn: {
        isolated: undefined,
        autoCleanup: undefined,
        config: {
          lsp: undefined,
          agent: {
            title: {
              disable: undefined,
              prompt: "",
            },
          },
        },
      },
    }).spawn
    expect(inherited).toMatchObject({
      isolated: true,
      autoCleanup: true,
      config: { lsp: false, formatter: false },
    })
    expect(inherited?.config?.agent?.title).toEqual({ disable: undefined, prompt: "" })

    expect(
      dedicated({
        spawn: {
          config: {
            agent: {
              title: {
                disable: false,
              },
            },
          },
        },
      }).spawn?.config?.agent?.title,
    ).toEqual({ disable: false })
  })
})

describe("facade tool namespace", () => {
  test("wraps tools in one direct sdk server and appends it to caller servers", () => {
    const review = tool("review.diff")
    const existing = {
      name: "custom",
      transport: "direct" as const,
      tools: [tool("search")],
    }
    const runtimeConfig = resolveAgentProfile({
      tools: [review],
      sdkMcpServers: [existing],
      allowedTools: ["sdk_review_diff"],
    }).create.runtimeConfig

    expect(runtimeConfig?.allowedTools).toEqual(["sdk_review_diff"])
    expect(runtimeConfig?.disallowedTools).toBeUndefined()
    expect(runtimeConfig?.sdkMcpServers).toHaveLength(2)
    expect(runtimeConfig?.sdkMcpServers?.[0]).toBe(existing)
    expect(runtimeConfig?.sdkMcpServers?.[1]).toMatchObject({
      name: "sdk",
      transport: "direct",
      tools: [review],
    })
  })

  test("builds a tools server shape the runtime-config normalizer accepts", () => {
    // Structural plausibility is not enough: the wrapped server has to survive
    // the same normalizer `sessions.create` runs it through.
    const normalized = normalizeRuntimeConfig(
      resolveAgentProfile({ tools: [tool("review.diff")] }).create.runtimeConfig,
    )

    expect(normalized?.settingSources).toEqual([])
    expect(normalized?.disallowedTools).toEqual(FACADE_DEFAULT_DISALLOWED_TOOLS)
    expect(normalized?.sdkMcpServers).toEqual([
      {
        name: "sdk",
        type: "sdk",
        transport: "direct",
        tools: [{ name: "review.diff", inputSchema: { type: "object" } }],
      },
    ])
  })

  test("does not create an sdk server for an explicit empty tools array", () => {
    expect(resolveAgentProfile({ tools: [] }).create.runtimeConfig?.sdkMcpServers).toBeUndefined()
  })

  test("rejects server-name and sanitized visible-tool collisions", () => {
    ;[
      {
        options: {
          tools: [tool("review")],
          sdkMcpServers: [{ name: "sdk", transport: "direct" as const, tools: [tool("other")] }],
        },
        message: /server named "sdk"/,
      },
      {
        options: {
          tools: [tool("review")],
          sdkMcpServers: [{ name: "sdk.extra", transport: "direct" as const, tools: [tool("other")] }],
        },
        message: /"sdk" namespace/,
      },
      {
        options: {
          tools: [tool("review")],
          spawn: { config: { mcp: { "sdk.extra": { enabled: false } } } },
        },
        message: /"sdk" namespace/,
      },
      {
        options: {
          tools: [tool("foo.bar"), tool("foo?bar")],
        },
        message: /sdk_foo_bar/,
      },
      {
        options: {
          sdkMcpServers: [
            { name: "one.two", transport: "direct" as const, tools: [tool("same")] },
            { name: "one?two", transport: "direct" as const, tools: [tool("same")] },
          ],
        },
        message: /one_two_same/,
      },
    ].forEach((entry) => {
      expect(() => resolveAgentProfile(entry.options)).toThrow(entry.message)
      expect(() => new Agent(entry.options)).toThrow(entry.message)
    })
  })
})

describe("facade synchronous construction", () => {
  test("validates constructor and per-call profile errors before returning a handle", async () => {
    expect(() => new Agent({ model: "anthropic" })).toThrow(/provider\/model/)
    expect(() => new Agent({ systemPrompt: "base", instructions: "other" })).toThrow(/cannot be combined/)
    expect(() => new Agent({ effort: "invalid" as never })).toThrow(/effort/)

    const agent = new Agent({
      instructions: "",
      disallowedTools: [],
      settingSources: [],
      spawn: {
        isolated: false,
        hostname: "",
        autoCleanup: false,
      },
    })
    expect(() => agent.stream("hello", { maxTurns: 0 })).toThrow(/maxTurns must be a positive integer/)
    const stream = agent.stream("hello")
    expect(stream instanceof Promise).toBe(false)
    await stream.close()
    await agent.close()
  })

  test("query returns synchronously and rejects invalid fork decisions synchronously", async () => {
    expect(() => query({ prompt: "hello", options: { forkSession: true } })).toThrow(/forkSession.*requires.*resume/)
    expect(() =>
      query({
        prompt: "hello",
        options: {
          resume: "ses_existing",
          forkMessageId: "msg_boundary",
        },
      }),
    ).toThrow(/forkMessageId.*requires.*forkSession/)
    expect(() => query({ prompt: "hello", options: { model: "anthropic" } })).toThrow(/provider\/model/)

    const stream = query({ prompt: "hello" })
    expect(stream instanceof Promise).toBe(false)
    await stream.close()
  })
})

describe("facade session titles", () => {
  test("derives a normalized first-line title from every prompt shape", () => {
    const cases: { prompt: PromptInput | undefined; title: string }[] = [
      { prompt: "  refactor   the\tparser  ", title: "refactor the parser" },
      { prompt: "x".repeat(120), title: "x".repeat(80) },
      { prompt: `${"x".repeat(90)}\nsecond line`, title: "x".repeat(80) },
      { prompt: "first line\nsecond line", title: "first line" },
      { prompt: "first line\r\nsecond line", title: "first line" },
      { prompt: { text: "  from a turn  " }, title: "from a turn" },
      { prompt: { text: "turn line\nignored" }, title: "turn line" },
      { prompt: { parts: [{ type: "text", text: "only parts" }] }, title: "Agent session" },
      { prompt: {}, title: "Agent session" },
      { prompt: "", title: "Agent session" },
      { prompt: "   \n  ", title: "Agent session" },
      { prompt: promptTurns(), title: "Agent session" },
      { prompt: undefined, title: "Agent session" },
    ]

    cases.forEach((entry) => {
      const title = deriveAgentTitle(entry.prompt)
      expect(title).toBe(entry.title)
      expect(title.length).toBeLessThanOrEqual(80)
      // Every derived title must count as non-default, or the server would run
      // the title agent and pay a hidden per-session LLM call.
      expect(isDefaultTitle(title)).toBe(false)
    })
  })

  test("escapes prompts whose first line matches the server default-title shape", () => {
    const timestamp = "2026-07-28T10:11:12.345Z"
    ;[`${PARENT_TITLE_PREFIX}${timestamp}`, `${CHILD_TITLE_PREFIX}${timestamp}`].forEach((collision) => {
      expect(isDefaultTitle(collision)).toBe(true)
      expect(deriveAgentTitle(collision)).toBe(`${collision} (Agent)`)
      expect(deriveAgentTitle({ text: collision })).toBe(`${collision} (Agent)`)
      expect(isDefaultTitle(deriveAgentTitle(collision))).toBe(false)
    })

    // Trim and whitespace collapse run before the collision check, so a padded
    // prompt that normalizes into the default shape is escaped too.
    expect(deriveAgentTitle(`  New   session  -  ${timestamp}  \nrest`)).toBe(
      `${PARENT_TITLE_PREFIX}${timestamp} (Agent)`,
    )
    ;[
      `${PARENT_TITLE_PREFIX}${timestamp} extra`,
      `${PARENT_TITLE_PREFIX}2026-07-28T10:11:12Z`,
      `${PARENT_TITLE_PREFIX}2026-07-28T10:11:12.345`,
      `${PARENT_TITLE_PREFIX}2026-07-28T10:11:12.3456Z`,
      `${PARENT_TITLE_PREFIX}26-07-28T10:11:12.345Z`,
      `new session - ${timestamp}`,
      `Old session - ${timestamp}`,
    ].forEach((nearMiss) => {
      expect(isDefaultTitle(nearMiss)).toBe(false)
      expect(deriveAgentTitle(nearMiss)).toBe(nearMiss)
    })
  })
})

describe("facade session ownership", () => {
  test("allows one live facade owner per session id per client", () => {
    const client = clientKey()
    const other = clientKey()
    const first = Symbol("first")
    const second = Symbol("second")

    const release = claimFacadeSession(client, "ses_a", first)
    expect(() => claimFacadeSession(client, "ses_a", second)).toThrow(/already has a live facade owner/)

    // Re-claiming as the same owner is a no-op, and its release must not hand
    // the claim away.
    const reclaim = claimFacadeSession(client, "ses_a", first)
    expect(typeof reclaim).toBe("function")
    reclaim()
    expect(() => claimFacadeSession(client, "ses_a", second)).toThrow(/already has a live facade owner/)

    // The registry is keyed by client, so the same id on another client is a
    // different session entirely.
    const elsewhere = claimFacadeSession(other, "ses_a", second)
    expect(() => claimFacadeSession(client, "ses_a", second)).toThrow(/already has a live facade owner/)
    elsewhere()

    // Unrelated ids on the same client never collide.
    claimFacadeSession(client, "ses_b", second)()

    // Release is idempotent and hands the id to the next owner.
    release()
    release()
    const handoff = claimFacadeSession(client, "ses_a", second)
    expect(() => claimFacadeSession(client, "ses_a", first)).toThrow(/already has a live facade owner/)

    // A stale release from the previous owner must not evict the current one.
    release()
    expect(() => claimFacadeSession(client, "ses_a", first)).toThrow(/already has a live facade owner/)

    handoff()
    claimFacadeSession(client, "ses_a", first)()
  })
})
