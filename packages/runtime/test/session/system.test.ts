import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".cognitio", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.COGNITIO_TEST_HOME
    process.env.COGNITIO_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const runSkills = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(runSkills)
          const second = await Effect.runPromise(runSkills)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.COGNITIO_TEST_HOME = home
    }
  })

  test("runtime skills are model-facing unless disabled or denied", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent: Agent.Info = {
          name: "build",
          mode: "primary" as const,
          permission: [],
          options: {},
        }
        const denied: Agent.Info = {
          ...agent,
          permission: [{ permission: "skill", pattern: "runtime-denied", action: "deny" as const }],
        }
        const runtime = {
          skills: [
            { name: "runtime-visible", description: "Visible runtime skill.", content: "Use visible runtime skill." },
            {
              name: "runtime-hidden",
              description: "Hidden runtime skill.",
              content: "Use hidden runtime skill.",
              disableModelInvocation: true,
            },
            { name: "runtime-denied", description: "Denied runtime skill.", content: "Use denied runtime skill." },
          ],
          plugins: [
            {
              type: "inline" as const,
              name: "team",
              skills: [{ name: "triage", description: "Triage skill.", content: "Use team triage." }],
            },
          ],
        }

        const runSkills = (input: typeof agent) =>
          Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(input, runtime)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

        const visible = await Effect.runPromise(runSkills(agent))
        expect(visible).toContain("<name>runtime-visible</name>")
        expect(visible).toContain("<name>team:triage</name>")
        expect(visible).not.toContain("runtime-hidden")

        const filtered = await Effect.runPromise(runSkills(denied))
        expect(filtered).not.toContain("runtime-denied")
      },
    })
  })

  test("skills section is omitted when gated by tool rules or empty", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent: Agent.Info = {
          name: "build",
          mode: "primary" as const,
          permission: [],
          options: {},
        }
        const runtimeSkills = {
          skills: [{ name: "runtime-visible", description: "Visible runtime skill.", content: "Use it." }],
        }

        const runSkills = (runtime?: object) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SystemPrompt.Service
              return yield* svc.skills(agent, runtime as never)
            }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
          )

        // zero skills → no section at all (previously "No skills are currently available.")
        expect(await runSkills()).toBeUndefined()

        expect(await runSkills(runtimeSkills)).toContain("runtime-visible")
        expect(await runSkills({ ...runtimeSkills, disallowedTools: ["skill"] })).toBeUndefined()
        expect(await runSkills({ ...runtimeSkills, allowedTools: ["read"] })).toBeUndefined()
        expect(await runSkills({ ...runtimeSkills, allowedTools: ["skill"] })).toContain("runtime-visible")
      },
    })
  })
})
