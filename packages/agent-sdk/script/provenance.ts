import { spawnSync } from "node:child_process"

/** Release inputs include generated code, build tools, and all runtime dependencies. */
const inputs = ["package.json", "bun.lock", "patches", "packages", "script", "LICENSE", "NOTICE"]

export function sourceProvenance(directory: string) {
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`Cannot establish release provenance: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
  return {
    commit: git(["rev-parse", "HEAD"]),
    clean: git(["status", "--porcelain", "--untracked-files=all", "--", ...inputs]) === "",
  }
}

/** Dirty or restaged binaries cannot become a release merely by committing afterward. */
export function provenanceProblems(
  recorded: { commit?: string; sourceClean?: boolean; compiled?: boolean },
  current: ReturnType<typeof sourceProvenance>,
) {
  return [
    ...(!recorded.commit ? ["manifest.json has no source commit — rebuild the binaries"] : []),
    ...(recorded.commit && recorded.commit !== current.commit
      ? [`binaries were built at ${recorded.commit}, but HEAD is ${current.commit} — rebuild the binaries`]
      : []),
    ...(recorded.sourceClean !== true
      ? ["binaries were not built from committed, clean source — rebuild after committing"]
      : []),
    ...(recorded.compiled !== true
      ? ["binaries were restaged without compilation — rebuild without --skip-build"]
      : []),
    ...(!current.clean ? ["release inputs have uncommitted changes — commit before building a release"] : []),
  ]
}
