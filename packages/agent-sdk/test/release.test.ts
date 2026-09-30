import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { exportSource, isPublicPath } from "../script/export-source.js"
import { provenanceProblems, sourceProvenance } from "../script/provenance.js"
import { validateStaging } from "../script/publish.js"

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function repository() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cognitio-release-test-"))
  temporary.push(directory)
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  git("init")
  git("config", "user.name", "Release Test")
  git("config", "user.email", "release-test@example.invalid")
  writeFileSync(path.join(directory, "package.json"), "{}\n")
  git("add", ".")
  git("commit", "-m", "initial")
  return { directory, git }
}

describe("release provenance", () => {
  test("rejects missing, dirty, stale, and restaged source records", () => {
    const current = { commit: "release-commit", clean: true }
    const valid = { commit: current.commit, sourceClean: true, compiled: true }
    expect(provenanceProblems(valid, current)).toEqual([])
    expect(provenanceProblems({}, current).length).toBe(3)
    expect(provenanceProblems({ ...valid, commit: "old" }, current).join(" ")).toContain("HEAD")
    expect(provenanceProblems({ ...valid, sourceClean: false }, current).join(" ")).toContain("committed")
    expect(provenanceProblems({ ...valid, compiled: false }, current).join(" ")).toContain("--skip-build")
    expect(provenanceProblems(valid, { ...current, clean: false }).join(" ")).toContain("uncommitted")
  })

  test("reads actual git state and detects tracked and new release inputs", () => {
    const repo = repository()
    expect(sourceProvenance(repo.directory)).toEqual({ commit: repo.git("rev-parse", "HEAD"), clean: true })
    writeFileSync(path.join(repo.directory, "package.json"), '{"name":"changed"}\n')
    expect(sourceProvenance(repo.directory).clean).toBe(false)
    repo.git("checkout", "--", "package.json")
    mkdirSync(path.join(repo.directory, "packages"))
    writeFileSync(path.join(repo.directory, "packages", "new.ts"), "export {}\n")
    expect(sourceProvenance(repo.directory).clean).toBe(false)
  })

  test("missing staged matrix is a release error", () => {
    const repo = repository()
    expect(validateStaging("2.0.0", repo.directory)).toEqual([
      { where: "dist-binaries", detail: "manifest.json is missing — run script/build-server-binaries.ts" },
    ])
  })
})

describe("history-free public export", () => {
  test("excludes private paths while preserving public docs and CI", () => {
    for (const file of [
      "docs/implementation-plan/plan.md",
      "claude-code-main/src/query.ts",
      "insights/design.md",
      "specs/plan.md",
      "infra/deploy.ts",
      "github/README.md",
      "install",
      "nix/package.nix",
      "flake.nix",
      "flake.lock",
      "session.json",
      "packages/runtime/specs/effect/migration.md",
      "packages/runtime/BUN_SHELL_MIGRATION_PLAN.md",
      "packages/app/create-effect-simplification-spec.md",
      "packages/storybook/debug-storybook.log",
      "AGENTS.md",
      "packages/runtime/AGENTS.md",
      "packages/runtime/sst-env.d.ts",
      "packages/sdk/js/sst-env.d.ts",
      "packages/script/sst-env.d.ts",
      ".cognitio/config.json",
      ".github/workflows/publish.yml",
      ".env.production",
    ]) {
      expect(isPublicPath(file), file).toBe(false)
    }
    for (const file of [
      "packages/docs/quickstart.mdx",
      "packages/runtime/test/fixtures/provider-response.log",
      "packages/runtime/src/session/prompt/plan.txt",
      "packages/docs/api-reference/interfaces/OutputFormatSpec.mdx",
      ".github/workflows",
      ".github/workflows/cognitio-sdk.yml",
      ".github/workflows/cognitio-maintenance.yml",
      ".gitlab-ci.yml",
      ".env.example",
      "LICENSE",
    ]) {
      expect(isPublicPath(file), file).toBe(true)
    }
  })

  test("exports committed bytes without private content or repository history", () => {
    const repo = repository()
    for (const file of [
      "docs/internal.md",
      "claude-code-main/source.ts",
      "packages/runtime/specs/effect/migration.md",
      "packages/runtime/BUN_SHELL_MIGRATION_PLAN.md",
      "packages/app/create-effect-simplification-spec.md",
      "packages/storybook/debug-storybook.log",
      "packages/runtime/test/fixtures/provider-response.log",
      "github/README.md",
      "install",
      "nix/package.nix",
      "flake.nix",
      "packages/docs/quickstart.mdx",
      ".github/workflows/cognitio-sdk.yml",
      ".github/workflows/cognitio-maintenance.yml",
      ".github/workflows/deploy.yml",
    ]) {
      mkdirSync(path.dirname(path.join(repo.directory, file)), { recursive: true })
      writeFileSync(path.join(repo.directory, file), file)
    }
    repo.git("add", ".")
    repo.git("commit", "-m", "source")
    writeFileSync(path.join(repo.directory, "package.json"), "uncommitted bytes")
    const destination = path.join(repo.directory, "output")
    const result = exportSource({ repository: repo.directory, destination })
    expect(readFileSync(path.join(destination, "package.json"), "utf8")).toBe("{}\n")
    expect(result.commit).toBe(repo.git("rev-parse", "HEAD"))
    expect(existsSync(path.join(destination, ".git"))).toBe(false)
    expect(existsSync(path.join(destination, "docs"))).toBe(false)
    expect(existsSync(path.join(destination, "claude-code-main"))).toBe(false)
    for (const file of [
      "packages/runtime/specs",
      "packages/runtime/BUN_SHELL_MIGRATION_PLAN.md",
      "packages/app/create-effect-simplification-spec.md",
      "packages/storybook/debug-storybook.log",
      "github",
      "install",
      "nix",
      "flake.nix",
    ])
      expect(existsSync(path.join(destination, file)), file).toBe(false)
    expect(existsSync(path.join(destination, "packages/runtime/test/fixtures/provider-response.log"))).toBe(true)
    expect(existsSync(path.join(destination, "packages/docs/quickstart.mdx"))).toBe(true)
    expect(existsSync(path.join(destination, ".github/workflows/cognitio-sdk.yml"))).toBe(true)
    expect(existsSync(path.join(destination, ".github/workflows/deploy.yml"))).toBe(false)
    expect(() => exportSource({ repository: repo.directory, destination })).toThrow("already exists")
  })

  test.skipIf(process.platform === "win32")("refuses symlinks to excluded sources", () => {
    const repo = repository()
    mkdirSync(path.join(repo.directory, "docs"))
    writeFileSync(path.join(repo.directory, "docs/private.md"), "private")
    symlinkSync("docs/private.md", path.join(repo.directory, "public-link.md"))
    repo.git("add", ".")
    repo.git("commit", "-m", "private symlink")
    const destination = path.join(repo.directory, "output")
    expect(() => exportSource({ repository: repo.directory, destination })).toThrow("private symlink")
    expect(existsSync(destination)).toBe(false)
  })
})
