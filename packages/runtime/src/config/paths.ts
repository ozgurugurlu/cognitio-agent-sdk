export * as ConfigPaths from "./paths"

import path from "path"
import { Filesystem } from "@/util"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { unique } from "remeda"
import { JsonError } from "./error"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@cognitio/shared/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  return unique([
    // Isolated servers only see explicit channels (COGNITIO_CONFIG_DIR); the
    // implicit host dirs (global config, ~/.cognitio) are skipped fail-closed.
    ...(Flag.COGNITIO_ISOLATED ? [] : [Global.Path.config]),
    ...(!Flag.COGNITIO_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".cognitio"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(Flag.COGNITIO_ISOLATED
      ? []
      : yield* afs.up({
          targets: [".cognitio"],
          start: Global.Path.home,
          stop: Global.Path.home,
        })),
    ...(Flag.COGNITIO_CONFIG_DIR ? [Flag.COGNITIO_CONFIG_DIR] : []),
  ])
})

/**
 * Provenance of a config directory for session-level settingSources gating.
 * Explicit channels (COGNITIO_CONFIG_DIR) and home-scoped dirs are user-level;
 * only ancestor `.cognitio` dirs discovered from the project tree are
 * project-level. `~/.cognitio` must be checked before any `.cognitio` suffix
 * heuristic, and a dir that serves two roles after unique() keeps the first
 * classification below.
 */
export function classifyConfigDir(dir: string): "user" | "project" {
  if (dir === Global.Path.config) return "user"
  if (Flag.COGNITIO_CONFIG_DIR && dir === Flag.COGNITIO_CONFIG_DIR) return "user"
  if (dir === path.join(Global.Path.home, ".cognitio")) return "user"
  return "project"
}

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
export async function readFile(filepath: string) {
  return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return
    throw new JsonError({ path: filepath }, { cause: err })
  })
}
