import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
      expect(names).toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
      expect(names).toContain("summary")
    },
  })
})

test("build agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("allow")
    },
  })
})

test("plan agent denies edits except .cognitio/plans/*", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      // Wildcard is denied
      expect(evalPerm(plan, "edit")).toBe("deny")
      // But specific path is allowed
      expect(Permission.evaluate("edit", ".cognitio/plans/foo.md", plan!.permission).action).toBe("allow")
    },
  })
})

test("explore agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
    },
  })
})

test("explore agent asks for external directories and allows Truncate.GLOB", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    },
  })
})

test("general agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await load(tmp.path, (svc) => svc.get("general"))
      expect(general).toBeDefined()
      expect(general?.mode).toBe("subagent")
      expect(general?.hidden).toBeUndefined()
      expect(evalPerm(general, "todowrite")).toBe("deny")
    },
  })
})

test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await load(tmp.path, (svc) => svc.get("compaction"))
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await load(tmp.path, (svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await load(tmp.path, (svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await load(tmp.path, (svc) => svc.get("agent_a"))
      const agentB = await load(tmp.path, (svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.list keeps the default agent first and sorts the rest by name", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const names = (await load(tmp.path, (svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await load(tmp.path, (svc) => svc.get("does_not_exist"))
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("default permission includes doom_loop and external_directory as ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "doom_loop")).toBe("ask")
      expect(evalPerm(build, "external_directory")).toBe("ask")
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "webfetch")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.GLOB deny is respected", async () => {
  const { Truncate } = await import("../../src/tool")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    },
  })
})

test("skill directories are allowed for external_directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".cognitio", "skill", "perm-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
      )
    },
  })

  const home = process.env.COGNITIO_TEST_HOME
  process.env.COGNITIO_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.get("build"))
        const skillDir = path.join(tmp.path, ".cognitio", "skill", "perm-skill")
        const target = path.join(skillDir, "reference", "notes.md")
        expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
      },
    })
  } finally {
    process.env.COGNITIO_TEST_HOME = home
  }
})

test("defaultAgent returns build when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("build")
    },
  })
})

test("defaultAgent respects default_agent config set to plan", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow(
        'default agent "does_not_exist" not found',
      )
    },
  })
})

test("defaultAgent returns plan when build is disabled and default_agent not set", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      // build is disabled, so it should return plan (next primary agent)
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // build and plan are disabled, no primary-capable agents remain
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow("no primary visible agent found")
    },
  })
})

test("settingSources gate file, JSON, and mode-promoted agents", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      agent: { "json-agent": { prompt: "JSON agent prompt", description: "from project json" } },
      mode: { "json-mode": { prompt: "JSON mode prompt" } },
    },
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".cognitio", "agent", "md-agent.md"),
        "---\ndescription: md agent\nmode: subagent\n---\nMD agent prompt\n",
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const merged = await load(tmp.path, (svc) => svc.list())
      const names = merged.map((a) => a.name)
      expect(names).toEqual(expect.arrayContaining(["json-agent", "json-mode", "md-agent"]))
      expect(merged.find((a) => a.name === "json-mode")?.mode).toBe("primary")

      const gated = await load(tmp.path, (svc) => svc.list([]))
      const gatedNames = gated.map((a) => a.name)
      expect(gatedNames).not.toContain("json-agent")
      expect(gatedNames).not.toContain("json-mode")
      expect(gatedNames).not.toContain("md-agent")
      expect(gatedNames).toContain("build")
      expect(gatedNames).toContain("explore")

      const project = await load(tmp.path, (svc) => svc.list(["project"]))
      const projectNames = project.map((a) => a.name)
      expect(projectNames).toContain("json-agent")
      expect(projectNames).toContain("json-mode")
      expect(projectNames).toContain("md-agent")

      const userOnly = await load(tmp.path, (svc) => svc.list(["user"]))
      expect(userOnly.map((a) => a.name)).not.toContain("json-agent")

      // full-source view matches the merged map (invariant)
      const full = await load(tmp.path, (svc) => svc.list(["user", "project", "local"]))
      expect(full).toEqual(merged)
    },
  })
})

test("builtin override and disable revert to pristine when sources are gated", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      agent: {
        build: { description: "overridden build" },
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const merged = await load(tmp.path, (svc) => svc.list())
      expect(merged.map((a) => a.name)).not.toContain("explore")
      const buildMerged = await load(tmp.path, (svc) => svc.get("build"))
      expect(buildMerged?.description).toBe("overridden build")

      const buildPristine = await load(tmp.path, (svc) => svc.get("build", []))
      expect(buildPristine?.description).toBe("The default agent. Executes tools based on configured permissions.")
      const explorePristine = await load(tmp.path, (svc) => svc.get("explore", []))
      expect(explorePristine).toBeDefined()
      expect(explorePristine?.native).toBe(true)
    },
  })
})

test("user-level home agents follow the user source tag with shadow-reveal", async () => {
  await using home = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".cognitio", "agent", "home-agent.md"),
        "---\ndescription: home agent\n---\nHome prompt\n",
      )
      await Bun.write(
        path.join(dir, ".cognitio", "agent", "shadow.md"),
        "---\ndescription: user version\n---\nUser prompt\n",
      )
    },
  })
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".cognitio", "agent", "shadow.md"),
        "---\ndescription: project version\n---\nProject prompt\n",
      )
    },
  })
  const prevHome = process.env.COGNITIO_TEST_HOME
  process.env.COGNITIO_TEST_HOME = home.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // home md files load after the project chain, so the user layer wins the merged view
        const mergedShadow = await load(tmp.path, (svc) => svc.get("shadow"))
        expect(mergedShadow?.description).toBe("user version")

        const userView = await load(tmp.path, (svc) => svc.list(["user"]))
        expect(userView.map((a) => a.name)).toContain("home-agent")
        expect(userView.find((a) => a.name === "shadow")?.description).toBe("user version")

        // gating the winning user layer reveals the shadowed project definition
        const projectView = await load(tmp.path, (svc) => svc.list(["project"]))
        expect(projectView.map((a) => a.name)).not.toContain("home-agent")
        expect(projectView.find((a) => a.name === "shadow")?.description).toBe("project version")
      },
    })
  } finally {
    if (prevHome === undefined) delete process.env.COGNITIO_TEST_HOME
    else process.env.COGNITIO_TEST_HOME = prevHome
  }
})

test("gated skill directories leave every agent's external_directory whitelist", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".cognitio", "skill", "proj-skill", "SKILL.md"),
        "---\nname: proj-skill\ndescription: project skill\n---\n\nSkill body.\n",
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const probe = path.join(tmp.path, ".cognitio", "skill", "proj-skill", "somefile")
      await load(tmp.path, (svc) =>
        Effect.gen(function* () {
          const mergedBuild = yield* svc.get("build")
          const mergedExplore = yield* svc.get("explore")
          expect(Permission.evaluate("external_directory", probe, mergedBuild!.permission).action).toBe("allow")
          expect(Permission.evaluate("external_directory", probe, mergedExplore!.permission).action).toBe("allow")

          // the strip applies to the shared defaults (build) AND explore's explicit copy
          const gatedBuild = yield* svc.get("build", [])
          const gatedExplore = yield* svc.get("explore", [])
          expect(Permission.evaluate("external_directory", probe, gatedBuild!.permission).action).toBe("ask")
          expect(Permission.evaluate("external_directory", probe, gatedExplore!.permission).action).toBe("ask")

          // materializing the gated view must not mutate the cached merged map
          const mergedAgain = yield* svc.get("build")
          expect(mergedAgain).toBe(mergedBuild)
          expect(Permission.evaluate("external_directory", probe, mergedAgain!.permission).action).toBe("allow")
        }),
      )
    },
  })
})

test("runtimeDefaultAgent is lenient and source-aware while defaultAgent stays strict", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      default_agent: "json-agent",
      agent: { "json-agent": { prompt: "custom default", mode: "primary" } },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await load(tmp.path, (svc) => svc.defaultAgent())).toBe("json-agent")
      expect(await load(tmp.path, (svc) => svc.runtimeDefaultAgent())).toBe("json-agent")
      // json-agent is project-file-defined: gated views fall back to build
      expect(await load(tmp.path, (svc) => svc.runtimeDefaultAgent([]))).toBe("build")
      expect(await load(tmp.path, (svc) => svc.runtimeDefaultAgent(["user"]))).toBe("build")
    },
  })
})

test("concurrent views with different settingSources do not cross-contaminate", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: { agent: { "json-agent": { prompt: "JSON agent", mode: "subagent" } } },
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".cognitio", "skill", "proj-skill", "SKILL.md"),
        "---\nname: proj-skill\ndescription: project skill\n---\n\nSkill body.\n",
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const probe = path.join(tmp.path, ".cognitio", "skill", "proj-skill", "x")
      await load(tmp.path, (svc) =>
        Effect.gen(function* () {
          // Interleave a gated view and the full view; each must be self-consistent
          // regardless of order, and neither may mutate the other's rulesets.
          const [gatedBuild, fullBuild, gatedList, fullList] = yield* Effect.all(
            [svc.get("build", []), svc.get("build"), svc.list([]), svc.list()],
            { concurrency: "unbounded" },
          )
          expect(Permission.evaluate("external_directory", probe, gatedBuild!.permission).action).toBe("ask")
          expect(Permission.evaluate("external_directory", probe, fullBuild!.permission).action).toBe("allow")
          expect(gatedList.map((a) => a.name)).not.toContain("json-agent")
          expect(fullList.map((a) => a.name)).toContain("json-agent")

          // Re-fetching the full view after the gated one still sees the project skill dir
          const fullAgain = yield* svc.get("build")
          expect(Permission.evaluate("external_directory", probe, fullAgain!.permission).action).toBe("allow")
        }),
      )
    },
  })
})

test("COGNITIO_CONFIG_DIR agents classify as the user layer", async () => {
  await using cfgDir = await tmpdir<string>({
    init: async (dir) => {
      const cd = path.join(dir, "cfgdir")
      await Bun.write(
        path.join(cd, "agent", "cfgdir-agent.md"),
        "---\ndescription: config-dir agent\nmode: subagent\n---\nCfgdir prompt\n",
      )
      return cd
    },
  })
  await using tmp = await tmpdir({ git: true })
  const prev = process.env.COGNITIO_CONFIG_DIR
  process.env.COGNITIO_CONFIG_DIR = cfgDir.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const merged = await load(tmp.path, (svc) => svc.list())
        expect(merged.map((a) => a.name)).toContain("cfgdir-agent")

        const user = await load(tmp.path, (svc) => svc.list(["user"]))
        expect(user.map((a) => a.name)).toContain("cfgdir-agent")

        const project = await load(tmp.path, (svc) => svc.list(["project"]))
        expect(project.map((a) => a.name)).not.toContain("cfgdir-agent")
      },
    })
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_CONFIG_DIR
    else process.env.COGNITIO_CONFIG_DIR = prev
  }
})

test("direct-layer (COGNITIO_CONFIG_CONTENT) agents survive settingSources []", async () => {
  await using tmp = await tmpdir({ git: true })
  const prev = process.env.COGNITIO_CONFIG_CONTENT
  process.env.COGNITIO_CONFIG_CONTENT = JSON.stringify({
    agent: { "direct-agent": { prompt: "Direct agent", mode: "subagent" } },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // "direct" provenance (caller/operator input) is never gated
        expect((await load(tmp.path, (svc) => svc.list([]))).map((a) => a.name)).toContain("direct-agent")
        expect((await load(tmp.path, (svc) => svc.get("direct-agent", []))).name).toBe("direct-agent")
      },
    })
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_CONFIG_CONTENT
    else process.env.COGNITIO_CONFIG_CONTENT = prev
  }
})

test("runtimeDefaultAgent falls to the first visible primary when build is removed", async () => {
  await using tmp = await tmpdir({ git: true })
  // Disable build via a direct source so it is gone in every view; plan remains
  // a visible primary → the third fallback leg selects it.
  const prev = process.env.COGNITIO_CONFIG_CONTENT
  process.env.COGNITIO_CONFIG_CONTENT = JSON.stringify({ agent: { build: { disable: true } } })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const picked = await load(tmp.path, (svc) => svc.runtimeDefaultAgent())
        expect(picked).not.toBe("build")
        const agent = await load(tmp.path, (svc) => svc.get(picked))
        expect(agent.mode).not.toBe("subagent")
        expect(agent.hidden).not.toBe(true)
      },
    })
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_CONFIG_CONTENT
    else process.env.COGNITIO_CONFIG_CONTENT = prev
  }
})
