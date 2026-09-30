#!/usr/bin/env bun
// Fake `cognitio serve` binary for server.test.ts. Knobs via env:
//   FAKE_MODE:           serve (default) | exit | silent | bad-url
//   FAKE_SIGTERM_IGNORE: "1" → ignore SIGTERM (forces the SIGKILL path)
//   FAKE_EXIT_DELAY_MS:  delay before exiting in "exit" mode
import http from "node:http"

const mode = process.env.FAKE_MODE ?? "serve"
const exitDelay = Number(process.env.FAKE_EXIT_DELAY_MS ?? "0")

if (process.env.FAKE_SIGTERM_IGNORE === "1") {
  process.on("SIGTERM", () => {})
}

if (mode === "exit") {
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
