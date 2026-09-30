import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { Ripgrep } from "../file/ripgrep"
import { Agent } from "@/agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { Skill } from "../skill"
import { SkillRuntime } from "../skill/runtime"
import { RuntimePlugin } from "@/plugin/runtime"
import type { SessionRuntimeConfig } from "@/session/runtime-config"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const runtime = ctx.extra?.runtime as SessionRuntimeConfig.RuntimeConfig | undefined
          const agent = yield* AgentRuntime.get(ctx.agent, runtime).pipe(Effect.provideService(Agent.Service, agents))
          const info = yield* SkillRuntime.get(params.name, runtime, agent, undefined, ctx.sessionID).pipe(
            Effect.provideService(Skill.Service, skill),
          )
          if (!info) {
            const all = yield* SkillRuntime.list(runtime, agent, undefined, ctx.sessionID).pipe(
              Effect.provideService(Skill.Service, skill),
            )
            const available = all.map((item) => item.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = info.baseDir ?? (info.location ? path.dirname(info.location) : undefined)
          const base = dir ? pathToFileURL(dir).href : undefined
          const limit = 10
          const files = dir
            ? yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
                Stream.filter((file) => !file.includes("SKILL.md")),
                Stream.map((file) => path.resolve(dir, file)),
                Stream.take(limit),
                Stream.runCollect,
                Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
                Effect.catchCause(() => Effect.succeed("")),
              )
            : ""
          const content = RuntimePlugin.substitute(info.content.trim(), {
            sessionID: ctx.sessionID,
            pluginRoot: info.pluginRoot,
            skillDir: info.skillDir ?? dir,
          })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              content,
              "",
              ...(base
                ? [
                    `Base directory for this skill: ${base}`,
                    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
                    "Note: file list is sampled.",
                    "",
                    "<skill_files>",
                    files,
                    "</skill_files>",
                  ]
                : []),
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              ...(dir ? { dir } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
