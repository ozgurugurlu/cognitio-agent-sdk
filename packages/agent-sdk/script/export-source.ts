import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Local reference material and private planning never belong in the public snapshot. */
export function isPublicPath(file: string) {
  const parts = file.replaceAll("\\", "/").split("/")
  if (
    [
      "docs",
      "claude-code-main",
      "insights",
      "specs",
      "refs",
      "infra",
      "github",
      "nix",
      ".git",
      ".cognitio",
      ".opencode",
      ".claude",
      ".codex",
      ".kilo",
      ".kilocode",
      ".gitlab",
    ].includes(parts[0]!)
  )
    return false
  if (
    [
      "install",
      "flake.nix",
      "flake.lock",
      "session.json",
      "packages/runtime/BUN_SHELL_MIGRATION_PLAN.md",
      "packages/app/create-effect-simplification-spec.md",
    ].includes(file)
  )
    return false
  if (file === "packages/runtime/specs" || file.startsWith("packages/runtime/specs/")) return false
  if (file.endsWith(".log") && !parts.some((part) => part === "fixture" || part === "fixtures")) return false
  if (parts.some((part) => [".cognitio", ".opencode", ".claude", ".codex", ".kilo", ".kilocode"].includes(part)))
    return false
  if (["AGENTS.md", "CLAUDE.md", ".DS_Store", "sst-env.d.ts"].includes(parts.at(-1)!)) return false
  if (parts.some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))) return false
  if (/^(?:compaction-.*\.md|sst\.(?:config|env)\..*)$/.test(file)) return false
  if (
    file.startsWith(".github/") &&
    ![".github/workflows", ".github/workflows/cognitio-sdk.yml", ".github/workflows/cognitio-maintenance.yml"].includes(
      file,
    )
  )
    return false
  return true
}

/** Exports committed bytes, never .git history, into a new directory. Does not push. */
export function exportSource(options: { repository: string; destination: string; ref?: string }) {
  const destination = path.resolve(options.destination)
  if (existsSync(destination)) throw new Error("The export destination already exists; choose a new directory")
  const reference = options.ref ?? "HEAD"
  const commit = spawnSync("git", ["-C", options.repository, "rev-parse", "--verify", `${reference}^{commit}`], {
    encoding: "utf8",
  })
  if (commit.status !== 0) throw new Error(`Cannot resolve source commit: ${commit.stderr}`)
  const archive = spawnSync("git", ["-C", options.repository, "archive", "--format=tar", commit.stdout.trim()], {
    maxBuffer: 512 * 1024 * 1024,
  })
  if (archive.status !== 0) throw new Error(`Cannot archive source: ${archive.stderr.toString()}`)
  mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = mkdtempSync(path.join(path.dirname(destination), ".cognitio-export-"))
  try {
    const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary], { input: archive.stdout, maxBuffer: 1024 * 1024 })
    if (extracted.status !== 0) throw new Error(`Cannot extract source: ${extracted.stderr.toString()}`)
    const files: string[] = []
    const scan = (directory: string, prefix = "") => {
      for (const entry of readdirSync(directory)) {
        const relative = prefix ? `${prefix}/${entry}` : entry
        const absolute = path.join(directory, entry)
        if (!isPublicPath(relative)) {
          rmSync(absolute, { recursive: true, force: true })
          continue
        }
        const info = lstatSync(absolute)
        if (info.isSymbolicLink()) {
          const target = path.resolve(directory, readlinkSync(absolute))
          if (!target.startsWith(temporary + path.sep) || !isPublicPath(path.relative(temporary, target))) {
            throw new Error(`Public export contains an external or private symlink: ${relative}`)
          }
        }
        if (info.isDirectory()) scan(absolute, relative)
        else files.push(relative)
      }
    }
    scan(temporary)
    writeFileSync(
      path.join(temporary, "SOURCE-MANIFEST.json"),
      JSON.stringify(
        {
          sourceCommit: commit.stdout.trim(),
          product: "Cognitio Agent SDK",
          historyIncluded: false,
          files: files.sort(),
        },
        null,
        2,
      ) + "\n",
    )
    renameSync(temporary, destination)
    return { destination, commit: commit.stdout.trim(), files: files.length }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  if (args.some((arg) => !arg.startsWith("--out="))) throw new Error("Usage: export-source.ts [--out=/new/directory]")
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  const destination = args.find((arg) => arg.startsWith("--out="))?.slice(6)
  if (destination !== undefined && !destination.trim()) throw new Error("--out must not be empty")
  console.log(
    JSON.stringify(
      exportSource({
        repository: directory,
        destination: destination ?? path.join(os.tmpdir(), `cognitio-public-${Date.now()}`),
      }),
      null,
      2,
    ),
  )
}
