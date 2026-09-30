import { sdkError } from "../../errors.js"
/**
 * Finds the cognitio server binary to spawn.
 *
 * Four steps, in order:
 *
 *   1. `binaryPath` — an explicit caller choice
 *   2. `COGNITIO_BIN_PATH` — this project's established override
 *      (`packages/runtime/bin/cognitio:20`)
 *   3. the bundled platform package, via `require.resolve`
 *   4. `PATH`, by handing the bare name `cognitio` to `cross-spawn`
 *
 * This is a deliberate superset of `@anthropic-ai/claude-agent-sdk`'s chain,
 * which has neither the env var nor the PATH step. Both are kept: dropping PATH
 * would be a silent breaking change for every consumer who installs the server
 * globally today, and it is how the repo's own tests inject a server.
 *
 * The whole module is pure and injectable — every filesystem and platform fact
 * arrives through `ResolveBinaryInput`, so all eight targets are unit-testable
 * from one machine. Claude's resolver takes the same shape (`W7($, X, J)` with
 * `process.*` defaults), which is the part of their design most worth copying.
 */

import { accessSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { platformCandidate, serverBinaryFileName, type PlatformTarget } from "./platform-packages.js"

export type BinarySource = "option" | "env" | "package" | "path"

export type ResolveBinaryInput = {
  /** Explicit binary path. A bare command name is rejected — see below. */
  binaryPath?: string
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Defaults to `process.platform`. */
  platform?: string
  /** Defaults to `process.arch`. */
  arch?: string
  /** Defaults to a memoized `detectLibc()`. Linux only. */
  libc?: "glibc" | "musl"
  /** Base for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /** Defaults to `createRequire(import.meta.url).resolve`, created lazily. */
  resolvePackage?: (specifier: string) => string
  exists?: (file: string) => boolean
  /** POSIX `X_OK`. Always true on win32, which has no execute bit. */
  isExecutable?: (file: string) => boolean
}

export type ResolvedServerBinary = {
  /** Either an absolute path, or the bare name `cognitio` for the PATH step. */
  command: string
  source: BinarySource
  /** The platform package that was tried. Undefined on an unsupported host. */
  candidate?: string
}

const ENV_OVERRIDE = "COGNITIO_BIN_PATH"

function defaultExists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function defaultIsExecutable(file: string): boolean {
  if (process.platform === "win32") return true
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedLibc: "glibc" | "musl" | undefined
let libcDetected = false

/**
 * Memoized at module scope — a `spawnSync` per `createAgentClient()` would be
 * wasteful, and the host's libc does not change mid-process.
 */
export function detectLibc(platform: string = process.platform): "glibc" | "musl" | undefined {
  if (platform !== "linux") return undefined
  if (libcDetected) return cachedLibc
  libcDetected = true
  cachedLibc = "glibc"
  try {
    if (defaultExists("/etc/alpine-release")) {
      cachedLibc = "musl"
      return cachedLibc
    }
  } catch {
    // fall through to the ldd probe
  }
  try {
    // glibc's `ldd --version` writes to stdout and exits 0; musl's writes to
    // stderr and exits non-zero. Both streams are inspected for that reason.
    const probe = spawnSync("ldd", ["--version"], { encoding: "utf8" })
    const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.toLowerCase()
    if (text.includes("musl")) cachedLibc = "musl"
  } catch {
    // an undetectable libc is treated as glibc, matching the common case
  }
  return cachedLibc
}

/** @internal test seam — the memo would otherwise leak between cases. */
export function resetLibcCache(): void {
  libcDetected = false
  cachedLibc = undefined
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\")
}

function resolveExplicit(
  value: string,
  label: string,
  source: BinarySource,
  input: Required<Pick<ResolveBinaryInput, "cwd" | "exists" | "isExecutable">>,
): ResolvedServerBinary {
  // A bare name here is ambiguous: it could mean "this file in cwd" or "look it
  // up on PATH". Rejecting it is better than silently picking one — the PATH
  // behaviour is already the documented fallback, reachable by not setting this
  // at all.
  if (!looksLikePath(value)) {
    throw sdkError(
      "binary",
      `${label} must be a path to the cognitio server binary, not the bare command name "${value}". ` +
        `Pass an absolute or relative path, or leave it unset to fall back to PATH.`,
    )
  }
  const resolved = path.resolve(input.cwd, value)
  if (!input.exists(resolved)) {
    throw sdkError("binary", `${label} points at ${resolved}, which does not exist.`)
  }
  if (!input.isExecutable(resolved)) {
    throw sdkError("binary", `${label} points at ${resolved}, which is not executable.`)
  }
  return { command: resolved, source }
}

/**
 * Only a genuine `MODULE_NOT_FOUND` counts as "not installed".
 *
 * Claude's resolver swallows every error (`for (…) try { return $(G) } catch {}`),
 * so a corrupt install, a bad `exports` map or an unreadable file all degrade
 * silently to the next step and surface as a misleading "reinstall without
 * --omit=optional". We propagate anything that is not a plain missing module.
 */
function isModuleNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "MODULE_NOT_FOUND"
}

let cachedRequire: ((specifier: string) => string) | undefined

function defaultResolvePackage(specifier: string): string {
  // Created lazily so importing this module stays cheap: `createRequire` is
  // only needed once the platform-package step is actually reached.
  cachedRequire ??= createRequire(import.meta.url).resolve
  return cachedRequire(specifier)
}

export function resolveServerBinary(input: ResolveBinaryInput = {}): ResolvedServerBinary {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const libc = input.libc ?? detectLibc(platform)
  const explicit = {
    cwd: input.cwd ?? process.cwd(),
    exists: input.exists ?? defaultExists,
    isExecutable: input.isExecutable ?? defaultIsExecutable,
  }
  const candidate: PlatformTarget | undefined = platformCandidate({ platform, arch, libc })

  // 1. An explicit path that does not work is a caller error, never a reason to
  //    fall through to something else.
  //
  //    No `candidate` is attached to an explicit result. It used to be, which
  //    made a spawn failure on a caller-supplied path report "the bundled
  //    platform package ... is not installed" — blaming a package the caller
  //    never asked for and had no reason to install.
  if (input.binaryPath !== undefined && input.binaryPath !== "") {
    return resolveExplicit(input.binaryPath, "spawn.binaryPath", "option", explicit)
  }

  // 2. Same treatment for the env override.
  const fromEnv = env[ENV_OVERRIDE]
  if (fromEnv !== undefined && fromEnv !== "") {
    return resolveExplicit(fromEnv, ENV_OVERRIDE, "env", explicit)
  }

  // 3. The bundled platform package. Resolving `package.json` rather than the
  //    binary subpath follows `packages/runtime/script/postinstall.mjs:57` and
  //    lets the pin test read the platform package's own version.
  if (candidate) {
    const resolvePackage = input.resolvePackage ?? defaultResolvePackage
    let manifest: string | undefined
    try {
      manifest = resolvePackage(`${candidate.packageName}/package.json`)
    } catch (error) {
      if (!isModuleNotFound(error)) throw error
    }
    if (manifest !== undefined) {
      const binary = path.join(path.dirname(manifest), "bin", serverBinaryFileName(candidate.os))
      if (explicit.exists(binary) && explicit.isExecutable(binary)) {
        return { command: binary, source: "package", candidate: candidate.packageName }
      }
      // Installed, resolvable, and yet unusable — a truncated download or a
      // dropped executable bit. Falling through to PATH would hide it behind a
      // "not installed" message about a package that plainly is.
      throw sdkError(
        "binary",
        `The platform package ${candidate.packageName} is installed but ${binary} is ` +
          `${explicit.exists(binary) ? "not executable" : "missing"}. Reinstall it, or pass spawn.binaryPath / ` +
          `set COGNITIO_BIN_PATH to a working server binary.`,
      )
    }
  }

  // 4. PATH. `cross-spawn` performs the lookup, including win32 PATHEXT and npm
  //    shims, so the bare name is handed over as-is — never suffixed with .exe.
  return { command: "cognitio", source: "path", ...withCandidate(candidate) }
}

function withCandidate(candidate: PlatformTarget | undefined) {
  return candidate ? { candidate: candidate.packageName } : {}
}

/**
 * The actionable failure text, in Claude's shape but naming our extra escapes.
 *
 * Never claims a resolved filesystem path when PATH did the lookup — we do not
 * know what, if anything, it found.
 */
export function describeMissingBinary(resolved: ResolvedServerBinary, platform: string, arch: string): string {
  const where =
    resolved.source === "path"
      ? `"${resolved.command}" was not found on PATH`
      : `${resolved.command} could not be executed`
  const bundled =
    resolved.source === "option" || resolved.source === "env"
      ? "This path was supplied explicitly, so no bundled platform package was consulted."
      : resolved.candidate
        ? `The bundled platform package ${resolved.candidate} is not installed.`
        : `There is no bundled platform package for ${platform}-${arch}.`
  return [
    `No cognitio server binary for ${platform}-${arch}: ${where}.`,
    bundled,
    "Install without --omit=optional, pass spawn.binaryPath, set COGNITIO_BIN_PATH, or put cognitio on PATH.",
  ].join(" ")
}
