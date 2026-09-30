import { describe, expect, test } from "bun:test"
import { assertAuthContent, buildIsolatedEnv, isReservedEnvKey, scratchLayout } from "../src/internal/spawn-env.js"

const scratch = scratchLayout("/scratch/agent-sdk-abc", "darwin")
const curatedProviderKeys = [
  "CEREBRAS_API_KEY",
  "COHERE_API_KEY",
  "DEEPINFRA_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "LLAMA_API_KEY",
  "LMSTUDIO_API_KEY",
  "MINIMAX_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OLLAMA_API_KEY",
  "TOGETHER_API_KEY",
  "UPSTAGE_API_KEY",
  "XAI_API_KEY",
  "ZHIPU_API_KEY",
] as const

function build(input?: {
  parentEnv?: Record<string, string | undefined>
  passEnv?: string[]
  env?: Record<string, string>
  auth?: Record<string, { type: string } & Record<string, unknown>>
  platform?: NodeJS.Platform
}) {
  return buildIsolatedEnv({
    parentEnv: input?.parentEnv ?? {},
    scratch: input?.platform === "win32" ? scratchLayout("/scratch/agent-sdk-abc", "win32") : scratch,
    platform: input?.platform ?? "darwin",
    passEnv: input?.passEnv,
    env: input?.env,
    auth: input?.auth as never,
  })
}

describe("buildIsolatedEnv", () => {
  test("base shape: scratch world + SDK-managed keys, nothing else", () => {
    const env = build()
    expect(env).toEqual({
      HOME: scratch.home,
      XDG_CONFIG_HOME: scratch.xdgConfig,
      XDG_DATA_HOME: scratch.xdgData,
      XDG_CACHE_HOME: scratch.xdgCache,
      XDG_STATE_HOME: scratch.xdgState,
      TMPDIR: scratch.tmp,
      COGNITIO_ISOLATED: "1",
      COGNITIO_AUTH_CONTENT: "{}",
      COGNITIO_DISABLE_AUTOUPDATE: "1",
    })
  })

  test("allowlist passes exact provider keys, prefixes, and proxies; near-misses stay out", () => {
    const env = build({
      parentEnv: {
        ANTHROPIC_API_KEY: "sk-a",
        ANTHROPIC_BASE_URL: "https://elsewhere",
        OPENAI_API_KEY: "sk-o",
        OPENROUTER_API_KEY: "sk-r",
        GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
        AWS_REGION: "eu-1",
        AZURE_TENANT_ID: "tid",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel",
        HTTP_PROXY: "http://proxy",
        https_proxy: "http://proxy2",
        NO_PROXY: "localhost",
        RANDOM_SECRET: "nope",
        NODE_OPTIONS: "--inspect",
        BUN_OPTIONS: "--hot",
      },
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-a")
    expect(env.OPENAI_API_KEY).toBe("sk-o")
    expect(env.OPENROUTER_API_KEY).toBe("sk-r")
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/creds.json")
    expect(env.AWS_REGION).toBe("eu-1")
    expect(env.AZURE_TENANT_ID).toBe("tid")
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://otel")
    expect(env.HTTP_PROXY).toBe("http://proxy")
    expect(env.https_proxy).toBe("http://proxy2")
    expect(env.NO_PROXY).toBe("localhost")
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.RANDOM_SECRET).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.BUN_OPTIONS).toBeUndefined()
  })

  for (const key of curatedProviderKeys) {
    test(`allowlist forwards the exact curated provider credential ${key}`, () => {
      expect(build({ parentEnv: { [key]: `value-for-${key}` } })[key]).toBe(`value-for-${key}`)
    })
  }

  test("provider credential allowlist remains exact and preserves deliberate exclusions", () => {
    const env = build({
      parentEnv: {
        NANO_GPT_API_KEY: "not-reviewed",
        GITHUB_TOKEN: "general-purpose",
        COGNITIO_API_KEY: "ambient-cognitio",
      },
    })
    expect(env.NANO_GPT_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.COGNITIO_API_KEY).toBeUndefined()
  })

  test("spawn.env is the documented escape hatch for the excluded COGNITIO_API_KEY", () => {
    // Step 5 (literal overrides) allows non-reserved COGNITIO_* keys, so the
    // gateway credential still has an explicit route even though step 3 never
    // forwards it from the parent. Both halves of the README rule are pinned.
    const env = build({ parentEnv: { COGNITIO_API_KEY: "ambient-cognitio" }, env: { COGNITIO_API_KEY: "sk-x" } })
    expect(env.COGNITIO_API_KEY).toBe("sk-x")
    expect(build({ env: { COGNITIO_API_KEY: "sk-x" } }).COGNITIO_API_KEY).toBe("sk-x")
  })

  test("win32 provider allowlist matching is case-insensitive and emits the canonical name", () => {
    const env = build({
      platform: "win32",
      parentEnv: {
        groq_api_key: "groq",
        openai_api_key: "openai",
        google_api_key: "google",
        nano_gpt_api_key: "not-reviewed",
      },
    })
    // Matched case-insensitively, but forwarded under the canonical spelling —
    // never the parent's — so no key can appear twice in a case-insensitive
    // environment. Prefix matches (`GOOGLE_*`) canonicalize the same way.
    expect(env.GROQ_API_KEY).toBe("groq")
    expect(env.OPENAI_API_KEY).toBe("openai")
    expect(env.GOOGLE_API_KEY).toBe("google")
    expect(env.groq_api_key).toBeUndefined()
    expect(env.openai_api_key).toBeUndefined()
    expect(env.google_api_key).toBeUndefined()
    expect(env.NANO_GPT_API_KEY).toBeUndefined()
    expect(env.nano_gpt_api_key).toBeUndefined()
  })

  test("win32 spawn.env reliably wins over a differently-cased parent allowlist value", () => {
    const env = build({
      platform: "win32",
      parentEnv: { groq_api_key: "parent" },
      env: { GROQ_API_KEY: "override" },
    })
    // Exactly one spelling reaches the child, so the documented layer order
    // (spawn.env over the allowlist) is a guarantee rather than a coin flip on a
    // platform where env names are case-insensitive.
    const spellings = Object.keys(env).filter((key) => key.toUpperCase() === "GROQ_API_KEY")
    expect(spellings).toEqual(["GROQ_API_KEY"])
    expect(env.GROQ_API_KEY).toBe("override")
  })

  test("win32 passEnv resolves the parent name case-insensitively, like the base passthrough", () => {
    const env = build({
      platform: "win32",
      parentEnv: { My_Custom_Token: "secret" },
      passEnv: ["MY_CUSTOM_TOKEN"],
    })
    expect(env.MY_CUSTOM_TOKEN).toBe("secret")
    expect(
      build({ platform: "linux", parentEnv: { My_Custom_Token: "s" }, passEnv: ["MY_CUSTOM_TOKEN"] }).MY_CUSTOM_TOKEN,
    ).toBeUndefined()
  })

  test("arbitrary parent secrets are dropped unless explicitly passed", () => {
    const env = build({ parentEnv: { SECRET_X: "should-not-pass", MY_TOKEN: "nope" } })
    expect(env.SECRET_X).toBeUndefined()
    expect(env.MY_TOKEN).toBeUndefined()
  })

  test("base passthrough forwards PATH/SHELL/TERM/locale and LC_* prefix", () => {
    const env = build({
      parentEnv: {
        PATH: "/bin",
        SHELL: "/bin/zsh",
        TERM: "xterm",
        COLORTERM: "truecolor",
        LANG: "en_US.UTF-8",
        LANGUAGE: "en",
        TZ: "UTC",
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "UTF-8",
        EDITOR: "vim",
      },
    })
    expect(env.PATH).toBe("/bin")
    expect(env.SHELL).toBe("/bin/zsh")
    expect(env.COLORTERM).toBe("truecolor")
    expect(env.LANGUAGE).toBe("en")
    expect(env.LC_ALL).toBe("en_US.UTF-8")
    expect(env.LC_CTYPE).toBe("UTF-8")
    expect(env.EDITOR).toBeUndefined()
  })

  test("passEnv forwards named vars, skips missing ones, and rejects COGNITIO_*", () => {
    const env = build({
      parentEnv: { SECRET_X: "s3cret", PATH: "/bin" },
      passEnv: ["SECRET_X", "MISSING_VAR"],
    })
    expect(env.SECRET_X).toBe("s3cret")
    expect("MISSING_VAR" in env).toBe(false)

    expect(() => build({ passEnv: ["COGNITIO_CONFIG"] })).toThrow(/passEnv must not include COGNITIO_CONFIG/)
  })

  test("passEnv cannot re-point the scratch world via reserved keys", () => {
    for (const key of ["HOME", "XDG_DATA_HOME", "TMPDIR", "USERPROFILE"]) {
      let error: Error | undefined
      try {
        build({ parentEnv: { [key]: "/host/leak" }, passEnv: [key] })
      } catch (err) {
        error = err as Error
      }
      expect(error?.message).toContain(key)
      expect(error?.message).not.toContain("/host/leak")
    }
    // scratch world stays put when passEnv is well-behaved
    const env = build({ parentEnv: { SECRET_X: "ok" }, passEnv: ["SECRET_X"] })
    expect(env.HOME).toBe(scratch.home)
  })

  test("win32 reserved checks are case-insensitive for env and passEnv", () => {
    const winScratch = scratchLayout("/scratch/agent-sdk-abc", "win32")
    const buildWin = (opts: { env?: Record<string, string>; passEnv?: string[] }) =>
      buildIsolatedEnv({ parentEnv: {}, scratch: winScratch, platform: "win32", ...opts })
    expect(() => buildWin({ env: { home: "/x" } })).toThrow(/reserved key home/)
    expect(() => buildWin({ env: { Tmpdir: "/x" } })).toThrow(/reserved key Tmpdir/)
    expect(() => buildWin({ passEnv: ["UserProfile"] })).toThrow(/reserved key UserProfile/)
    // lowercase COGNITIO_* passEnv must be rejected on win32 (case-insensitive env)
    expect(() => buildWin({ passEnv: ["cognitio_db"] })).toThrow(/passEnv must not include cognitio_db/)
    expect(isReservedEnvKey("home", "win32")).toBe(true)
    expect(isReservedEnvKey("home", "linux")).toBe(false)
  })

  test("env literal overrides win over allowlist and passEnv", () => {
    const env = build({
      parentEnv: { ANTHROPIC_API_KEY: "parent", SECRET_X: "parent" },
      passEnv: ["SECRET_X"],
      env: { ANTHROPIC_API_KEY: "override", SECRET_X: "override", EXTRA: "extra" },
    })
    expect(env.ANTHROPIC_API_KEY).toBe("override")
    expect(env.SECRET_X).toBe("override")
    expect(env.EXTRA).toBe("extra")
  })

  test("reserved env keys are rejected with key-only error messages", () => {
    const reserved = [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "APPDATA",
      "LOCALAPPDATA",
      "COGNITIO_ISOLATED",
      "COGNITIO_AUTH_CONTENT",
      "COGNITIO_CONFIG_CONTENT",
    ]
    for (const key of reserved) {
      expect(isReservedEnvKey(key)).toBe(true)
      let error: Error | undefined
      try {
        build({ env: { [key]: "sensitive-value" } })
      } catch (err) {
        error = err as Error
      }
      expect(error?.message).toContain(key)
      expect(error?.message).not.toContain("sensitive-value")
    }
  })

  test("non-reserved COGNITIO_* env keys pass through", () => {
    const env = build({ env: { COGNITIO_DB: ":memory:", COGNITIO_MODELS_URL: "http://models" } })
    expect(env.COGNITIO_DB).toBe(":memory:")
    expect(env.COGNITIO_MODELS_URL).toBe("http://models")
  })

  test("parent COGNITIO_* values never pass implicitly and SDK keys always win", () => {
    const env = build({
      parentEnv: {
        COGNITIO_CONFIG: "/host/cognitio.json",
        COGNITIO_AUTH_CONTENT: '{"leak":true}',
        COGNITIO_ISOLATED: "0",
        COGNITIO_DB: "/host/db.sqlite",
      },
      auth: { anthropic: { type: "api", key: "sk-x" } },
    })
    expect(env.COGNITIO_CONFIG).toBeUndefined()
    expect(env.COGNITIO_DB).toBeUndefined()
    expect(env.COGNITIO_ISOLATED).toBe("1")
    expect(JSON.parse(env.COGNITIO_AUTH_CONTENT!)).toEqual({ anthropic: { type: "api", key: "sk-x" } })
  })

  test("COGNITIO_BIN_PATH is parent-side only and never reaches the child", () => {
    // It selects which binary the SDK spawns. Forwarding it would let the child
    // re-resolve a server of its own, and it is an COGNITIO_* key, so P12's
    // rule already excludes it — this pins that it stays excluded.
    const env = build({ parentEnv: { COGNITIO_BIN_PATH: "/host/cognitio" } })
    expect(env.COGNITIO_BIN_PATH).toBeUndefined()
    expect(() => build({ passEnv: ["COGNITIO_BIN_PATH"] })).toThrow(/passEnv must not include COGNITIO_BIN_PATH/)
    // But it is not a reserved key, so an explicit `env` entry is still allowed
    // for a caller who really wants the child to see it.
    expect(build({ env: { COGNITIO_BIN_PATH: "/explicit/cognitio" } }).COGNITIO_BIN_PATH).toBe("/explicit/cognitio")
  })

  test("win32 branch redirects profile dirs and reads base keys case-insensitively", () => {
    const winScratch = scratchLayout("/scratch/agent-sdk-abc", "win32")
    const env = buildIsolatedEnv({
      parentEnv: { Path: "C:\\bin", SystemRoot: "C:\\Windows", PATHEXT: ".EXE" },
      scratch: winScratch,
      platform: "win32",
    })
    expect(env.USERPROFILE).toBe(winScratch.home)
    expect(env.TEMP).toBe(winScratch.tmp)
    expect(env.TMP).toBe(winScratch.tmp)
    expect(env.APPDATA).toContain("AppData")
    expect(env.LOCALAPPDATA).toContain("AppData")
    expect(env.PATH).toBe("C:\\bin")
    expect(env.SystemRoot).toBe("C:\\Windows")
    expect(env.PATHEXT).toBe(".EXE")
    expect(winScratch.directories.some((dir) => dir.includes("AppData"))).toBe(true)
  })
})

describe("assertAuthContent", () => {
  test("accepts undefined and well-shaped records", () => {
    expect(() => assertAuthContent(undefined)).not.toThrow()
    expect(() => assertAuthContent({ anthropic: { type: "api", key: "sk" } } as never)).not.toThrow()
  })

  test("rejects non-records and entries without a string type", () => {
    expect(() => assertAuthContent([] as never)).toThrow(/record of provider credentials/)
    expect(() => assertAuthContent({ anthropic: "sk" } as never)).toThrow(/entry "anthropic"/)
    expect(() => assertAuthContent({ anthropic: { key: "sk" } } as never)).toThrow(/entry "anthropic"/)
  })
})
