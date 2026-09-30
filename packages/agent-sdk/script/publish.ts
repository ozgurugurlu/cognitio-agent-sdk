/**
 * Publishes `cognitio-agent-sdk` and its eight platform packages.
 *
 * **`--dry-run` is the default.** Phase 14 builds and verifies this pipeline;
 * Phase 16 owns the first real publish. Nothing here can reach a registry
 * without both `--publish` and `--yes`, and `packages/agent-sdk` is
 * deliberately absent from the repo's own `script/publish.ts` orchestration, so
 * no existing pipeline can invoke it.
 *
 * Ordering matters: platform packages publish **first**, the main package
 * **last**. Its `optionalDependencies` are exact pins, so a consumer installing
 * in between would get a main package whose optional deps 404 — and because npm
 * treats an optional-dependency failure as non-fatal, that produces a silently
 * broken install rather than a loud one. Same rule as
 * `packages/runtime/script/publish.ts:58-62`.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLATFORM_TARGETS,
  platformCandidate,
  serverBinaryFileName,
} from "../src/internal/runtime-client/platform-packages.js"
import { detectLibc } from "../src/internal/runtime-client/resolve-binary.js"
import { EXPECTED_SERVER_VERSION } from "../src/internal/runtime-client/runtime-version.js"
import { optionalDependenciesFor, platformManifest, STAGE_DIR } from "./build-server-binaries.js"
import { packDirectory, readCommittedManifest, stagePackage } from "./pack.js"
import { provenanceProblems, sourceProvenance } from "./provenance.js"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")

export interface Problem {
  where: string
  detail: string
}

/**
 * Everything that can be wrong, found before anything is published.
 *
 * A half-published release is the failure mode worth engineering against: the
 * main package pins exact versions, so a missing platform package is not
 * recoverable by a consumer.
 */
export function validateStaging(version: string, stageDir = STAGE_DIR): Problem[] {
  const problems: Problem[] = []
  const manifestPath = path.join(stageDir, "manifest.json")
  if (!existsSync(manifestPath)) {
    return [{ where: "dist-binaries", detail: "manifest.json is missing — run script/build-server-binaries.ts" }]
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    sdkVersion: string
    serverVersion: string
    platforms: Record<string, { binary: string; size: number; sha256: string }>
  }
  if (manifest.sdkVersion !== version) {
    problems.push({ where: "manifest.json", detail: `sdkVersion ${manifest.sdkVersion} != package.json ${version}` })
  }
  if (manifest.serverVersion !== EXPECTED_SERVER_VERSION) {
    problems.push({
      where: "manifest.json",
      detail: `serverVersion ${manifest.serverVersion} != EXPECTED_SERVER_VERSION ${EXPECTED_SERVER_VERSION}`,
    })
  }
  for (const target of PLATFORM_TARGETS) {
    const dir = path.join(stageDir, target.packageName)
    if (!existsSync(dir)) {
      problems.push({ where: target.packageName, detail: "not staged" })
      continue
    }
    if (!existsSync(path.join(dir, "package.json"))) {
      problems.push({ where: target.packageName, detail: "package.json is missing" })
      continue
    }
    for (const file of ["LICENSE", "NOTICE"]) {
      if (!existsSync(path.join(dir, file))) problems.push({ where: target.packageName, detail: `${file} is missing` })
    }
    const staged = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    const expected = platformManifest(target, version)
    if (JSON.stringify(staged) !== JSON.stringify(expected)) {
      problems.push({ where: target.packageName, detail: "package.json does not match platformManifest()" })
    }
    const binary = path.join(dir, "bin", serverBinaryFileName(target.os))
    if (!existsSync(binary)) {
      problems.push({ where: target.packageName, detail: `missing bin/${serverBinaryFileName(target.os)}` })
      continue
    }
    const stat = statSync(binary)
    if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
      problems.push({ where: target.packageName, detail: "binary is not executable" })
    }
    const recorded = manifest.platforms?.[target.packageName]
    if (!recorded) {
      problems.push({ where: target.packageName, detail: "absent from manifest.json" })
      continue
    }
    if (recorded.size !== stat.size) {
      problems.push({ where: target.packageName, detail: `size ${stat.size} != manifest ${recorded.size}` })
    }
    const digest = createHash("sha256").update(readFileSync(binary)).digest("hex")
    if (digest !== recorded.sha256) {
      problems.push({ where: target.packageName, detail: "sha256 does not match manifest.json" })
    }
  }
  return problems
}

/**
 * Provenance the size/sha256 checks cannot give.
 *
 * `validateStaging` compares each binary against the manifest written next to
 * it, so it proves the staged tree is internally consistent and nothing more: a
 * stale artifact re-staged with `--skip-build` passes it while carrying a
 * different runtime entirely. These checks look outside the manifest — the host
 * binary is actually executed, and the manifest's commit is compared against the
 * tree being published.
 *
 * Honesty boundary: only the **host's** binary can be run here. The other seven
 * are cross-built and covered by name, size and checksum alone; that is not the
 * same as knowing they work.
 */
export function checkProvenance(stageDir = STAGE_DIR, repoDir = path.resolve(packageDir, "..", "..")): Problem[] {
  const manifestPath = path.join(stageDir, "manifest.json")
  if (!existsSync(manifestPath)) return [{ where: "manifest.json", detail: "release provenance is missing" }]
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    commit?: string
    sourceClean?: boolean
    compiled?: boolean
  }
  const problems = provenanceProblems(manifest, sourceProvenance(repoDir)).map((detail) => ({
    where: "manifest.json",
    detail,
  }))
  const host = platformCandidate({
    platform: process.platform,
    arch: process.arch,
    ...(detectLibc() === undefined ? {} : { libc: detectLibc()! }),
  })
  if (!host) return [...problems, { where: "host", detail: "this host has no supported runtime target" }]
  const binary = path.join(stageDir, host.packageName, "bin", serverBinaryFileName(host.os))
  if (!existsSync(binary)) return [...problems, { where: host.packageName, detail: "host binary is missing" }]
  const reported = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30000 })
  const actual = reported.stdout?.trim()
  if (reported.status !== 0 || actual !== EXPECTED_SERVER_VERSION) {
    problems.push({
      where: host.packageName,
      detail: `the staged binary reports ${JSON.stringify(actual)}, not ${JSON.stringify(EXPECTED_SERVER_VERSION)}`,
    })
  }
  return problems
}

/** `npm view` idempotency probe, after `packages/runtime/script/publish.ts:10-12`. */
function alreadyPublished(dir: string, name: string, version: string): boolean {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "dist.integrity", "--json", "--registry", "https://registry.npmjs.org/"],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    if (/E404|404 Not Found/.test(result.stderr + result.stdout)) return false
    throw new Error(`Cannot check registry state for ${name}@${version}; refusing a partial release`)
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cognitio-integrity-"))
  try {
    const tarball = packDirectory(dir, temporary)
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`
    if (JSON.parse(result.stdout) !== integrity) {
      throw new Error(`${name}@${version} already exists with different contents; choose a new release version`)
    }
    return true
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Prerelease versions must not take the `latest` tag. */
export function distTag(version: string): string {
  if (!version.includes("-")) return "latest"
  const label = version.split("-")[1]!.split(".")[0]!
  return label
}

function publishDir(
  dir: string,
  name: string,
  version: string,
  options: { dryRun: boolean; tag: string; existing?: boolean },
): void {
  if (options.existing) {
    console.log(`already published ${name}@${version}`)
    return
  }
  const args = ["publish", "--access", "public", "--tag", options.tag, "--ignore-scripts"]
  if (options.dryRun) args.push("--dry-run")
  const result = spawnSync("npm", args, { cwd: dir, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`npm publish failed for ${name}@${version}`)
}

export function parseArguments(args: string[]) {
  const meaningful = args.filter((arg) => arg !== "--")
  const known = ["--publish", "--yes", "--dry-run"]
  const unknown = meaningful.filter((arg) => !known.includes(arg))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  const wantsPublish = meaningful.includes("--publish")
  if (wantsPublish && !meaningful.includes("--yes")) {
    throw new Error("--publish requires an explicit --yes. Phase 16 owns the first real publish.")
  }
  // `--dry-run` ALWAYS wins. It was previously accepted and then ignored, so
  // `--publish --yes --dry-run` — someone adding a safety flag to a command
  // they were unsure about — published for real, irreversibly. A flag whose
  // entire purpose is to be a safety net must never be the one that is dropped.
  return { dryRun: !wantsPublish || meaningful.includes("--dry-run") }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const committed = readCommittedManifest()
  const version = committed.version as string
  const tag = distTag(version)

  console.log(`=== cognitio-agent-sdk@${version} (${options.dryRun ? "dry run" : "PUBLISH"}, tag ${tag}) ===\n`)

  const problems = [...validateStaging(version), ...checkProvenance()]
  if (problems.length) {
    for (const problem of problems) console.error(`  ${problem.where}: ${problem.detail}`)
    throw new Error(`${problems.length} problem(s) — release preflight failed; nothing was published`)
  }
  console.log(`validated ${PLATFORM_TARGETS.length} staged platform packages\n`)

  console.log("optionalDependencies that will be published:")
  for (const [name, pinned] of Object.entries(optionalDependenciesFor(version))) {
    console.log(`  "${name}": "${pinned}"`)
  }
  console.log()

  // Stage the main package BEFORE publishing anything. `stagePackage()` throws
  // on a missing `dist/`, a missing README, or an unresolvable `catalog:`
  // specifier — and it used to run *after* the eight platform packages were
  // already on the registry, leaving a half-published release whose main
  // package can never be completed at that version.
  // Build `dist/` here rather than trusting whatever is on disk. `validateStaging()`
  // scrutinises `dist-binaries` down to per-target sha256s but never looked at
  // `dist/` at all, so a stale build could be published silently. The incremental
  // cache is dropped first for the reason script/pack.ts documents.
  rmSync(path.join(packageDir, "tsconfig.tsbuildinfo"), { force: true })
  const build = spawnSync(process.execPath, ["run", "build"], { cwd: packageDir, stdio: "inherit" })
  if (build.status !== 0) throw new Error("bun run build failed")
  if (!existsSync(path.join(packageDir, "dist"))) throw new Error("dist/ is missing after a successful build")
  const staging = mkdtempSync(path.join(os.tmpdir(), "agent-sdk-publish-"))
  try {
    stagePackage(staging)
    const verification = spawnSync(
      process.execPath,
      [path.join(scriptDir, "verify-package.ts"), "--skip-build", "--require-platform"],
      {
        cwd: packageDir,
        stdio: "inherit",
      },
    )
    if (verification.status !== 0) throw new Error("Release package verification failed; nothing was published")
    if (!options.dryRun) {
      const auth = spawnSync("npm", ["whoami", "--registry", "https://registry.npmjs.org/"], { encoding: "utf8" })
      if (auth.status !== 0)
        throw new Error("npm authentication is required before publishing any package: run npm login")
    }
    const recheck = [...validateStaging(version), ...checkProvenance()]
    if (recheck.length)
      throw new Error("Release source or artifacts changed during verification; rebuild before publishing")
    // Check every immutable registry version before uploading the first package.
    // A collision on the ninth package must not leave eight new versions behind.
    const existing = new Set(
      options.dryRun
        ? []
        : [
            ...PLATFORM_TARGETS.map((target) => ({
              name: target.packageName,
              dir: path.join(STAGE_DIR, target.packageName),
            })),
            { name: "cognitio-agent-sdk", dir: staging },
          ]
            .filter((entry) => alreadyPublished(entry.dir, entry.name, version))
            .map((entry) => entry.name),
    )

    // Platform packages first, main package last — see the header.
    for (const target of PLATFORM_TARGETS) {
      const dir = path.join(STAGE_DIR, target.packageName)
      if (!existsSync(dir)) throw new Error(`${target.packageName} disappeared after release preflight`)
      publishDir(dir, target.packageName, version, { ...options, tag, existing: existing.has(target.packageName) })
    }

    if (options.dryRun) {
      // Prove the tarball is producible and show its contents, without a registry.
      const out = mkdtempSync(path.join(os.tmpdir(), "agent-sdk-publish-tgz-"))
      try {
        console.log(`\npacked main tarball: ${packDirectory(staging, out)}`)
      } finally {
        rmSync(out, { recursive: true, force: true })
      }
    }
    publishDir(staging, "cognitio-agent-sdk", version, {
      ...options,
      tag,
      existing: existing.has("cognitio-agent-sdk"),
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  console.log(`\n${options.dryRun ? "dry run complete — nothing was published" : "published"}`)
}

if (import.meta.main) await main()
