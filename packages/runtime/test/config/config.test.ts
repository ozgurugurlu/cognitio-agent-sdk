import { test, expect, describe, mock, afterEach, beforeEach } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config, ConfigManaged } from "../../src/config"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@cognitio/shared/util/effect-flock"

import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { AppFileSystem } from "@cognitio/shared/filesystem"
import { Env } from "../../src/env"
import { provideTmpdirInstance } from "../fixture/fixture"
import { tmpdir } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Global } from "../../src/global"
import { ProjectID } from "../../src/project/schema"
import { Filesystem } from "../../src/util"
import { ConfigPlugin } from "@/config/plugin"
import { Npm } from "@/npm"

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const testFlock = EffectFlock.defaultLayer

const layer = Config.layer.pipe(
  Layer.provide(testFlock),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
  Layer.provide(Npm.defaultLayer),
)

const it = testEffect(layer)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const save = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.update(config)).pipe(Effect.scoped, Effect.provide(layer)))
const clear = (wait = false) =>
  Effect.runPromise(Config.Service.use((svc) => svc.invalidate(wait)).pipe(Effect.scoped, Effect.provide(layer)))
const listDirs = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.directories()).pipe(Effect.scoped, Effect.provide(layer)))
const ready = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.waitForDependencies()).pipe(Effect.scoped, Effect.provide(layer)))

// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.COGNITIO_TEST_MANAGED_CONFIG_DIR!

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  await clear(true)
})

async function writeManagedSettings(settings: object, filename = "cognitio.json") {
  await fs.mkdir(managedConfigDir, { recursive: true })
  await Filesystem.write(path.join(managedConfigDir, filename), JSON.stringify(settings))
}

async function writeConfig(dir: string, config: object, name = "cognitio.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://example.invalid/config.schema.json",
      snapshot: false,
    })
    await Instance.provide({
      directory: map(tmp.path),
      fn: async () => {
        const cfg = await load()
        expect(cfg.snapshot).toBe(true)
        expect(Instance.directory).toBe(Filesystem.resolve(tmp.path))
        expect(Instance.project.id).not.toBe(ProjectID.global)
      },
    })
  } finally {
    await Instance.disposeAll()
    ;(Global.Path as { config: string }).config = prev
    await clear()
  }
}

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBeDefined()
    },
  })
})

test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        model: "test/model",
        username: "testuser",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("loads formatter boolean config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        formatter: true,
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.formatter).toBe(true)
    },
  })
})

test("loads lsp boolean config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        lsp: true,
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.lsp).toBe(true)
    },
  })
})

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
})

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

test("ignores legacy tui keys in cognitio config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        model: "test/model",
        theme: "legacy",
        tui: { scroll_speed: 4 },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect((config as Record<string, unknown>).theme).toBeUndefined()
      expect((config as Record<string, unknown>).tui).toBeUndefined()
    },
  })
})

test("loads JSONC config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.jsonc"),
        `{
        // This is a comment
        "$schema": "https://example.invalid/config.schema.json",
        "model": "test/model",
        "username": "testuser"
      }`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("jsonc overrides json in the same directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(
        dir,
        {
          $schema: "https://example.invalid/config.schema.json",
          model: "base",
          username: "base",
        },
        "cognitio.jsonc",
      )
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        model: "override",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("base")
      expect(config.username).toBe("base")
    },
  })
})

test("handles environment variable substitution", async () => {
  const originalEnv = process.env["TEST_VAR"]
  process.env["TEST_VAR"] = "test-user"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://example.invalid/config.schema.json",
          username: "{env:TEST_VAR}",
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await load()
        expect(config.username).toBe("test-user")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["TEST_VAR"] = originalEnv
    } else {
      delete process.env["TEST_VAR"]
    }
  }
})

test("loads environment substitutions without rewriting config or injecting a hosted schema", async () => {
  const originalEnv = process.env["PRESERVE_VAR"]
  process.env["PRESERVE_VAR"] = "secret_value"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Config without $schema remains byte-for-byte unchanged.
        await Filesystem.write(
          path.join(dir, "cognitio.json"),
          JSON.stringify({
            username: "{env:PRESERVE_VAR}",
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await load()
        expect(config.username).toBe("secret_value")

        // Read the file to verify the env variable was preserved
        const content = await Filesystem.readText(path.join(tmp.path, "cognitio.json"))
        expect(content).toContain("{env:PRESERVE_VAR}")
        expect(content).not.toContain("secret_value")
        expect(config.$schema).toBeUndefined()
        expect(content).toBe(JSON.stringify({ username: "{env:PRESERVE_VAR}" }))
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["PRESERVE_VAR"] = originalEnv
    } else {
      delete process.env["PRESERVE_VAR"]
    }
  }
})

test("resolves env templates in account config with account token", async () => {
  const originalControlToken = process.env["COGNITIO_CONSOLE_TOKEN"]

  const fakeAccount = Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          provider: { cognitio: { options: { apiKey: "{env:COGNITIO_CONSOLE_TOKEN}" } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(emptyAuth),
    Layer.provide(fakeAccount),
    Layer.provideMerge(infra),
  )

  try {
    await provideTmpdirInstance(() =>
      Config.Service.use((svc) =>
        Effect.gen(function* () {
          const config = yield* svc.get()
          expect(config.provider?.["cognitio"]?.options?.apiKey).toBe("st_test_token")
        }),
      ),
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Npm.defaultLayer), Effect.runPromise)
  } finally {
    if (originalControlToken !== undefined) {
      process.env["COGNITIO_CONSOLE_TOKEN"] = originalControlToken
    } else {
      delete process.env["COGNITIO_CONSOLE_TOKEN"]
    }
  }
})

test("handles file inclusion substitution", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.txt"), "test-user")
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        username: "{file:included.txt}",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBe("test-user")
    },
  })
})

test("handles file inclusion with replacement tokens", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.md"), "const out = await Bun.$`echo hi`")
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        username: "{file:included.md}",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBe("const out = await Bun.$`echo hi`")
    },
  })
})

test("validates config schema and throws on invalid fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        invalid_field: "should cause error",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Strict schema should throw an error for invalid fields
      await expect(load()).rejects.toThrow()
    },
  })
})

test("throws error for invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "cognitio.json"), "{ invalid json }")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load()).rejects.toThrow()
    },
  })
})

test("handles agent configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        agent: {
          test_agent: {
            model: "test/model",
            temperature: 0.7,
            description: "test agent",
          },
        },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test_agent"]).toEqual(
        expect.objectContaining({
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        }),
      )
    },
  })
})

test("treats agent variant as model-scoped setting (not provider option)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        agent: {
          test_agent: {
            model: "openai/gpt-5.2",
            variant: "xhigh",
            max_tokens: 123,
          },
        },
      })
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      const agent = config.agent?.["test_agent"]

      expect(agent?.variant).toBe("xhigh")
      expect(agent?.options).toMatchObject({
        max_tokens: 123,
      })
      expect(agent?.options).not.toHaveProperty("variant")
    },
  })
})

test("handles command configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        command: {
          test_command: {
            template: "test template",
            description: "test command",
            agent: "test_agent",
          },
        },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.command?.["test_command"]).toEqual({
        template: "test template",
        description: "test command",
        agent: "test_agent",
      })
    },
  })
})

test("migrates autoshare to share field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          autoshare: true,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.share).toBe("auto")
      expect(config.autoshare).toBe(true)
    },
  })
})

test("migrates mode field to agent field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mode: {
            test_mode: {
              model: "test/model",
              temperature: 0.5,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test_mode"]).toEqual({
        model: "test/model",
        temperature: 0.5,
        mode: "primary",
        options: {},
        permission: {},
      })
    },
  })
})

test("loads config from .cognitio directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })
      const agentDir = path.join(cognitioDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "test.md"),
        `---
model: test/model
---
Test agent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]).toEqual(
        expect.objectContaining({
          name: "test",
          model: "test/model",
          prompt: "Test agent prompt",
        }),
      )
    },
  })
})

test("loads agents from .cognitio/agents (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      const agentsDir = path.join(cognitioDir, "agents")
      await fs.mkdir(path.join(agentsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(agentsDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper agent prompt`,
      )

      await Filesystem.write(
        path.join(agentsDir, "nested", "child.md"),
        `---
model: test/model
mode: subagent
---
Nested agent prompt`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper agent prompt",
      })

      expect(config.agent?.["nested/child"]).toMatchObject({
        name: "nested/child",
        model: "test/model",
        mode: "subagent",
        prompt: "Nested agent prompt",
      })
    },
  })
})

test("loads commands from .cognitio/command (singular)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      const commandDir = path.join(cognitioDir, "command")
      await fs.mkdir(path.join(commandDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandDir, "hello.md"),
        `---
description: Test command
---
Hello from singular command`,
      )

      await Filesystem.write(
        path.join(commandDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from singular command",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("loads commands from .cognitio/commands (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      const commandsDir = path.join(cognitioDir, "commands")
      await fs.mkdir(path.join(commandsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandsDir, "hello.md"),
        `---
description: Test command
---
Hello from plural commands`,
      )

      await Filesystem.write(
        path.join(commandsDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from plural commands",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("updates config and writes to file", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const newConfig = { model: "updated/model" }
      await save(newConfig as any)

      const writtenConfig = await Filesystem.readJson<{ model: string }>(path.join(tmp.path, "config.json"))
      expect(writtenConfig.model).toBe("updated/model")
    },
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await listDirs()
      expect(dirs.length).toBeGreaterThanOrEqual(1)
    },
  })
})

test("does not try to install dependencies in read-only COGNITIO_CONFIG_DIR", async () => {
  if (process.platform === "win32") return

  await using tmp = await tmpdir<string>({
    init: async (dir) => {
      const ro = path.join(dir, "readonly")
      await fs.mkdir(ro, { recursive: true })
      await fs.chmod(ro, 0o555)
      return ro
    },
    dispose: async (dir) => {
      const ro = path.join(dir, "readonly")
      await fs.chmod(ro, 0o755).catch(() => {})
      return ro
    },
  })

  const prev = process.env.COGNITIO_CONFIG_DIR
  process.env.COGNITIO_CONFIG_DIR = tmp.extra

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await load()
      },
    })
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_CONFIG_DIR
    else process.env.COGNITIO_CONFIG_DIR = prev
  }
})

test("prepares writable COGNITIO_CONFIG_DIR without adding unpublished packages", async () => {
  await using tmp = await tmpdir<string>({
    init: async (dir) => {
      const cfg = path.join(dir, "configdir")
      await fs.mkdir(cfg, { recursive: true })
      return cfg
    },
  })

  const prev = process.env.COGNITIO_CONFIG_DIR
  process.env.COGNITIO_CONFIG_DIR = tmp.extra

  const installs: unknown[] = []
  const noopNpm = Layer.mock(Npm.Service)({
    install: (directory, options) =>
      Effect.sync(() => {
        installs.push({ directory, options })
      }),
    add: () => Effect.die("not implemented"),
    outdated: () => Effect.succeed(false),
    which: () => Effect.succeed(Option.none()),
  })
  const testLayer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(emptyAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)))
        await Effect.runPromise(
          Config.Service.use((svc) => svc.waitForDependencies()).pipe(Effect.scoped, Effect.provide(testLayer)),
        )
      },
    })

    expect(installs).toEqual([])

    expect(await Filesystem.exists(path.join(tmp.extra, ".gitignore"))).toBe(true)
    expect(await Filesystem.readText(path.join(tmp.extra, ".gitignore"))).toContain("package-lock.json")
  } finally {
    if (prev === undefined) delete process.env.COGNITIO_CONFIG_DIR
    else process.env.COGNITIO_CONFIG_DIR = prev
  }
})

// Note: deduplication and serialization of npm installs is now handled by the
// shared Npm.Service (via EffectFlock). Those behaviors are tested in the shared
// package's npm tests, not here.

test("resolves scoped npm plugins in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const pluginDir = path.join(dir, "node_modules", "@scope", "plugin")
      await fs.mkdir(pluginDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
      )

      await Filesystem.write(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "@scope/plugin",
            version: "1.0.0",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      )

      await Filesystem.write(path.join(pluginDir, "index.js"), "export default {}\n")

      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({ $schema: "https://example.invalid/config.schema.json", plugin: ["@scope/plugin"] }, null, 2),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      const pluginEntries = config.plugin ?? []
      expect(pluginEntries).toContain("@scope/plugin")
    },
  })
})

test("merges plugin arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .cognitio config
      const projectDir = path.join(dir, "project")
      const cognitioDir = path.join(projectDir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: ["global-plugin-1", "global-plugin-2"],
        }),
      )

      // Local .cognitio config with different plugins
      await Filesystem.write(
        path.join(cognitioDir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: ["local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const plugins = config.plugin ?? []

      // Should contain both global and local plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)

      // Should have all 3 plugins (not replaced, but merged)
      const pluginNames = plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin"))
      expect(pluginNames.length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("does not error when only custom agent is a subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })
      const agentDir = path.join(cognitioDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper subagent prompt",
      })
    },
  })
})

test("merges instructions arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const cognitioDir = path.join(projectDir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          instructions: ["global-instructions.md", "shared-rules.md"],
        }),
      )

      await Filesystem.write(
        path.join(cognitioDir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          instructions: ["local-instructions.md"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-instructions.md")
      expect(instructions).toContain("shared-rules.md")
      expect(instructions).toContain("local-instructions.md")
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate instructions from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const cognitioDir = path.join(projectDir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          instructions: ["duplicate.md", "global-only.md"],
        }),
      )

      await Filesystem.write(
        path.join(cognitioDir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          instructions: ["duplicate.md", "local-only.md"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-only.md")
      expect(instructions).toContain("local-only.md")
      expect(instructions).toContain("duplicate.md")

      const duplicates = instructions.filter((i) => i === "duplicate.md")
      expect(duplicates.length).toBe(1)
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate plugins from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .cognitio config
      const projectDir = path.join(dir, "project")
      const cognitioDir = path.join(projectDir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: ["duplicate-plugin", "global-plugin-1"],
        }),
      )

      // Local .cognitio config with some overlapping plugins
      await Filesystem.write(
        path.join(cognitioDir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: ["duplicate-plugin", "local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const plugins = config.plugin ?? []

      // Should contain all unique plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("duplicate-plugin"))).toBe(true)

      // Should deduplicate the duplicate plugin
      const duplicatePlugins = plugins.filter((p) => p.includes("duplicate-plugin"))
      expect(duplicatePlugins.length).toBe(1)

      // Should have exactly 3 unique plugins
      const pluginNames = plugins.filter(
        (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
      )
      expect(pluginNames.length).toBe(3)
    },
  })
})

test("keeps plugin origins aligned with merged plugin list", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const project = path.join(dir, "project")
      const local = path.join(project, ".cognitio")
      await fs.mkdir(local, { recursive: true })

      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
        }),
      )

      await Filesystem.write(
        path.join(local, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const cfg = await load()
      const plugins = cfg.plugin ?? []
      const origins = cfg.plugin_origins ?? []
      const names = plugins.map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(names).toContain("shared-plugin@2.0.0")
      expect(names).not.toContain("shared-plugin@1.0.0")
      expect(names).toContain("global-only@1.0.0")
      expect(names).toContain("local-only@1.0.0")

      expect(origins.map((item) => item.spec)).toEqual(plugins)
      const hit = origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "shared-plugin@2.0.0")
      expect(hit?.scope).toBe("local")
    },
  })
})

// Legacy tools migration tests

test("migrates legacy tools config to permissions - allow", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: true,
                read: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        read: "allow",
      })
    },
  })
})

test("migrates legacy tools config to permissions - deny", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: false,
                webfetch: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "deny",
        webfetch: "deny",
      })
    },
  })
})

test("migrates legacy write tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                write: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

// Managed settings tests
// Note: preload.ts sets COGNITIO_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

test("managed settings override user settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        model: "user/model",
        share: "auto",
        username: "testuser",
      })
    },
  })

  await writeManagedSettings({
    $schema: "https://example.invalid/config.schema.json",
    model: "managed/model",
    share: "disabled",
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("managed/model")
      expect(config.share).toBe("disabled")
      expect(config.username).toBe("testuser")
    },
  })
})

test("managed settings override project settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        autoupdate: true,
        disabled_providers: [],
      })
    },
  })

  await writeManagedSettings({
    $schema: "https://example.invalid/config.schema.json",
    autoupdate: false,
    disabled_providers: ["openai"],
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.autoupdate).toBe(false)
      expect(config.disabled_providers).toEqual(["openai"])
    },
  })
})

test("missing managed settings file is not an error", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://example.invalid/config.schema.json",
        model: "user/model",
      })
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("user/model")
    },
  })
})

test("migrates legacy edit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                edit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates legacy patch tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                patch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

test("migrates legacy multiedit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                multiedit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates mixed legacy tools config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              tools: {
                bash: true,
                write: true,
                read: false,
                webfetch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        edit: "allow",
        read: "deny",
        webfetch: "allow",
      })
    },
  })
})

test("merges legacy tools with existing permission config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          agent: {
            test: {
              permission: {
                glob: "allow",
              },
              tools: {
                bash: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        glob: "allow",
        bash: "allow",
      })
    },
  })
})

test("permission config preserves key order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          permission: {
            "*": "deny",
            edit: "ask",
            write: "ask",
            external_directory: "ask",
            read: "allow",
            todowrite: "allow",
            "thoughts_*": "allow",
            "reasoning_model_*": "allow",
            "tools_*": "allow",
            "pr_comments_*": "allow",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(Object.keys(config.permission!)).toEqual([
        "*",
        "edit",
        "write",
        "external_directory",
        "read",
        "todowrite",
        "thoughts_*",
        "reasoning_model_*",
        "tools_*",
        "pr_comments_*",
      ])
    },
  })
})

// MCP config merging tests

test("project config can override MCP server enabled status", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Simulates a base config (like from remote .well-known) with disabled MCP
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: false,
            },
            wiki: {
              type: "remote",
              url: "https://wiki.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Project config enables just jira
      await Filesystem.write(
        path.join(dir, "cognitio.jsonc"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      // jira should be enabled (overridden by project config)
      expect(config.mcp?.jira).toEqual({
        type: "remote",
        url: "https://jira.example.com/mcp",
        enabled: true,
      })
      // wiki should still be disabled (not overridden)
      expect(config.mcp?.wiki).toEqual({
        type: "remote",
        url: "https://wiki.example.com/mcp",
        enabled: false,
      })
    },
  })
})

test("MCP config deep merges preserving base config properties", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Base config with full MCP definition
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: false,
              headers: {
                "X-Custom-Header": "value",
              },
            },
          },
        }),
      )
      // Override just enables it, should preserve other properties
      await Filesystem.write(
        path.join(dir, "cognitio.jsonc"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.mcp?.myserver).toEqual({
        type: "remote",
        url: "https://myserver.example.com/mcp",
        enabled: true,
        headers: {
          "X-Custom-Header": "value",
        },
      })
    },
  })
})

test("local .cognitio config can override MCP from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Project config with disabled MCP
      await Filesystem.write(
        path.join(dir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Local .cognitio directory config enables it
      const cognitioDir = path.join(dir, ".cognitio")
      await fs.mkdir(cognitioDir, { recursive: true })
      await Filesystem.write(
        path.join(cognitioDir, "cognitio.json"),
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.mcp?.docs?.enabled).toBe(true)
    },
  })
})

test("project config overrides remote well-known config", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    if (urlStr.includes(".well-known/cognitio")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  }) as unknown as typeof fetch

  const fakeAuth = Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        "https://example.com": new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(fakeAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(Npm.defaultLayer),
  )

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe("https://example.com/.well-known/cognitio")
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      {
        git: true,
        config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
      },
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wellknown URL with trailing slash is normalized", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    if (urlStr.includes(".well-known/cognitio")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  }) as unknown as typeof fetch

  const fakeAuth = Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        "https://example.com/": new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(fakeAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(Npm.defaultLayer),
  )

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            yield* svc.get()
            expect(fetchedUrl).toBe("https://example.com/.well-known/cognitio")
          }),
        ),
      { git: true },
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  } finally {
    globalThis.fetch = originalFetch
  }
})

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "cognitio.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-cognitio@2.4.3", file)).toBe("oh-my-cognitio@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "cognitio.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "cognitio.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "cognitio.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "cognitio.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPlugin.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-cognitio@2.4.3", "file:///project/.cognitio/plugin/oh-my-cognitio.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.cognitio/plugin/demo.ts", "file:///project/.cognitio/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.cognitio/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  test("loads auto-discovered local plugins as file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const projectDir = path.join(dir, "project")
        const cognitioDir = path.join(projectDir, ".cognitio")
        const pluginDir = path.join(cognitioDir, "plugin")
        await fs.mkdir(pluginDir, { recursive: true })

        await Filesystem.write(
          path.join(dir, "cognitio.json"),
          JSON.stringify({
            $schema: "https://example.invalid/config.schema.json",
            plugin: ["my-plugin@1.0.0"],
          }),
        )

        await Filesystem.write(path.join(pluginDir, "my-plugin.js"), "export default {}")
      },
    })

    await Instance.provide({
      directory: path.join(tmp.path, "project"),
      fn: async () => {
        const config = await load()
        const plugins = config.plugin ?? []

        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p) === "my-plugin@1.0.0")).toBe(true)
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p).startsWith("file://"))).toBe(true)
      },
    })
  })
})

describe("COGNITIO_DISABLE_PROJECT_CONFIG", () => {
  test("skips project config files when flag is set", async () => {
    const originalEnv = process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
    process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a project config that would normally be loaded
          await Filesystem.write(
            path.join(dir, "cognitio.json"),
            JSON.stringify({
              $schema: "https://example.invalid/config.schema.json",
              model: "project/model",
              username: "project-user",
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          // Project config should NOT be loaded - model should be default, not "project/model"
          expect(config.model).not.toBe("project/model")
          expect(config.username).not.toBe("project-user")
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips project .cognitio/ directories when flag is set", async () => {
    const originalEnv = process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
    process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a .cognitio directory with a command
          const cognitioDir = path.join(dir, ".cognitio", "command")
          await fs.mkdir(cognitioDir, { recursive: true })
          await Filesystem.write(path.join(cognitioDir, "test-cmd.md"), "# Test Command\nThis is a test command.")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const directories = await listDirs()
          // Project .cognitio should NOT be in directories list
          const hasProjectCognitio = directories.some((d) => d.startsWith(tmp.path))
          expect(hasProjectCognitio).toBe(false)
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("still loads global config when flag is set", async () => {
    const originalEnv = process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
    process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Should still get default config (from global or defaults)
          const config = await load()
          expect(config).toBeDefined()
          expect(config.username).toBeDefined()
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips relative instructions with warning when flag is set but no config dir", async () => {
    const originalDisable = process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["COGNITIO_CONFIG_DIR"]

    try {
      // Ensure no config dir is set
      delete process.env["COGNITIO_CONFIG_DIR"]
      process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = "true"

      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a config with relative instruction path
          await Filesystem.write(
            path.join(dir, "cognitio.json"),
            JSON.stringify({
              $schema: "https://example.invalid/config.schema.json",
              instructions: ["./CUSTOM.md"],
            }),
          )
          // Create the instruction file (should be skipped)
          await Filesystem.write(path.join(dir, "CUSTOM.md"), "# Custom Instructions")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // The relative instruction should be skipped without error
          // We're mainly verifying this doesn't throw and the config loads
          const config = await load()
          expect(config).toBeDefined()
          // The instruction should have been skipped (warning logged)
          // We can't easily test the warning was logged, but we verify
          // the relative path didn't cause an error
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["COGNITIO_CONFIG_DIR"]
      } else {
        process.env["COGNITIO_CONFIG_DIR"] = originalConfigDir
      }
    }
  })

  test("COGNITIO_CONFIG_DIR still works when flag is set", async () => {
    const originalDisable = process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["COGNITIO_CONFIG_DIR"]

    try {
      await using configDirTmp = await tmpdir({
        init: async (dir) => {
          // Create config in the custom config dir
          await Filesystem.write(
            path.join(dir, "cognitio.json"),
            JSON.stringify({
              $schema: "https://example.invalid/config.schema.json",
              model: "configdir/model",
            }),
          )
        },
      })

      await using projectTmp = await tmpdir({
        init: async (dir) => {
          // Create config in project (should be ignored)
          await Filesystem.write(
            path.join(dir, "cognitio.json"),
            JSON.stringify({
              $schema: "https://example.invalid/config.schema.json",
              model: "project/model",
            }),
          )
        },
      })

      process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = "true"
      process.env["COGNITIO_CONFIG_DIR"] = configDirTmp.path

      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const config = await load()
          // Should load from COGNITIO_CONFIG_DIR, not project
          expect(config.model).toBe("configdir/model")
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["COGNITIO_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["COGNITIO_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["COGNITIO_CONFIG_DIR"]
      } else {
        process.env["COGNITIO_CONFIG_DIR"] = originalConfigDir
      }
    }
  })
})

describe("COGNITIO_CONFIG_CONTENT token substitution", () => {
  test("substitutes {env:} tokens in COGNITIO_CONFIG_CONTENT", async () => {
    const originalEnv = process.env["COGNITIO_CONFIG_CONTENT"]
    const originalTestVar = process.env["TEST_CONFIG_VAR"]
    process.env["TEST_CONFIG_VAR"] = "test_api_key_12345"
    process.env["COGNITIO_CONFIG_CONTENT"] = JSON.stringify({
      $schema: "https://example.invalid/config.schema.json",
      username: "{env:TEST_CONFIG_VAR}",
    })

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          expect(config.username).toBe("test_api_key_12345")
        },
      })
    } finally {
      if (originalEnv !== undefined) {
        process.env["COGNITIO_CONFIG_CONTENT"] = originalEnv
      } else {
        delete process.env["COGNITIO_CONFIG_CONTENT"]
      }
      if (originalTestVar !== undefined) {
        process.env["TEST_CONFIG_VAR"] = originalTestVar
      } else {
        delete process.env["TEST_CONFIG_VAR"]
      }
    }
  })

  test("substitutes {file:} tokens in COGNITIO_CONFIG_CONTENT", async () => {
    const originalEnv = process.env["COGNITIO_CONFIG_CONTENT"]

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "api_key.txt"), "secret_key_from_file")
          process.env["COGNITIO_CONFIG_CONTENT"] = JSON.stringify({
            $schema: "https://example.invalid/config.schema.json",
            username: "{file:./api_key.txt}",
          })
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          expect(config.username).toBe("secret_key_from_file")
        },
      })
    } finally {
      if (originalEnv !== undefined) {
        process.env["COGNITIO_CONFIG_CONTENT"] = originalEnv
      } else {
        delete process.env["COGNITIO_CONFIG_CONTENT"]
      }
    }
  })
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "Cognitio Managed",
          PayloadIdentifier: "ai.cognitio.managed.test",
          PayloadType: "ai.cognitio.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          share: "disabled",
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.share).toBe("disabled")
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          server: { hostname: "127.0.0.1", mdns: false },
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://example.invalid/config.schema.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: "https://example.invalid/config.schema.json" })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe("https://example.invalid/config.schema.json")
})

describe("COGNITIO_ISOLATED", () => {
  async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) {
    const saved = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(env)) {
      saved.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      return await fn()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test("skips global config and legacy TOML migration", async () => {
    await using tmp = await tmpdir()
    const globalConfig = path.join(Global.Path.config, "config.json")
    const legacy = path.join(Global.Path.config, "config")
    const prevGlobal = await fs.readFile(globalConfig, "utf8").catch(() => undefined)
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(globalConfig, JSON.stringify({ model: "global/marker" }))
    await fs.writeFile(legacy, 'provider = "legacy"\nmodel = "legacy-model"\n')
    try {
      await withEnv({ COGNITIO_ISOLATED: "1" }, async () => {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const cfg = await load()
            expect(cfg.model).toBeUndefined()
          },
        })
      })
      expect(await fs.readFile(legacy, "utf8")).toContain("legacy-model")
      expect(JSON.parse(await fs.readFile(globalConfig, "utf8"))).toEqual({ model: "global/marker" })
    } finally {
      await fs.rm(legacy, { force: true })
      if (prevGlobal === undefined) await fs.rm(globalConfig, { force: true })
      else await fs.writeFile(globalConfig, prevGlobal)
      await clear(true)
    }
  })

  test("ignores managed settings while control run still sees them", async () => {
    await writeManagedSettings({ model: "managed/model" })
    await using tmp = await tmpdir()
    await withEnv({ COGNITIO_ISOLATED: "1" }, async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const cfg = await load()
          expect(cfg.model).toBeUndefined()
        },
      })
    })
    await clear(true)
    await using control = await tmpdir()
    await Instance.provide({
      directory: control.path,
      fn: async () => {
        const cfg = await load()
        expect(cfg.model).toBe("managed/model")
      },
    })
  })

  test("skips gitignore and npm install but still loads COGNITIO_CONFIG_DIR resources", async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        const cfg = path.join(dir, "configdir")
        await fs.mkdir(path.join(cfg, "command"), { recursive: true })
        await Filesystem.write(path.join(cfg, "command", "iso-cmd.md"), "---\ndescription: iso\n---\niso body")
        return cfg
      },
    })
    let installs = 0
    const spyNpm = Layer.mock(Npm.Service)({
      install: () =>
        Effect.sync(() => {
          installs++
        }),
      add: () => Effect.die("not implemented"),
      outdated: () => Effect.succeed(false),
      which: () => Effect.succeed(Option.none()),
    })
    const testLayer = Config.layer.pipe(
      Layer.provide(testFlock),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(emptyAuth),
      Layer.provide(emptyAccount),
      Layer.provideMerge(infra),
      Layer.provide(spyNpm),
    )
    await withEnv({ COGNITIO_ISOLATED: "1", COGNITIO_CONFIG_DIR: tmp.extra }, async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const cfg = await Effect.runPromise(
            Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)),
          )
          expect(cfg.command?.["iso-cmd"]).toBeDefined()
          const dirs = await Effect.runPromise(
            Config.Service.use((svc) => svc.directories()).pipe(Effect.scoped, Effect.provide(testLayer)),
          )
          expect(dirs).toEqual([tmp.extra])
        },
      })
    })
    expect(installs).toBe(0)
    expect(await Filesystem.exists(path.join(tmp.extra, ".gitignore"))).toBe(false)
  })

  test("still merges COGNITIO_CONFIG_CONTENT", async () => {
    await using tmp = await tmpdir()
    await withEnv(
      { COGNITIO_ISOLATED: "1", COGNITIO_CONFIG_CONTENT: JSON.stringify({ model: "content/model" }) },
      async () => {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const cfg = await load()
            expect(cfg.model).toBe("content/model")
          },
        })
      },
    )
  })

  test("keeps wellknown provider token but skips remote config import", async () => {
    const wellknownAuth = Layer.mock(Auth.Service)({
      all: () =>
        Effect.succeed({
          "http://127.0.0.1:1": { type: "wellknown" as const, key: "ISO_WK_TOKEN", token: "tok-123" },
        }),
    })
    const testLayer = Config.layer.pipe(
      Layer.provide(testFlock),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(wellknownAuth),
      Layer.provide(emptyAccount),
      Layer.provideMerge(infra),
      Layer.provide(Npm.defaultLayer),
    )
    await using tmp = await tmpdir()
    try {
      await withEnv({ COGNITIO_ISOLATED: "1" }, async () => {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            // Success itself proves the remote fetch was skipped: the wellknown
            // URL is unreachable and a fetch attempt would die instance startup.
            await Effect.runPromise(
              Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)),
            )
            expect(process.env.ISO_WK_TOKEN).toBe("tok-123")
          },
        })
      })
    } finally {
      delete process.env.ISO_WK_TOKEN
    }
  })

  test("does not query the console account", async () => {
    const explodingAccount = Layer.mock(Account.Service)({
      active: () => Effect.die("console account must not be queried when isolated"),
      activeOrg: () => Effect.die("console account must not be queried when isolated"),
    })
    const testLayer = Config.layer.pipe(
      Layer.provide(testFlock),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(emptyAuth),
      Layer.provide(explodingAccount),
      Layer.provideMerge(infra),
      Layer.provide(Npm.defaultLayer),
    )
    await using tmp = await tmpdir()
    await withEnv({ COGNITIO_ISOLATED: "1" }, async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const cfg = await Effect.runPromise(
            Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)),
          )
          expect(cfg).toBeDefined()
        },
      })
    })
  })

  test("drops ~/.cognitio and the global config dir from directories", async () => {
    await using home = await tmpdir<string>({
      init: async (dir) => {
        const dot = path.join(dir, ".cognitio")
        await fs.mkdir(dot, { recursive: true })
        return dot
      },
    })
    await using tmp = await tmpdir()
    const prevHome = process.env.COGNITIO_TEST_HOME
    process.env.COGNITIO_TEST_HOME = home.path
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const before = await listDirs()
          expect(before).toContain(Global.Path.config)
          expect(before).toContain(home.extra)
        },
      })
      await clear(true)
      await withEnv({ COGNITIO_ISOLATED: "1" }, async () => {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const after = await listDirs()
            expect(after).not.toContain(Global.Path.config)
            expect(after).not.toContain(home.extra)
          },
        })
      })
    } finally {
      if (prevHome === undefined) delete process.env.COGNITIO_TEST_HOME
      else process.env.COGNITIO_TEST_HOME = prevHome
      await clear(true)
    }
  })
})
