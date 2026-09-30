import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { AgentRuntime } from "../../src/agent/runtime"
import { RuntimePlugin } from "../../src/plugin/runtime"
import { SessionID } from "../../src/session/schema"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { tmpdir } from "../fixture/fixture"

describe("RuntimePlugin", () => {
  test("materializes Claude plugin assets with diagnostics substitution and fresh cache keys", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "team-plugin")
    const commandFile = path.join(root, "commands", "lint.md")
    const skillDir = path.join(root, "skills", "review")
    const sessionID = SessionID.make("ses_phase8")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.dirname(commandFile), { recursive: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.mkdir(path.join(root, "agents"), { recursive: true })
    await fs.mkdir(path.join(root, "hooks"), { recursive: true })

    await Bun.write(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "team",
        version: "1.0.0",
        description: "Team plugin",
        outputStyles: ["unsupported"],
        mcpServers: {
          remote: { url: "https://example.com/mcp", enabled: true, oauth: false },
          badUrl: { url: "not a url" },
          badTimeout: { url: "https://example.com/slow", timeout: 0 },
          local: { command: "node", args: ["server.js"] },
        },
      }),
    )
    await Bun.write(
      commandFile,
      `---
description: Lint command
agent: reviewer
allowed-tools: Bash(npm:*)
model: openai/gpt-5.2
---
Run lint from \${CLAUDE_PLUGIN_ROOT} for \${CLAUDE_SESSION_ID}.`,
    )
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
description: Review code
allowed-tools: Read
disable-model-invocation: true
---
Review from \${CLAUDE_SKILL_DIR} during \${CLAUDE_SESSION_ID}.`,
    )
    await Bun.write(
      path.join(root, "agents", "reviewer.md"),
      `---
description: Reviews code
model: openai/gpt-5.2
permissionMode: bypassPermissions
---
Review using \${CLAUDE_PLUGIN_ROOT}.`,
    )
    await Bun.write(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        description: "Claude hook wrapper",
        hooks: {
          PreToolUse: [
            { id: "audit", matcher: "bash", timeoutMs: 1000 },
            "bad-entry",
            { id: "shell", command: "echo unsupported" },
          ],
          UnknownEvent: [{ id: "unknown" }],
          SessionStateChange: { id: "bad-shape" },
        },
      }),
    )

    const materialized = await Effect.runPromise(
      RuntimePlugin.materialize({ plugins: [{ type: "claude", path: root }] }, sessionID),
    )

    expect(materialized.plugins[0]).toMatchObject({
      name: "team",
      source: "claude",
      skillCount: 1,
      commandCount: 1,
      agentCount: 1,
      hookEventCount: 1,
      mcpServerCount: 2,
    })
    expect(materialized.skills[0]).toMatchObject({
      name: "team:review",
      pluginName: "team",
      skillDir,
      disableModelInvocation: true,
      allowedTools: ["Read"],
    })
    expect(materialized.commands[0]).toMatchObject({
      name: "team:lint",
      pluginName: "team",
      template: `Run lint from ${root} for \${CLAUDE_SESSION_ID}.`,
      agent: "team:reviewer",
      allowedTools: ["Bash(npm:*)"],
      model: "openai/gpt-5.2",
    })
    expect(materialized.agents["team:reviewer"]).toMatchObject({
      prompt: `Review using ${root}.`,
      description: "Reviews code",
      model: { providerID: "openai", modelID: "gpt-5.2" },
    })
    expect(materialized.hooks.PreToolUse?.[0]).toEqual({ id: "team:audit", matcher: "bash", timeoutMs: 1000 })
    expect(materialized.mcpServers).toEqual([
      { name: "plugin:team:remote", type: "remote", url: "https://example.com/mcp", enabled: true, oauth: false },
      { name: "plugin:team:local", type: "local", command: ["node", "server.js"], cwd: root },
    ])
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("outputStyles")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("unsupported Claude hook")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("unsupported Claude hook event")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("value must be an array")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("entry must be an object")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain('Skipped Claude MCP server "badUrl"')
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain('Skipped Claude MCP server "badTimeout"')
    expect(
      RuntimePlugin.substitute(materialized.skills[0]!.content, {
        sessionID,
        pluginRoot: root,
        skillDir,
      }),
    ).toContain(`Review from ${skillDir} during ${sessionID}.`)
    expect(
      RuntimePlugin.substitute(materialized.commands[0]!.template, {
        sessionID,
        pluginRoot: root,
      }),
    ).toContain(`Run lint from ${root} for ${sessionID}.`)

    await Bun.write(
      commandFile,
      `---
description: Lint command
---
Updated lint from \${CLAUDE_PLUGIN_ROOT}.`,
    )

    const refreshed = await Effect.runPromise(
      RuntimePlugin.materialize({ plugins: [{ type: "claude", path: root }] }, sessionID),
    )
    expect(refreshed.commands[0]?.template).toBe(`Updated lint from ${root}.`)
  })

  test("parses manifest hooks and skips invalid Claude assets with accepted summary counts", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "strict-plugin")
    const sessionID = SessionID.make("ses_phase8_strict")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(root, "skills", "bad"), { recursive: true })
    await fs.mkdir(path.join(root, "commands"), { recursive: true })
    await fs.mkdir(path.join(root, "agents"), { recursive: true })
    await fs.mkdir(path.join(root, "hooks"), { recursive: true })
    await Bun.write(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "strict",
        hooks: {
          PreToolUse: [{ id: "manifest-pre", matcher: "bash" }],
        },
        commands: {
          empty: { content: "" },
          assist: { content: "Assist with review.", agent: "reviewer" },
        },
      }),
    )
    await Bun.write(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ id: "file-post", matcher: "write" }],
        },
      }),
    )
    await Bun.write(
      path.join(root, "skills", "bad", "SKILL.md"),
      `---
description: Bad skill
allowed-tools: Bash(npm:*
---
Uses an invalid tool rule.`,
    )
    await Bun.write(
      path.join(root, "commands", "ship.md"),
      `---
description: Ship
---
Ship it.`,
    )
    await Bun.write(
      path.join(root, "agents", "reviewer.md"),
      `---
description: Reviewer
---
Review work.`,
    )

    const materialized = await Effect.runPromise(
      RuntimePlugin.materialize({ plugins: [{ type: "claude", path: root }] }, sessionID),
    )

    expect(materialized.plugins[0]).toMatchObject({
      name: "strict",
      skillCount: 0,
      commandCount: 2,
      hookEventCount: 2,
    })
    expect(materialized.commands.map((command) => command.name)).toEqual(["strict:ship", "strict:assist"])
    expect(materialized.commands.find((command) => command.name === "strict:assist")?.agent).toBe("strict:reviewer")
    expect(materialized.hooks.PreToolUse).toEqual([{ id: "strict:manifest-pre", matcher: "bash" }])
    expect(materialized.hooks.PostToolUse).toEqual([{ id: "strict:file-post", matcher: "write" }])
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("Skipped Claude skill")
    expect(materialized.plugins[0]?.diagnostics?.join("\n")).toContain("Skipped Claude command")
  })

  test("keeps Claude plugin assets when optional hook and MCP JSON files are malformed", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "json-plugin")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(root, "hooks"), { recursive: true })
    await fs.mkdir(path.join(root, "mcp"), { recursive: true })
    await Bun.write(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "json",
        hooks: [
          "hooks/valid.json",
          "hooks/shell.sh",
          "hooks/bad.json",
          { PostToolUse: [{ id: "inline", matcher: "write" }] },
          { command: "echo unsupported" },
        ],
        mcpServers: [
          "mcp/good.json",
          "mcp/bad.json",
          "server.mcpb",
          { inline: { url: "https://example.com/inline-mcp" } },
          { command: "node server.js" },
        ],
      }),
    )
    await Bun.write(path.join(root, "hooks", "hooks.json"), "{ invalid")
    await Bun.write(
      path.join(root, "hooks", "valid.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ id: "valid", matcher: "read" }],
        },
      }),
    )
    await Bun.write(path.join(root, "hooks", "bad.json"), "{ invalid")
    await Bun.write(path.join(root, ".mcp.json"), "{ invalid")
    await Bun.write(
      path.join(root, "mcp", "good.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://example.com/mcp" },
        },
      }),
    )
    await Bun.write(path.join(root, "mcp", "bad.json"), "{ invalid")

    const materialized = await Effect.runPromise(
      RuntimePlugin.materialize({ plugins: [{ type: "claude", path: root }] }, SessionID.make("ses_phase8_json")),
    )
    const diagnostics = materialized.plugins[0]?.diagnostics?.join("\n") ?? ""

    expect(materialized.hooks.PreToolUse).toEqual([{ id: "json:valid", matcher: "read" }])
    expect(materialized.hooks.PostToolUse).toEqual([{ id: "json:inline", matcher: "write" }])
    expect(materialized.mcpServers).toEqual([
      { name: "plugin:json:remote", type: "remote", url: "https://example.com/mcp" },
      { name: "plugin:json:inline", type: "remote", url: "https://example.com/inline-mcp" },
    ])
    expect(diagnostics).toContain("Skipped Claude hook JSON")
    expect(diagnostics).toContain("Skipped Claude MCP JSON")
    expect(diagnostics).toContain("shell hook execution is not supported")
    expect(diagnostics).toContain("Ignored unsupported Claude hook entry")
    expect(diagnostics).toContain("Ignored unsupported Claude MCP entry")
    expect(diagnostics).toContain("MCPB/DXT")
  })

  test("loads manifest-declared command and agent files with directly declared skill directories", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "manifest-paths-plugin")
    const skillDir = path.join(root, "custom-skills", "review")
    const commandFile = path.join(root, "definitions", "lint.md")
    const agentFile = path.join(root, "definitions", "reviewer.md")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.mkdir(path.dirname(commandFile), { recursive: true })
    await Bun.write(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "paths",
        skills: "custom-skills/review",
        commands: "definitions/lint.md",
        agents: ["definitions/reviewer.md"],
      }),
    )
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
description: Direct skill directory
---
Review directly declared skill.`,
    )
    await Bun.write(
      commandFile,
      `---
description: Direct command file
agent: reviewer
---
Run lint.`,
    )
    await Bun.write(
      agentFile,
      `---
description: Direct agent file
---
Review directly declared agent.`,
    )

    const materialized = await Effect.runPromise(
      RuntimePlugin.materialize({ plugins: [{ type: "claude", path: root }] }, SessionID.make("ses_phase8_paths")),
    )

    expect(materialized.skills.map((skill) => skill.name)).toEqual(["paths:review"])
    expect(materialized.commands.map((command) => command.name)).toEqual(["paths:lint"])
    expect(materialized.commands[0]?.agent).toBe("paths:reviewer")
    expect(Object.keys(materialized.agents)).toEqual(["paths:reviewer"])
  })

  test("rejects duplicate loaded plugin names and namespaces inline plugin agent MCP servers", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")

    for (const root of [first, second]) {
      await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
      await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
      await Bun.write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dupe" }))
      await Bun.write(
        path.join(root, "skills", "review", "SKILL.md"),
        `---
description: Review
---
Review the change.`,
      )
    }

    const exit = await Effect.runPromiseExit(
      RuntimePlugin.materialize({
        plugins: [
          { type: "claude", path: first },
          { type: "claude", path: second },
          {
            type: "inline",
            name: "team",
            commands: [{ name: "run", template: "Run work", agent: "runner" }],
            agents: {
              runner: {
                prompt: "Run work",
                mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
              },
            },
          },
        ],
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('Duplicate runtime plugin name "dupe"')

    const materialized = await Effect.runPromise(
      RuntimePlugin.materialize({
        plugins: [
          {
            type: "inline",
            name: "team",
            commands: [{ name: "run", template: "Run work", agent: "runner" }],
            agents: {
              runner: {
                prompt: "Run work",
                mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
              },
            },
          },
        ],
      }),
    )
    expect(materialized.commands[0]?.agent).toBe("team:runner")
    expect(materialized.agents["team:runner"]?.mcpServers?.[0]?.name).toBe("plugin:team:remote")
  })

  test("collapses materialized plugin fields before persisted child runtime re-expands", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "reload-plugin")
    const sessionID = SessionID.make("ses_phase8_reload")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(root, "agents"), { recursive: true })
    await fs.mkdir(path.join(root, "hooks"), { recursive: true })
    await Bun.write(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "reload",
        mcpServers: {
          remote: { url: "https://example.com/mcp" },
        },
      }),
    )
    await Bun.write(
      path.join(root, "agents", "helper.md"),
      `---
description: Helper
---
Old helper prompt.`,
    )
    await Bun.write(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ id: "audit", matcher: "bash" }],
        },
      }),
    )

    const expanded = await Effect.runPromise(
      RuntimePlugin.expand({ plugins: [{ type: "claude", path: root }] }, sessionID),
    )
    expect(expanded.agents?.["reload:helper"]?.prompt).toBe("Old helper prompt.")
    expect(expanded.hooks?.PreToolUse).toHaveLength(1)
    expect(expanded.sdkMcpServers?.map((server) => server.name)).toEqual(["plugin:reload:remote"])

    const stored = SessionRuntimeConfig.RuntimeConfig.parse(RuntimePlugin.collapse(expanded))
    expect(stored.agents?.["reload:helper"]).toBeUndefined()
    expect(stored.hooks).toBeUndefined()
    expect(stored.sdkMcpServers).toBeUndefined()

    await Bun.write(
      path.join(root, "agents", "helper.md"),
      `---
description: Helper
---
New helper prompt after plugin edit.`,
    )

    const reexpanded = await Effect.runPromise(RuntimePlugin.expand(stored, sessionID))
    expect(reexpanded.agents?.["reload:helper"]?.prompt).toBe("New helper prompt after plugin edit.")
    expect(reexpanded.hooks?.PreToolUse).toEqual([{ id: "reload:audit", matcher: "bash" }])
    expect(reexpanded.sdkMcpServers?.map((server) => server.name)).toEqual(["plugin:reload:remote"])
  })

  test("expanded runtime snapshots keep materialized plugin assets stable after plugin edits", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "snapshot-plugin")
    const skillDir = path.join(root, "skills", "review")
    const sessionID = SessionID.make("ses_phase8_snapshot")

    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await fs.mkdir(skillDir, { recursive: true })
    await Bun.write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "snapshot" }))
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
description: Review
---
Old review guidance.`,
    )

    const runtime = { plugins: [{ type: "claude" as const, path: root }] }
    const expanded = await Effect.runPromise(RuntimePlugin.expand(runtime, sessionID))
    const beforeEdit = await Effect.runPromise(RuntimePlugin.materialize(expanded, sessionID))
    expect(beforeEdit.skills[0]?.content).toBe("Old review guidance.")

    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
description: Review
---
New review guidance after plugin edit.`,
    )

    const snapshot = await Effect.runPromise(RuntimePlugin.materialize(expanded, sessionID))
    const live = await Effect.runPromise(RuntimePlugin.materialize(runtime, sessionID))
    expect(snapshot.skills[0]?.content).toBe("Old review guidance.")
    expect(live.skills[0]?.content).toBe("New review guidance after plugin edit.")
  })

  test("collapses MCP servers inherited from plugin-provided agents", async () => {
    const sessionID = SessionID.make("ses_phase8_agent_mcp")
    const expanded = await Effect.runPromise(
      RuntimePlugin.expand(
        {
          plugins: [
            {
              type: "inline",
              name: "team",
              agents: {
                helper: {
                  prompt: "Help.",
                  mcpServers: [{ name: "remote", type: "remote", url: "https://example.com/mcp" }],
                },
              },
            },
          ],
        },
        sessionID,
      ),
    )
    const agent = AgentRuntime.materialize("team:helper", expanded.agents!["team:helper"]!)
    const child = AgentRuntime.deriveChildRuntime(expanded, agent)

    expect(child.sdkMcpServers?.map((server) => server.name)).toEqual(["plugin:team:remote"])
    const stored = SessionRuntimeConfig.RuntimeConfig.parse(RuntimePlugin.collapse(child))
    expect(stored.sdkMcpServers).toBeUndefined()
    expect(AgentRuntime.restoreAgentMcpServers(stored, agent).sdkMcpServers?.map((server) => server.name)).toEqual([
      "plugin:team:remote",
    ])
  })
})
