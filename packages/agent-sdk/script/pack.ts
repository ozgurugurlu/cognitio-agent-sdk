/**
 * Builds the publishable tarball for `cognitio-agent-sdk`.
 *
 * **Stages; never mutates the source manifest.** The pattern of writing
 * `package.json`, packing, then restoring it in a `finally` (as
 * `packages/sdk/js/script/publish.ts:43` does) is crash-unsafe: an interrupted
 * run leaves a rewritten manifest in the working tree.
 * `packages/runtime/script/publish.ts:39-56` already synthesizes its published
 * manifest from scratch, and that is the pattern followed here.
 *
 * The staged manifest differs from the committed one in four ways, each
 * deliberate:
 *
 * - `optionalDependencies` is added. It is **not** committed, because an
 *   unpublished optional dependency makes every developer's `bun install` print
 *   a 404 per platform and writes dangling entries into `bun.lock`. Verified
 *   empirically: `bun install` warns and exits 0.
 * - `devDependencies` is removed. A published tarball must never try to resolve
 *   a generator or a compiler.
 * - `scripts` is removed. `prepare: "tsc"` is what makes a git-URL install work
 *   and must stay committed, but a registry tarball ships prebuilt `dist/` and
 *   must not run `tsc` on the consumer's machine. This also matches Claude's
 *   SDK, which ships no `scripts` key at all.
 * - `files` gains `manifest.json`, the build-provenance sidecar.
 * - `private` is stripped; registry artifacts are public and prebuilt.

 */

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EXPECTED_SERVER_VERSION } from "../src/internal/runtime-client/runtime-version.js"
import { optionalDependenciesFor, STAGE_DIR } from "./build-server-binaries.js"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")
const repoDir = path.resolve(packageDir, "..", "..")

/**
 * Bun's dependency catalog, read from the root manifest.
 *
 * `packages/agent-sdk/package.json` declares `"zod": "catalog:"` and
 * `"cross-spawn": "catalog:"`, which is a **bun-only protocol**. npm rejects it
 * outright with `EUNSUPPORTEDPROTOCOL`, so a tarball carrying it is
 * uninstallable for exactly the consumers this phase exists to serve. Upstream
 * never hit this because `packages/runtime/script/publish.ts` synthesizes a
 * manifest with no dependencies at all and `bun pm pack` resolves catalogs
 * silently; resolving them explicitly here keeps the published manifest correct
 * no matter which packer runs.
 */
export function readCatalog(): Record<string, string> {
  const root = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf8")) as {
    workspaces?: { catalog?: Record<string, string> }
  }
  return root.workspaces?.catalog ?? {}
}

/** Replaces every `catalog:` specifier with the concrete version it points at. */
export function resolveSpecifiers(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
  field: string,
): Record<string, string> | undefined {
  if (!dependencies) return undefined
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, specifier]) => {
      if (specifier.startsWith("workspace:")) {
        // Nothing in agent-sdk should reference a workspace sibling any more —
        // removing that was the point of the phase. Fail loudly rather than
        // publish something that cannot install.
        throw new Error(`${field}.${name} is "${specifier}"; a published manifest cannot carry a workspace protocol`)
      }
      if (!specifier.startsWith("catalog:")) return [name, specifier]
      const named = specifier.slice("catalog:".length)
      if (named !== "") throw new Error(`${field}.${name} uses named catalog "${named}", which is not supported here`)
      const resolved = catalog[name]
      if (!resolved) throw new Error(`${field}.${name} is "catalog:" but the root catalog has no entry for ${name}`)
      return [name, resolved]
    }),
  )
}

/** The manifest actually published. Pure given a catalog, so `test/packaging.test.ts` can pin it. */
export function publishedManifest(
  committed: Record<string, unknown>,
  catalog: Record<string, string> = readCatalog(),
): Record<string, unknown> {
  const version = committed.version as string
  const { devDependencies: _dev, scripts: _scripts, private: _private, ...rest } = committed
  const dependencies = resolveSpecifiers(committed.dependencies as Record<string, string>, catalog, "dependencies")
  return {
    ...rest,
    ...(dependencies === undefined ? {} : { dependencies }),
    runtimeVersion: EXPECTED_SERVER_VERSION,
    files: [...new Set([...((committed.files as string[]) ?? []), "manifest.json"])],
    optionalDependencies: optionalDependenciesFor(version),
  }
}

export function readCommittedManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"))
}

/** Copies everything publishable into `dir` and writes the synthesized manifest. */
export function stagePackage(dir: string): { version: string; manifest: Record<string, unknown> } {
  const committed = readCommittedManifest()
  const manifest = publishedManifest(committed)
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(packageDir, "dist"), path.join(dir, "dist"), { recursive: true })
  for (const file of ["README.md", "CHANGELOG.md"]) {
    cpSync(path.join(packageDir, file), path.join(dir, file))
  }
  for (const file of ["LICENSE", "NOTICE"]) {
    const source = path.join(repoDir, file)
    if (!existsSync(source)) throw new Error(`${file} is required for public distribution`)
    cpSync(source, path.join(dir, file))
  }
  const buildManifest = path.join(STAGE_DIR, "manifest.json")
  if (existsSync(buildManifest)) cpSync(buildManifest, path.join(dir, "manifest.json"))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  return { version: committed.version as string, manifest }
}

/**
 * Packs `dir` into `destination` and returns the tarball path.
 *
 * The path comes from `npm pack --json`, never from a `*.tgz` glob: upstream's
 * `publish()` helper globs, which silently picks up a stale tarball.
 * `--ignore-scripts` because a staged tree has no scripts to run and must not
 * acquire any.
 */
export function packDirectory(dir: string, destination: string): string {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: dir,
    encoding: "utf8",
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm pack failed in ${dir}:\n${result.stderr}`)
  const parsed = JSON.parse(result.stdout) as Array<{ filename: string }>
  const filename = parsed[0]?.filename
  if (!filename) throw new Error(`npm pack produced no tarball in ${dir}`)
  return path.join(destination, filename)
}

function megabytes(file: string): string {
  return `${(readFileSync(file).byteLength / 1e6).toFixed(1)} MB`
}

/**
 * `pack` deletes its output directory recursively, so the caller does not get to
 * name an arbitrary one. Only somewhere strictly *under* this package or the OS
 * temp directory is accepted — never one of those roots itself, and never a
 * parent of them.
 */
export function isContained(destination: string, roots: string[] = [packageDir, os.tmpdir()]): boolean {
  const target = path.resolve(destination)
  return roots.some((root) => {
    const base = path.resolve(root)
    return target !== base && target.startsWith(base + path.sep)
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  const known = ["--skip-build", "--out"]
  const unknown = args.filter((arg) => !known.includes(arg) && !arg.startsWith("--out="))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  const outFlag = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  // `destination` is deleted recursively below, so it is validated first:
  // `--out=` (empty) resolves to the current directory and `--out=/` to the
  // filesystem root. An output directory must be a non-empty path that is not a
  // filesystem root.
  if (outFlag !== undefined && outFlag.trim() === "") throw new Error("--out must not be empty")
  const destination = outFlag ? path.resolve(outFlag) : path.join(packageDir, "dist-pack")
  // `destination` is deleted RECURSIVELY below, so containment is checked, not
  // just rootness. This is not hypothetical: `--out=..` deleted every package in
  // the monorepo during review — twice. `--out=.` would erase this package's
  // own `src/`.
  if (!isContained(destination)) {
    throw new Error(
      `--out must be inside ${packageDir} or ${os.tmpdir()} — refusing to recursively delete ${destination}`,
    )
  }

  if (!args.includes("--skip-build")) {
    // Drop the incremental state first. `tsconfig.json` sets `composite: true`,
    // so a stale `tsconfig.tsbuildinfo` makes tsc consider the build up to date
    // even when `dist/` has been deleted or partly removed by hand — it exits 0
    // and emits nothing. A published tarball must always contain a freshly
    // emitted dist, so the incremental cache is not trusted here.
    rmSync(path.join(packageDir, "tsconfig.tsbuildinfo"), { force: true })
    const build = spawnSync(process.execPath, ["run", "build"], { cwd: packageDir, stdio: "inherit" })
    if (build.status !== 0) throw new Error("bun run build failed")
  }
  if (!existsSync(path.join(packageDir, "dist"))) throw new Error("dist/ is missing — run `bun run build` first")

  rmSync(destination, { recursive: true, force: true })
  const staging = mkdtempSync(path.join(os.tmpdir(), "agent-sdk-pack-"))
  try {
    const { version, manifest } = stagePackage(staging)
    const tarball = packDirectory(staging, destination)
    console.log(`\ncognitio-agent-sdk@${version}`)
    console.log(`  tarball          ${path.relative(repoDir, tarball)}  (${megabytes(tarball)})`)
    console.log(`  runtimeVersion  ${manifest.runtimeVersion}`)
    console.log(`  optionalDeps     ${Object.keys(manifest.optionalDependencies as object).length} platform packages`)

    // Platform packages, when they have been staged.
    if (existsSync(STAGE_DIR)) {
      for (const name of Object.keys(manifest.optionalDependencies as Record<string, string>)) {
        const dir = path.join(STAGE_DIR, name)
        if (!existsSync(dir)) continue
        const platformTarball = packDirectory(dir, destination)
        console.log(`  ${name}  (${megabytes(platformTarball)})`)
      }
    } else {
      console.log(`  (no platform packages staged — run script/build-server-binaries.ts first)`)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
