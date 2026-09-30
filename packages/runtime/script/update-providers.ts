#!/usr/bin/env bun
import { fileURLToPath } from "node:url"

// Monthly maintenance proposes compatible provider updates in a reviewed PR.
// The caret constraint excludes new major versions; --exact retains our pins.
const directory = fileURLToPath(new URL("../", import.meta.url))
const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
const packages = Object.entries(manifest.dependencies as Record<string, string>)
  .filter(([name]) => name.startsWith("@ai-sdk/"))
  .map(([name, version]) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected an exact provider pin: ${name}`)
    return `${name}@^${version}`
  })
if (Bun.argv.includes("--list")) console.log(JSON.stringify(packages, null, 2))
else {
  const code = await Bun.spawn({
    cmd: [process.execPath, "add", "--exact", "--ignore-scripts", ...packages],
    cwd: directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited
  if (code !== 0) process.exit(code)
}
