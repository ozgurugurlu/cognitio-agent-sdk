#!/usr/bin/env bun
// The SDK release is the only supported public distribution pipeline.
import { spawnSync } from "node:child_process"
import path from "node:path"

const result = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "../packages/agent-sdk/script/publish.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
