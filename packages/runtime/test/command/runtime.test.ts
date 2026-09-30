import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Command } from "../../src/command"
import { CommandRuntime } from "../../src/command/runtime"
import { Config } from "../../src/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("CommandRuntime", () => {
  it.live("merges plugin and direct runtime commands and skills in precedence order", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".cognitio", "command", "custom.md"),
              `---
description: File command
---
file command`,
            ),
          )

          const list = yield* CommandRuntime.list({
            commands: [{ name: "custom", template: "runtime command" }],
            skills: [
              { name: "custom", description: "Runtime custom skill", content: "runtime skill should not win" },
              {
                name: "runtime-skill",
                description: "Runtime skill",
                content: "runtime skill",
                model: { providerID: "test", modelID: "runtime-skill-model" },
              },
            ],
            plugins: [
              {
                type: "inline",
                name: "team",
                commands: [{ name: "ship", template: "ship" }],
                skills: [{ name: "triage", description: "Triage", content: "triage", model: "test/plugin-skill-model" }],
              },
            ],
          })

          expect(list.find((command) => command.name === "custom")?.template).toBe("runtime command")
          expect(list.find((command) => command.name === "runtime-skill")?.source).toBe("skill")
          expect(list.find((command) => command.name === "runtime-skill")?.model).toBe("test/runtime-skill-model")
          expect(list.find((command) => command.name === "team:ship")?.origin).toBe("plugin")
          expect(list.find((command) => command.name === "team:triage")?.source).toBe("skill")
          expect(list.find((command) => command.name === "team:triage")?.model).toBe("test/plugin-skill-model")
        }),
      { git: true },
    ),
  )

  it.live("applies command tool policy as a narrowing overlay", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = (yield* CommandRuntime.get("locked", {
            commands: [
              { name: "locked", template: "locked", allowedTools: ["read", "Bash(npm:*)"], disallowedTools: ["write"] },
            ],
          }))!
          expect(
            CommandRuntime.applyToolPolicy({ allowedTools: ["read", "bash"], disallowedTools: ["glob"] }, command),
          ).toEqual({
            allowedTools: ["read", "bash(npm *)"],
            disallowedTools: ["glob", "write"],
          })

          const broad = (yield* CommandRuntime.get("broad", {
            commands: [{ name: "broad", template: "broad", allowedTools: ["bash"] }],
          }))!
          expect(CommandRuntime.applyToolPolicy({ allowedTools: ["bash(git *)"] }, broad)).toEqual({
            allowedTools: ["bash(git *)"],
          })

          const incompatible = (yield* CommandRuntime.get("incompatible", {
            commands: [{ name: "incompatible", template: "incompatible", allowedTools: ["bash(npm *)"] }],
          }))!
          expect(CommandRuntime.applyToolPolicy({ allowedTools: ["bash(git *)"] }, incompatible)).toEqual({
            allowedTools: [],
            disallowedTools: ["*"],
          })
        }),
      { git: true },
    ),
  )

  it.live("settingSources gate file, project-json, and skill-derived commands", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(dir, ".cognitio", "command", "md-cmd.md"),
              `---\ndescription: md command\n---\nmd body`,
            )
            await Bun.write(
              path.join(dir, ".cognitio", "skill", "skill-cmd", "SKILL.md"),
              `---\nname: skill-cmd\ndescription: project skill command\n---\n\nSkill body.\n`,
            )
          })

          const merged = yield* CommandRuntime.list({})
          const names = merged.map((command) => command.name)
          expect(names).toContain("init")
          expect(names).toContain("review")
          expect(names).toContain("md-cmd")
          expect(names).toContain("json-cmd")
          expect(merged.find((command) => command.name === "skill-cmd")?.origin).toBe("skill")

          const gated = yield* CommandRuntime.list({
            settingSources: [],
            commands: [{ name: "rt-cmd", template: "runtime body" }],
            plugins: [{ type: "inline", name: "team", commands: [{ name: "ship", template: "ship" }] }],
          })
          const gatedNames = gated.map((command) => command.name)
          // builtins, runtime, and plugin commands are never file-gated
          expect(gatedNames).toContain("init")
          expect(gatedNames).toContain("review")
          expect(gatedNames).toContain("rt-cmd")
          expect(gatedNames).toContain("team:ship")
          expect(gatedNames).not.toContain("md-cmd")
          expect(gatedNames).not.toContain("json-cmd")
          expect(gatedNames).not.toContain("skill-cmd")

          const project = yield* CommandRuntime.list({ settingSources: ["project"] })
          const projectNames = project.map((command) => command.name)
          expect(projectNames).toContain("md-cmd")
          expect(projectNames).toContain("json-cmd")
          expect(projectNames).toContain("skill-cmd")

          const userOnly = yield* CommandRuntime.list({ settingSources: ["user"] })
          expect(userOnly.map((command) => command.name)).not.toContain("md-cmd")

          // full-source view matches the merged view (invariant)
          const full = yield* CommandRuntime.list({ settingSources: ["user", "project", "local"] })
          expect(full.map((command) => command.name)).toEqual(merged.map((command) => command.name))
        }),
      { git: true, config: { command: { "json-cmd": { template: "json body", description: "json command" } } } },
    ),
  )

  const mcpMock = Layer.mock(MCP.Service)({
    prompts: () =>
      Effect.succeed({
        "dup-cmd": { client: "mock", name: "dup-cmd", description: "mcp version", arguments: undefined },
      } as never),
  })

  const itMcp = testEffect(
    Layer.mergeAll(
      Command.layer.pipe(Layer.provide(mcpMock), Layer.provide(Config.defaultLayer), Layer.provide(Skill.defaultLayer)),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  itMcp.live("MCP commands override config commands regardless of sources", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const merged = yield* CommandRuntime.get("dup-cmd", {})
          expect(merged?.origin).toBe("mcp")
          const gated = yield* CommandRuntime.get("dup-cmd", { settingSources: [] })
          expect(gated?.origin).toBe("mcp")
          const full = yield* CommandRuntime.get("dup-cmd", { settingSources: ["user", "project", "local"] })
          expect(full?.origin).toBe("mcp")
        }),
      { git: true, config: { command: { "dup-cmd": { template: "config version", description: "config version" } } } },
    ),
  )
})
