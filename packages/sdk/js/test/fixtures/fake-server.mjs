#!/usr/bin/env bun
// Fake `cognitio serve` binary for server.test.ts. Knobs via env:
//   FAKE_MODE:           serve (default) | exit | exit-buffered | silent | bad-url
//   FAKE_SIGTERM_IGNORE: "1" → ignore SIGTERM (forces the SIGKILL path)
//   FAKE_EXIT_DELAY_MS:  delay before exiting in "exit" mode
import http from "node:http"
import { spawn } from "node:child_process"

const mode = process.env.FAKE_MODE ?? "serve"
const exitDelay = Number(process.env.FAKE_EXIT_DELAY_MS ?? "0")

if (process.env.FAKE_SIGTERM_IGNORE === "1") {
  process.on("SIGTERM", () => {})
}

if (mode === "exit-buffered") {
  // Keep stderr open after this process exits. The descendant waits for its
  // stdin to close on our exit, writes one diagnostic, then exits naturally.
  const child = spawn(process.execPath, [
    "-e",
    'process.stdin.resume(); process.stdin.once("end", () => setTimeout(() => process.stderr.write("boom\\n"), 20))',
  ], { stdio: ["pipe", "ignore", "inherit"] })
  child.unref()
  process.exit(7)
} else if (mode === "exit") {
  console.error("boom")
  setTimeout(() => process.exit(7), exitDelay)
} else {
  const server = http.createServer((req, res) => {
    if (req.url === "/env") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(process.env))
      return
    }
    if (req.url === "/args") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(process.argv.slice(2)))
      return
    }
    if (req.url === "/pid") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ pid: process.pid }))
      return
    }
    res.end("ok")
  })
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address()
    console.log("fake-server noise line before readiness")
    if (mode === "bad-url") {
      console.log("agent server listening at not-a-url")
    } else if (mode !== "silent") {
      console.log(`agent server listening at http://127.0.0.1:${port}`)
    }
  })
}
