import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
// Renamed or removed modules must not survive in a published dist tree.
for (const file of ["dist", "tsconfig.tsbuildinfo"]) {
  rmSync(path.join(directory, file), { recursive: true, force: true })
}
const build = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc")], {
  cwd: directory,
  stdio: "inherit",
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
