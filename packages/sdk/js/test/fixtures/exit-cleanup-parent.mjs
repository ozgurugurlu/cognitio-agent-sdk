#!/usr/bin/env bun
import path from "node:path"
import { createCognitioServer } from "../../src/v2/server.ts"

const mode = process.argv[2] ?? "natural"
const autoCleanup = process.argv[3]
const server = await createCognitioServer({
  command: path.join(import.meta.dir, "fake-server.mjs"),
  port: 0,
  timeout: 5000,
  ...(autoCleanup === "unset" ? {} : { autoCleanup: autoCleanup === "true" }),
  env: {
    ...(process.env.FAKE_SIGTERM_IGNORE === "1" ? { FAKE_SIGTERM_IGNORE: "1" } : {}),
  },
})
const info = await (await fetch(`${server.url}/pid`)).json()
console.log(JSON.stringify(info))

if (mode === "exit7") process.exit(7)
if (mode === "signal") setInterval(() => {}, 1000)
