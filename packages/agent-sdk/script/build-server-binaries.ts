/**
 * Stages the platform binary packages this SDK ships as `optionalDependencies`.
 *
 * A thin wrapper, deliberately: `packages/runtime/script/build.ts` remains the
 * single builder of cognitio binaries. This script invokes it with a pinned
 * version, then copies the artifacts it cares about into
 * `packages/agent-sdk/dist-binaries/<packageName>/` with manifests of our own.
 *
 * Two things it must get right, both measured rather than assumed:
 *
 * - **`COGNITIO_VERSION` is mandatory.** Left unset, `@cognitio/script`
 *   derives the version from the current git branch
 *   (`packages/script/src/index.ts:36`), producing strings like
 *   `0.0.0-phase/14-self-contained-packaging-202608191100` — with a `/`, which
 *   npm rejects. The existing `packages/runtime/dist/` on this machine carries
 *   exactly such a version, which is how the hazard was found.
 * - **Never build through turbo.** `turbo.json`'s `build` task caches
 *   `dist/**` on inputs that do not include `COGNITIO_VERSION`, so a cached
 *   build would silently ship a differently-stamped binary.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLATFORM_TARGETS,
  platformCandidate,
  serverBinaryFileName,
  type PlatformTarget,
} from "../src/internal/runtime-client/platform-packages.js"
import { detectLibc } from "../src/internal/runtime-client/resolve-binary.js"
import { sourceProvenance } from "./provenance.js"
import { EXPECTED_SERVER_VERSION } from "../src/internal/runtime-client/runtime-version.js"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_DIR = path.resolve(scriptDir, "..")
const repoDir = path.resolve(PACKAGE_DIR, "..", "..")
const serverDir = path.join(repoDir, "packages", "runtime")
export const STAGE_DIR = path.join(PACKAGE_DIR, "dist-binaries")

export function sdkVersion(): string {
  return JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")).version as string
}

/**
 * The published manifest for one platform package.
 *
 * Modeled on `@anthropic-ai/claude-agent-sdk`'s, with one improvement: `libc`
 * is emitted for Linux targets. Upstream omits it, so a Linux user downloads
 * both the glibc and musl variants. npm >= 9.6.5 honours it; older npm and
 * possibly bun ignore it, which is harmless because the runtime resolver picks
 * correctly either way. It is a Linux-only field and is never emitted for
 * darwin or win32.
 *
 * No `bin`, no `main`, no `exports`, and above all **no `scripts`**: a platform
 * package is an inert payload. Adding an `exports` map without an explicit
 * entry for the binary would break deep-path resolution.
 */
export function platformManifest(target: PlatformTarget, version: string) {
  return {
    name: target.packageName,
    version,
    description: `cognitio server binary for cognitio-agent-sdk on ${target.os}-${target.arch}${target.libc === "musl" ? " (musl)" : ""}`,
    os: [target.os],
    cpu: [target.arch],
    ...(target.libc === undefined ? {} : { libc: [target.libc] }),
    files: ["bin", "LICENSE", "NOTICE"],
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    license: "MIT",
  }
}

/** Exact pins, as Claude does — this is what makes a runtime version check unnecessary at install time. */
export function optionalDependenciesFor(version: string): Record<string, string> {
  return Object.fromEntries(PLATFORM_TARGETS.map((target) => [target.packageName, version]))
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function runServerBuild(flags: string[]): void {
  console.log(`building server binaries with COGNITIO_VERSION=${EXPECTED_SERVER_VERSION}`)
  const result = spawnSync(process.execPath, [path.join("script", "build.ts"), ...flags], {
    cwd: serverDir,
    stdio: "inherit",
    env: {
      ...process.env,
      // Mandatory. See the header.
      COGNITIO_VERSION: EXPECTED_SERVER_VERSION,
      // Without this the channel is derived from the branch name.
      COGNITIO_CHANNEL: "latest",
      MODELS_DEV_API_JSON: path.join(serverDir, "script", "models-catalog.json"),
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`packages/runtime/script/build.ts exited with code ${result.status}`)
}

function stage(targets: readonly PlatformTarget[], version: string) {
  const platforms: Record<string, { binary: string; size: number; sha256: string }> = {}
  for (const target of targets) {
    const source = path.join(serverDir, "dist", target.artifactName, "bin", serverBinaryFileName(target.os))
    if (!existsSync(source)) {
      throw new Error(
        `missing built artifact ${path.relative(repoDir, source)} — ` +
          `run without --single, or check that packages/runtime/script/build.ts produced ${target.artifactName}`,
      )
    }
    const outDir = path.join(STAGE_DIR, target.packageName)
    const binName = serverBinaryFileName(target.os)
    mkdirSync(path.join(outDir, "bin"), { recursive: true })
    const destination = path.join(outDir, "bin", binName)
    copyFileSync(source, destination)
    // `packages/runtime/script/publish.ts:17` exists because artifact
    // downloads drop the executable bit. `copyFileSync` preserves it here, but
    // set it explicitly so a staged tree is correct however it was produced.
    if (process.platform !== "win32") chmodSync(destination, 0o755)
    writeFileSync(path.join(outDir, "package.json"), JSON.stringify(platformManifest(target, version), null, 2) + "\n")
    for (const file of ["LICENSE", "NOTICE"]) {
      const source = path.join(repoDir, file)
      if (!existsSync(source)) throw new Error(`${file} is required for public distribution`)
      copyFileSync(source, path.join(outDir, file))
    }
    platforms[target.packageName] = {
      binary: binName,
      size: statSync(destination).size,
      sha256: sha256File(destination),
    }
    console.log(`staged ${target.packageName} (${(platforms[target.packageName]!.size / 1e6).toFixed(0)} MB)`)
  }
  return platforms
}

function parseArguments(args: string[]) {
  const meaningful = args.filter((arg) => arg !== "--")
  const known = ["--single", "--skip-install", "--skip-embed-web-ui", "--skip-build"]
  const unknown = meaningful.filter((arg) => !known.includes(arg))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  return {
    single: meaningful.includes("--single"),
    skipInstall: meaningful.includes("--skip-install"),
    // The SDK never serves the web UI (`packages/runtime/src/server/routes/ui.ts`
    // guards the import), and skipping it also skips a full `packages/app` build.
    skipEmbedWebUi: true,
    skipBuild: meaningful.includes("--skip-build"),
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const version = sdkVersion()
  const provenance = sourceProvenance(repoDir)

  // libc matters: without it a musl host resolves the glibc package and would
  // stage or verify the wrong artifact entirely.
  const host = platformCandidate({
    platform: process.platform,
    arch: process.arch,
    ...(detectLibc() === undefined ? {} : { libc: detectLibc()! }),
  })
  const targets = args.single ? (host ? [host] : []) : PLATFORM_TARGETS
  if (args.single && targets.length === 0) {
    throw new Error(`--single: no platform package is defined for ${process.platform}-${process.arch}`)
  }
  // `packages/runtime/script/build.ts` only builds a baseline artifact when
  // `--baseline` accompanies `--single`, and this package always ships the
  // baseline artifact for x64 — so forward the flag rather than producing the
  // wrong artifact and failing minutes later in staging. Its own comment warns
  // these downloads "can be flaky"; that is why it is opt-in upstream.
  const needsBaseline = args.single && host?.artifactName.includes("baseline") === true
  if (needsBaseline) {
    console.log(`--single on ${process.platform}-${process.arch}: forwarding --baseline for ${host!.artifactName}`)
  }

  if (!args.skipBuild) {
    if (!args.skipInstall) {
      const install = spawnSync(process.execPath, ["install", "--frozen-lockfile", "--os=*", "--cpu=*"], {
        cwd: repoDir,
        stdio: "inherit",
      })
      if (install.status !== 0) throw new Error("Installing the locked cross-platform build dependencies failed")
    }
    runServerBuild([
      ...(args.single ? ["--single"] : []),
      ...(needsBaseline ? ["--baseline"] : []),
      ...(args.single && host?.libc === "musl" ? ["--libc=musl"] : []),
      // The canonical root install above must not be replaced by `bun add`
      // calls inside the runtime builder, which can rewrite release inputs.
      "--skip-install",
      ...(args.skipEmbedWebUi ? ["--skip-embed-web-ui"] : []),
    ])
  }

  rmSync(STAGE_DIR, { recursive: true, force: true })
  mkdirSync(STAGE_DIR, { recursive: true })
  const platforms = stage(targets, version)

  writeFileSync(
    path.join(STAGE_DIR, "manifest.json"),
    // No build date: the manifest must stay byte-reproducible for a given
    // commit, the way the generated client and the models snapshot do.
    JSON.stringify(
      {
        sdkVersion: version,
        serverVersion: EXPECTED_SERVER_VERSION,
        commit: provenance.commit,
        sourceClean: provenance.clean && sourceProvenance(repoDir).clean,
        compiled: !args.skipBuild,
        platforms,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(`\nstaged ${Object.keys(platforms).length}/${PLATFORM_TARGETS.length} platform packages in dist-binaries`)
}

if (import.meta.main) await main()
