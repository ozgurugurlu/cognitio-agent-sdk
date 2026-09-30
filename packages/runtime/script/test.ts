#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// Separate Bun processes keep module mocks and process-wide state within a
// bounded suite. The stable sorted partition is identical locally and in CI.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    ci: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    shard: { type: "string" },
    shards: { type: "string", default: "4" },
  },
  strict: true,
})
const selected = values.shard?.match(/^(\d+)\/(\d+)$/)
if (values.shard && !selected) throw new Error("--shard must use index/count, for example 1/4")
const count = Number(selected?.[2] ?? values.shards)
const index = selected ? Number(selected[1]) - 1 : undefined
if (!Number.isInteger(count) || count < 1 || count > 32 || (index !== undefined && (index < 0 || index >= count))) {
  throw new Error("Use 1–32 shards and a shard index between 1 and the count")
}
const directory = fileURLToPath(new URL("../", import.meta.url))
const files = Array.from(
  new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({
    cwd: path.join(directory, "test"),
    onlyFiles: true,
  }),
).sort()
if (!files.length) throw new Error("No runtime test files found")
const shards = Array.from({ length: count }, (_, shard) => ({
  index: shard,
  files: files.filter((_, position) => position % count === shard).map((file) => `./test/${file}`),
})).filter((shard) => index === undefined || shard.index === index)
if (values.list) {
  console.log(JSON.stringify(shards, null, 2))
} else {
  if (values.ci) await mkdir(path.join(directory, ".artifacts/unit"), { recursive: true })
  const results = await Promise.all(
    shards.map(async (shard) => {
      if (!shard.files.length) return 0
      console.log(`Runtime shard ${shard.index + 1}/${count}: ${shard.files.length} files`)
      return Bun.spawn({
        cmd: [
          process.execPath,
          "test",
          "--timeout",
          "30000",
          ...(values.ci ? ["--reporter=junit", `--reporter-outfile=.artifacts/unit/junit-${shard.index + 1}.xml`] : []),
          ...shard.files,
        ],
        cwd: directory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).exited
    }),
  )
  if (results.some((code) => code !== 0)) process.exit(1)
}
