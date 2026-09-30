import { spawnSync } from "node:child_process"
import path from "node:path"

const directory = path.resolve(import.meta.dirname, "..")
for (const args of [
  ["run", "build"],
  ["test", "test/examples.test.ts", "--timeout", "90000"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: directory, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
