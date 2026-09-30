import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionRuntimeConfig } from "../../src/session/runtime-config"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

describe("tool.skill", () => {
  it.live("execute returns skill content block with files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".cognitio", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

          const home = process.env.COGNITIO_TEST_HOME
          process.env.COGNITIO_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.COGNITIO_TEST_HOME = home
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "cognitio" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "tool-skill" }, ctx)
          const file = path.resolve(skill, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.dir).toBe(skill)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        }),
      { git: true },
    ),
  )

  it.live("execute loads runtime skill without filesystem base directory", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "cognitio" as any,
            modelID: "gpt-5" as any,
            agent,
            runtime: {
              skills: [{ name: "runtime-skill", description: "Runtime skill", content: "Runtime instructions." }],
            },
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            extra: {
              runtime: {
                skills: [{ name: "runtime-skill", description: "Runtime skill", content: "Runtime instructions." }],
              },
            },
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "runtime-skill" }, ctx)
          expect(requests[0].patterns).toContain("runtime-skill")
          expect(result.metadata.dir).toBeUndefined()
          expect(result.output).toContain(`<skill_content name="runtime-skill">`)
          expect(result.output).toContain("Runtime instructions.")
          expect(result.output).not.toContain("Base directory for this skill")
        }),
      { git: true },
    ),
  )

  it.live("execute applies the active agent skill deny rules", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const runtime: SessionRuntimeConfig.RuntimeConfig = {
            skills: [{ name: "runtime-skill", description: "Runtime skill", content: "Runtime instructions." }],
          }
          const tool = (yield* registry.tools({
            providerID: "cognitio" as any,
            modelID: "gpt-5" as any,
            agent,
            runtime,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          let asked = false
          const exit = yield* Effect.exit(
            tool.execute(
              { name: "runtime-skill" },
              {
                ...baseCtx,
                extra: { runtime },
                ask: () =>
                  Effect.sync(() => {
                    asked = true
                  }),
              },
            ),
          )

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('Skill "runtime-skill" not found')
          expect(asked).toBe(false)
        }),
      {
        git: true,
        config: {
          permission: {
            skill: {
              "runtime-skill": "deny",
            },
          },
        },
      },
    ),
  )
})
