/**
 * The single source of truth for the platform-binary matrix.
 *
 * Imported by the runtime resolver, the staging script, the publish script and
 * the pin test. Nothing else hardcodes a platform name, so P15's rename is a
 * one-line change to `PLATFORM_PACKAGE_SCOPE`.
 *
 * Two distinct names per target, because they come from different worlds:
 *
 * - `packageName` drives `require.resolve` and publication. It uses
 *   `process.platform` **verbatim** (`win32`, not `windows`) so the resolver
 *   needs no mapping table. `@anthropic-ai/claude-agent-sdk-win32-x64` is
 *   direct evidence this is safe; the `// changing to win32 flags npm for some
 *   reason` comment at `packages/runtime/script/build.ts:175` concerns the
 *   `os` *field*, which we emit as `win32` exactly as upstream does.
 * - `artifactName` is the directory `packages/runtime/script/build.ts` writes
 *   under `dist/`, which keeps upstream's `windows` spelling and its `baseline`
 *   segment. Staging only.
 *
 * **The x64 artifact is always the baseline build.** npm cannot select on CPU
 * capability, so shipping an AVX2-requiring binary as `…-linux-x64` would let a
 * pre-Haswell host install it and die with SIGILL — a silent crash that
 * documenting an env var does not fix. Using baseline as the single x64
 * artifact makes one package per tuple always work, and the performance cost is
 * immaterial for a process that spends its time waiting on LLM APIs. Two useful
 * consequences follow: **no AVX2 detection anywhere** (no `/proc/cpuinfo` read,
 * no `sysctl` or PowerShell subprocess like `packages/runtime/bin/cognitio`
 * needs), and **exactly one candidate per host**.
 *
 * **Strict libc, no cross-family fallback.** A musl host resolves the musl
 * package only, a glibc host the glibc package only. `packages/runtime/bin/cognitio`
 * does fall back across families, but both Linux variants always ship here, so
 * that path would be unreachable — and a "package not installed" error is a
 * better diagnostic than a dynamic-loader failure.
 */

/** P15 flips this line. */
export const PLATFORM_PACKAGE_SCOPE = ""
export const PLATFORM_PACKAGE_PREFIX = "cognitio-agent-sdk"

export type PlatformTarget = {
  /** Runtime resolution and publication. Uses `process.platform` verbatim. */
  packageName: string
  /** `packages/runtime/dist/<artifactName>` — staging only. */
  artifactName: string
  os: "darwin" | "linux" | "win32"
  arch: "arm64" | "x64"
  /** Linux only; never emitted for darwin or win32. */
  libc?: "glibc" | "musl"
}

/** Builds a platform package name. The one place scope and prefix are joined. */
export function platformPackageName(os: string, arch: string, libc?: "glibc" | "musl"): string {
  const suffix = libc === "musl" ? "-musl" : ""
  return `${PLATFORM_PACKAGE_SCOPE ? `${PLATFORM_PACKAGE_SCOPE}/` : ""}${PLATFORM_PACKAGE_PREFIX}-${os}-${arch}${suffix}`
}

function target(
  os: PlatformTarget["os"],
  arch: PlatformTarget["arch"],
  artifactName: string,
  libc?: "glibc" | "musl",
): PlatformTarget {
  return {
    packageName: platformPackageName(os, arch, libc),
    artifactName,
    os,
    arch,
    ...(libc === undefined ? {} : { libc }),
  }
}

/**
 * The eight published targets. Every `artifactName` exists in
 * `packages/runtime/script/build.ts`'s twelve-target list; `test/packaging.test.ts`
 * asserts that. There is no `linux-arm64-baseline` because AVX2 is x86-only.
 */
export const PLATFORM_TARGETS: readonly PlatformTarget[] = Object.freeze([
  target("darwin", "arm64", "cognitio-darwin-arm64"),
  target("darwin", "x64", "cognitio-darwin-x64-baseline"),
  target("linux", "arm64", "cognitio-linux-arm64", "glibc"),
  target("linux", "arm64", "cognitio-linux-arm64-musl", "musl"),
  target("linux", "x64", "cognitio-linux-x64-baseline", "glibc"),
  target("linux", "x64", "cognitio-linux-x64-baseline-musl", "musl"),
  target("win32", "arm64", "cognitio-windows-arm64"),
  target("win32", "x64", "cognitio-windows-x64-baseline"),
])

/** `cognitio.exe` on win32, `cognitio` everywhere else. */
export function serverBinaryFileName(os: string): "cognitio" | "cognitio.exe" {
  return os === "win32" ? "cognitio.exe" : "cognitio"
}

/**
 * The single platform package that could serve this host, or `undefined` on an
 * unsupported one. Singular by construction — see the baseline and strict-libc
 * notes above.
 */
export function platformCandidate(host: {
  platform: string
  arch: string
  libc?: "glibc" | "musl"
}): PlatformTarget | undefined {
  return PLATFORM_TARGETS.find(
    (candidate) =>
      candidate.os === host.platform &&
      candidate.arch === host.arch &&
      (candidate.os !== "linux" || candidate.libc === (host.libc ?? "glibc")),
  )
}
