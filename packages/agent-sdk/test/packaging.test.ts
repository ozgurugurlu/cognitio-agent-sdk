import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  checkGeneratedClient,
  describeComparison,
  GEN_DIR,
  isTreeInSync,
  PROVENANCE_FILE,
  renderProvenance,
  SPEC_PATH,
  STALE,
} from "../script/generate-client.js"
import { optionalDependenciesFor, platformManifest } from "../script/build-server-binaries.js"
import { isContained, publishedManifest, readCatalog, resolveSpecifiers } from "../script/pack.js"
import { distTag, parseArguments } from "../script/publish.js"
import { PLATFORM_TARGETS } from "../src/internal/runtime-client/platform-packages.js"
import { EXPECTED_SERVER_VERSION } from "../src/internal/runtime-client/runtime-version.js"

/**
 * Packaging invariants, as unit tests so they run wherever tests run.
 *
 * Nothing here packs, installs, or touches the network — that is
 * `script/verify-package.ts`. What lives here is everything that can be checked
 * from the committed tree in well under a second.
 */

const packageDir = path.resolve(import.meta.dir, "..")
const repoDir = path.resolve(packageDir, "..", "..")
const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as Record<string, any>

function walk(dir: string, prefix = ""): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

describe("no dependency on @cognitio/sdk", () => {
  test("src, test, and script contain no import specifier referencing it", () => {
    // Specifier-based, not text-based: the vendored files carry provenance
    // comments naming the package they were copied from, and a comment cannot
    // create a dependency. `script/verify-package.ts` applies the same rule to
    // the packed tarball.
    const offenders: string[] = []
    for (const root of ["src", "test", "script"]) {
      for (const relative of walk(path.join(packageDir, root))) {
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(relative)) continue
        const file = path.join(packageDir, root, relative)
        const source = readFileSync(file, "utf8")
        if (/(?:from|import|require)\s*\(?\s*["'][^"']*@cognitio\/sdk/.test(source)) {
          offenders.push(`${root}/${relative}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("no @cognitio/* entry survives in any dependency field", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const names = Object.keys(manifest[field] ?? {})
      expect(names.filter((name) => name.startsWith("@cognitio/"))).toEqual([])
    }
  })

  test("optionalDependencies stay out of the committed manifest", () => {
    // Committing them would emit one 404 per platform on every `bun install`
    // until P16 publishes them, and write dangling entries into bun.lock.
    // `script/pack.ts` synthesizes them at publish time instead.
    expect(manifest.optionalDependencies).toBeUndefined()
  })
})

describe("the vendored client tracks the committed spec", () => {
  test("the generated tree is current", async () => {
    const comparison = await checkGeneratedClient()
    // A boolean with the actionable message, not a 13k-line diff.
    expect(isTreeInSync(comparison), describeComparison(comparison)).toBe(true)
  }, 30000)

  test("the provenance sidecar pins the spec it was generated from", () => {
    const spec = readFileSync(SPEC_PATH, "utf8")
    const provenance = readFileSync(path.join(GEN_DIR, PROVENANCE_FILE), "utf8")
    expect(provenance, STALE).toBe(renderProvenance(spec))
    expect(JSON.parse(provenance).specSha256).toBe(createHash("sha256").update(spec).digest("hex"))
  })

  test("patchFlatRequiredParams survived: session.command requires arguments and command", () => {
    // A type-level assertion, so it fails at compile time if the textual patch
    // in generate-client.ts silently stops applying. The runtime body only
    // exists so the consts are used.
    const complete = {
      sessionID: "ses_1",
      command: "review",
      arguments: "--all",
    } satisfies { sessionID: string; command: string; arguments: string }

    // @ts-expect-error `arguments` is required after the patch
    const missingArguments: Parameters<CognitioClientCommand>[0] = { sessionID: "ses_1", command: "review" }
    // @ts-expect-error `command` is required after the patch
    const missingCommand: Parameters<CognitioClientCommand>[0] = { sessionID: "ses_1", arguments: "--all" }

    expect([complete, missingArguments, missingCommand]).toHaveLength(3)
  })
})

// Extracted so the two @ts-expect-error lines above read cleanly.
type CognitioClientCommand = InstanceType<
  typeof import("../src/internal/runtime-client/index.js").CognitioClient
>["session"]["command"]

describe("version pinning", () => {
  test("the server version is pinned identically in every place that states it", () => {
    // Five statements of the same fact, which is exactly why they are checked
    // together: the compiled constant, the committed manifest, what the staging
    // script stamps into COGNITIO_VERSION, what the published manifest carries,
    // and what the test fixture reports from /global/health.
    expect(manifest.runtimeVersion).toBe(EXPECTED_SERVER_VERSION)
    expect(publishedManifest(manifest).runtimeVersion).toBe(EXPECTED_SERVER_VERSION)

    const staging = readFileSync(path.join(packageDir, "script", "build-server-binaries.ts"), "utf8")
    expect(staging).toContain("COGNITIO_VERSION: EXPECTED_SERVER_VERSION")

    const fixture = readFileSync(path.join(packageDir, "test", "fixtures", "fake-cognitio-server.mjs"), "utf8")
    expect(fixture).toContain(`?? "${EXPECTED_SERVER_VERSION}"`)
  })

  test("the marker is build metadata so it cannot look like a downgrade", () => {
    const [base, build] = EXPECTED_SERVER_VERSION.split("+")
    expect(build).toBeTruthy()
    expect(base).not.toContain("-")
    // The server package it is paired with.
    const serverManifest = JSON.parse(
      readFileSync(path.join(repoDir, "packages", "runtime", "package.json"), "utf8"),
    ) as { version: string }
    expect(base).toBe(serverManifest.version)
  })

  test("the SDK is on the stable v2 line with the latest tag", () => {
    expect(manifest.version).toBe("2.0.0")
    expect(distTag(manifest.version)).toBe("latest")
    expect(distTag("2.0.0")).toBe("latest")
  })
})

describe("the publish pipeline's safety rails", () => {
  test("--dry-run always wins, even alongside --publish --yes", () => {
    // This flag was accepted and then ignored, so `--publish --yes --dry-run` —
    // someone adding a safety net to a command they were unsure about —
    // published for real and irreversibly. A flag whose entire purpose is to be
    // a safety net must never be the one that gets dropped.
    expect(parseArguments(["--publish", "--yes", "--dry-run"]).dryRun).toBe(true)
    expect(parseArguments(["--dry-run"]).dryRun).toBe(true)
    expect(parseArguments([]).dryRun).toBe(true)
    expect(parseArguments(["--publish", "--yes"]).dryRun).toBe(false)
  })

  test("publishing for real needs two explicit flags, and rejects anything unknown", () => {
    expect(() => parseArguments(["--publish"])).toThrow(/requires an explicit --yes/)
    expect(() => parseArguments(["--force"])).toThrow(/Unknown argument: --force/)
  })

  test("the main package is staged before any platform package is published", () => {
    // stagePackage() throws on a missing dist/, a missing README, or an
    // unresolvable catalog: specifier. It used to run after the eight platform
    // packages were already on the registry, leaving a half-published release
    // that can never be completed at that version.
    const source = readFileSync(path.join(packageDir, "script", "publish.ts"), "utf8")
    const staged = source.indexOf("stagePackage(staging)")
    const publishesPlatform = source.indexOf("publishDir(dir, target.packageName")
    const publishesMain = source.indexOf('publishDir(staging, "cognitio-agent-sdk"')
    expect(staged).toBeGreaterThan(0)
    expect(staged).toBeLessThan(publishesPlatform)
    expect(publishesPlatform).toBeLessThan(publishesMain)
  })
})

describe("pack's output directory is contained", () => {
  test("refuses anything that is not strictly inside the package or the temp dir", () => {
    // `pack` deletes this path recursively. `--out=..` really did delete every
    // package in the monorepo during review, twice, so this is a regression
    // test for something that happened rather than something imagined.
    const packageDir = path.resolve(import.meta.dir, "..")
    expect(isContained(path.join(packageDir, "dist-pack"))).toBe(true)
    expect(isContained(path.join(os.tmpdir(), "whatever"))).toBe(true)

    expect(isContained(path.resolve(packageDir, ".."))).toBe(false)
    expect(isContained(packageDir)).toBe(false)
    expect(isContained(os.tmpdir())).toBe(false)
    expect(isContained(path.parse(packageDir).root)).toBe(false)
    expect(isContained(path.resolve(packageDir, "..", "..", "src"))).toBe(false)
    // A sibling whose name merely starts with the package dir's name must not
    // pass a naive prefix check.
    expect(isContained(`${packageDir}-evil`)).toBe(false)
  })
})

describe("the platform matrix", () => {
  test("eight unique packages, every artifact real, libc on Linux only", () => {
    expect(PLATFORM_TARGETS).toHaveLength(8)
    expect(new Set(PLATFORM_TARGETS.map((target) => target.packageName)).size).toBe(8)
    expect(new Set(PLATFORM_TARGETS.map((target) => target.artifactName)).size).toBe(8)

    // Every artifactName must exist in the builder's own target list, or
    // staging fails at the very end of a multi-minute cross-build.
    const builder = readFileSync(path.join(repoDir, "packages", "runtime", "script", "build.ts"), "utf8")
    const built = new Set<string>()
    for (const match of builder.matchAll(
      /os:\s*"(\w+)",\s*\n\s*arch:\s*"(\w+)",?\s*\n?(?:\s*abi:\s*"(\w+)",?\s*\n?)?(?:\s*avx2:\s*(false),?\s*\n?)?/g,
    )) {
      const [, os, arch, abi, avx2] = match
      const name = ["cognitio", os === "win32" ? "windows" : os, arch, avx2 === "false" ? "baseline" : undefined, abi]
        .filter(Boolean)
        .join("-")
      built.add(name)
    }
    expect(built.size).toBeGreaterThanOrEqual(8)
    for (const target of PLATFORM_TARGETS) {
      expect(built.has(target.artifactName), `${target.artifactName} is not a build.ts target`).toBe(true)
    }

    for (const target of PLATFORM_TARGETS) {
      if (target.os === "linux") expect(target.libc).toBeDefined()
      else expect(target.libc).toBeUndefined()
      // Baseline is an artifact-selection concept and must never leak into a
      // package name — npm cannot select on CPU capability.
      expect(target.packageName).not.toContain("baseline")
      // x64 always ships the baseline artifact, or a pre-Haswell host SIGILLs.
      if (target.arch === "x64") expect(target.artifactName).toContain("baseline")
    }
  })

  test("the published manifest maps every target to the exact SDK version", () => {
    const published = publishedManifest(manifest)
    const optional = published.optionalDependencies as Record<string, string>
    expect(Object.keys(optional).sort()).toEqual(PLATFORM_TARGETS.map((t) => t.packageName).sort())
    for (const pinned of Object.values(optional)) expect(pinned).toBe(manifest.version)
    expect(optionalDependenciesFor("9.9.9")["cognitio-agent-sdk-darwin-arm64"]).toBe("9.9.9")
  })

  test("platform manifests are inert payloads with no scripts and no exports", () => {
    for (const target of PLATFORM_TARGETS) {
      const platform = platformManifest(target, "2.0.0-beta.1") as Record<string, unknown>
      expect(platform.scripts).toBeUndefined()
      // Deep-path require.resolve depends on the absence of an exports map.
      expect(platform.exports).toBeUndefined()
      expect(platform.bin).toBeUndefined()
      expect(platform.main).toBeUndefined()
      expect(platform.os).toEqual([target.os])
      expect(platform.cpu).toEqual([target.arch])
    }
  })
})

describe("the published manifest", () => {
  test("no bun-only specifier survives into the tarball", () => {
    // `catalog:` is a bun protocol. npm rejects it with EUNSUPPORTEDPROTOCOL,
    // which makes a tarball carrying it uninstallable for exactly the consumers
    // this phase exists to serve. Found by running `verify:package`, not by
    // reading the manifest.
    const published = publishedManifest(manifest)
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [name, specifier] of Object.entries((published[field] ?? {}) as Record<string, string>)) {
        expect(specifier.startsWith("catalog:"), `${field}.${name} is still ${specifier}`).toBe(false)
        expect(specifier.startsWith("workspace:"), `${field}.${name} is still ${specifier}`).toBe(false)
      }
    }
    // And the committed manifest still uses the catalog, so the workspace keeps
    // one version per dependency.
    expect(manifest.dependencies["cross-spawn"]).toBe("catalog:")
    expect((published.dependencies as Record<string, string>)["cross-spawn"]).toBe(readCatalog()["cross-spawn"])
  })

  test("an unresolvable specifier fails loudly rather than shipping", () => {
    expect(() => resolveSpecifiers({ zod: "catalog:" }, {}, "dependencies")).toThrow(
      /the root catalog has no entry for zod/,
    )
    expect(() => resolveSpecifiers({ sibling: "workspace:*" }, {}, "dependencies")).toThrow(
      /cannot carry a workspace protocol/,
    )
    expect(() => resolveSpecifiers({ zod: "catalog:strict" }, {}, "dependencies")).toThrow(/named catalog "strict"/)
  })

  test("public publication is explicit and raw publishing cannot bypass staging", () => {
    expect(manifest.private).toBe(false)
    expect(manifest.scripts.prepublishOnly).toContain("release:publish")
    expect(publishedManifest(manifest).private).toBeUndefined()
    expect(manifest.publishConfig.access).toBe("public")
  })

  test("drops scripts and devDependencies, keeps prepare committed", () => {
    const published = publishedManifest(manifest)
    // A registry tarball ships prebuilt dist/ and must never run tsc.
    expect(published.scripts).toBeUndefined()
    expect(published.devDependencies).toBeUndefined()
    // But the committed manifest keeps `prepare`, which is what makes a
    // git-URL install build itself.
    expect(manifest.scripts.prepare).toBe("tsc")
    expect(published.files).toContain("manifest.json")
    expect(Object.keys(published.dependencies as object)).toEqual(Object.keys(manifest.dependencies))
    expect(published.engines).toEqual({ node: ">=22" })
  })
})

describe("prettier stability of the vendored tree", () => {
  test("every generated file is non-empty and .provenance.json is the only non-ts file", () => {
    const files = walk(GEN_DIR).sort()
    expect(files.filter((file) => !file.endsWith(".ts"))).toEqual([PROVENANCE_FILE])
    for (const file of files) expect(statSync(path.join(GEN_DIR, file)).size).toBeGreaterThan(0)
  })
})
