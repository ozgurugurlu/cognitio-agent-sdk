import { sdkError } from "../errors.js"
import path from "node:path"
import type { AuthContent } from "../types.js"

/**
 * Pure helpers that compose the environment for a hermetic (`spawn.isolated`)
 * server. Nothing here touches the filesystem or process state — the transport
 * owns mkdtemp/mkdir/cleanup — so every rule is unit-testable, including the
 * win32 branch via the injectable `platform`.
 *
 * Error messages must reference env KEY NAMES only, never values.
 */

export interface ScratchLayout {
  home: string
  xdgConfig: string
  xdgData: string
  xdgCache: string
  xdgState: string
  tmp: string
  /** Directories the transport must create before spawning. */
  directories: string[]
}

export function scratchLayout(ownedScratch: string, platform: NodeJS.Platform = process.platform): ScratchLayout {
  const home = path.join(ownedScratch, "home")
  const layout = {
    home,
    xdgConfig: path.join(ownedScratch, "xdg", "config"),
    xdgData: path.join(ownedScratch, "xdg", "data"),
    xdgCache: path.join(ownedScratch, "xdg", "cache"),
    xdgState: path.join(ownedScratch, "xdg", "state"),
    tmp: path.join(ownedScratch, "tmp"),
  }
  const directories = [layout.home, layout.xdgConfig, layout.xdgData, layout.xdgCache, layout.xdgState, layout.tmp]
  if (platform === "win32") {
    directories.push(path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local"))
  }
  return { ...layout, directories }
}

const ALLOWLIST_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  // Provider credentials for the curated Phase 13 model completion surface.
  // Exact names are intentional: never replace this with a *_API_KEY rule.
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
  // Deliberately absent: GITHUB_TOKEN is general-purpose/write-capable and
  // COGNITIO_API_KEY would violate the no-ambient-COGNITIO_* invariant.
  // Ambient exception (documented in the README): proxies configure the
  // network fabric the child must run in, not persona/config state.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
])
const ALLOWLIST_PREFIX = ["GOOGLE_", "AWS_", "AZURE_", "OTEL_"]
const BASE_PASSTHROUGH = ["PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ"]
const BASE_PASSTHROUGH_WIN32 = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
const RESERVED = new Set([
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "APPDATA",
  "LOCALAPPDATA",
  "COGNITIO_ISOLATED",
  "COGNITIO_AUTH_CONTENT",
  "COGNITIO_CONFIG_CONTENT",
])

export function isReservedEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  // Windows env keys are case-insensitive, so a `home`/`Home` override would
  // otherwise slip past the scratch redirection.
  const normalized = platform === "win32" ? key.toUpperCase() : key
  const reserved = platform === "win32" ? WIN32_RESERVED : RESERVED
  return reserved.has(normalized) || normalized.startsWith("XDG_")
}

const WIN32_RESERVED = new Set(Array.from(RESERVED, (key) => key.toUpperCase()))

// Case-insensitive on win32 so a lowercase `cognitio_db` passEnv cannot leak a
// parent COGNITIO_* value into the hermetic child (win32 env keys are
// case-insensitive).
export function isCognitioEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalized = platform === "win32" ? key.toUpperCase() : key
  return normalized.startsWith("COGNITIO_")
}

/** Cheap client-side shape check; the server-side Auth schema decode is the authority. */
export function assertAuthContent(auth: AuthContent | undefined): void {
  if (auth === undefined) return
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
    throw sdkError("configuration", "spawn.auth must be a record of provider credentials")
  }
  for (const [key, value] of Object.entries(auth)) {
    if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
      throw sdkError("configuration", `spawn.auth entry "${key}" must be a credential object with a string "type"`)
    }
  }
  try {
    JSON.stringify(auth)
  } catch {
    throw sdkError("configuration", "spawn.auth must be JSON-serializable")
  }
}

export interface BuildIsolatedEnvInput {
  parentEnv: Record<string, string | undefined>
  scratch: ScratchLayout
  platform?: NodeJS.Platform
  passEnv?: string[]
  env?: Record<string, string>
  auth?: AuthContent
}

/**
 * Layer order (later wins): scratch redirection → base passthrough →
 * provider/telemetry allowlist → passEnv names → literal env overrides →
 * SDK-managed keys. Parent COGNITIO_* values never pass implicitly.
 */
export function buildIsolatedEnv(input: BuildIsolatedEnvInput): Record<string, string> {
  const platform = input.platform ?? process.platform
  const result: Record<string, string> = {}

  // 1. Scratch world.
  result.HOME = input.scratch.home
  result.XDG_CONFIG_HOME = input.scratch.xdgConfig
  result.XDG_DATA_HOME = input.scratch.xdgData
  result.XDG_CACHE_HOME = input.scratch.xdgCache
  result.XDG_STATE_HOME = input.scratch.xdgState
  result.TMPDIR = input.scratch.tmp
  if (platform === "win32") {
    result.USERPROFILE = input.scratch.home
    result.TEMP = input.scratch.tmp
    result.TMP = input.scratch.tmp
    result.APPDATA = path.join(input.scratch.home, "AppData", "Roaming")
    result.LOCALAPPDATA = path.join(input.scratch.home, "AppData", "Local")
  }

  // 2. Base passthrough (win32 env keys are case-insensitive).
  const read = (key: string) => {
    if (platform !== "win32") return input.parentEnv[key]
    const lower = key.toLowerCase()
    for (const [candidate, value] of Object.entries(input.parentEnv)) {
      if (candidate.toLowerCase() === lower) return value
    }
    return undefined
  }
  const base = [...BASE_PASSTHROUGH, ...(platform === "win32" ? BASE_PASSTHROUGH_WIN32 : [])]
  for (const key of base) {
    const value = read(key)
    if (value !== undefined) result[key] = value
  }
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value !== undefined && key.startsWith("LC_")) result[key] = value
  }

  // 3. Provider/telemetry allowlist.
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue
    const candidate = platform === "win32" ? key.toUpperCase() : key
    if (ALLOWLIST_EXACT.has(candidate) || ALLOWLIST_PREFIX.some((prefix) => candidate.startsWith(prefix))) {
      // Emit the canonical name, not the parent's spelling. On win32 the parent
      // may spell it `groq_api_key` while a later layer sets `GROQ_API_KEY`;
      // since Windows environment names are case-insensitive, emitting both
      // would leave which one the child reads undefined and break the
      // documented layer order (spawn.env wins over the allowlist).
      // Off win32 `candidate === key`, so nothing changes.
      result[candidate] = value
    }
  }

  // 4. Explicit passthrough by name. Reserved scratch keys and COGNITIO_*
  //    names are rejected here too — otherwise passEnv:["HOME"] would silently
  //    re-point the child at the host home and void state isolation.
  for (const key of input.passEnv ?? []) {
    if (isCognitioEnvKey(key, platform)) {
      throw sdkError(
        "configuration",
        `spawn.passEnv must not include ${key}; use spawn.env, spawn.auth, or spawn.config instead`,
      )
    }
    if (isReservedEnvKey(key, platform)) {
      throw sdkError("configuration", `spawn.passEnv must not include reserved key ${key}`)
    }
    // `read`, not a direct index: win32 environment names are case-insensitive,
    // so `passEnv: ["Path"]` must find a parent `PATH` exactly as step 2 does.
    // The requested spelling is what reaches the child.
    const value = read(key)
    if (value !== undefined) result[key] = value
  }

  // 5. Literal overrides; reserved keys are an explicit error, other
  //    COGNITIO_* keys (COGNITIO_DB, COGNITIO_MODELS_URL, ...) are allowed.
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (isReservedEnvKey(key, platform))
      throw sdkError("configuration", `spawn.env must not override reserved key ${key}`)
    result[key] = value
  }

  // 6. SDK-managed keys always win: the server must never fall back to a host
  //    auth.json, so COGNITIO_AUTH_CONTENT is always set.
  result.COGNITIO_ISOLATED = "1"
  result.COGNITIO_AUTH_CONTENT = JSON.stringify(input.auth ?? {})
  result.COGNITIO_DISABLE_AUTOUPDATE ??= "1"

  return result
}
