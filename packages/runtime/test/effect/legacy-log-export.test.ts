import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

type Record = {
  severityText: string
  body: { stringValue?: string }
  attributes: { key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }[]
  traceId?: string
  spanId?: string
}
type Logs = { resourceLogs?: { scopeLogs?: { logRecords?: Record[] }[] }[] }

const sessionID = "ses_12345678901234567890123456"
const fields = (record: Record) =>
  Object.fromEntries(
    record.attributes.map((field) => [
      field.key,
      field.value.stringValue ?? field.value.intValue ?? field.value.doubleValue,
    ]),
  )

test("all legacy logging families enter Effect and export once, redact content, and flush on teardown", async () => {
  await using tmp = await tmpdir()
  const batches: Logs[] = []
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/logs") batches.push((await request.json()) as Logs)
      else await request.text()
      return Response.json({})
    },
  })
  const child = Bun.spawn({
    cwd: path.resolve(import.meta.dir, "../.."),
    cmd: [
      process.execPath,
      "--eval",
      `
      import { Effect, ManagedRuntime } from "effect"
      import * as Log from "./src/util/log"
      import * as EffectLogger from "./src/effect/logger"
      import { Observability } from "./src/effect/observability"
      import { memoMap } from "./src/effect/memo-map"
      import { registerRuntime, disposeRuntimes } from "./src/effect/runtime-registry"

      Log.Default.info("private-bootstrap-prompt", { count: 45001, input: { prompt: "private-input" } })
      await Log.init({ print: true, level: "DEBUG" })
      const runtime = registerRuntime(ManagedRuntime.make(Observability.layer, { memoMap }))
      Log.create({ service: "provider" }).debug("private-provider-response", {
        count: 45002, providerID: "private-provider-label", modelID: "private-model-label", duration: 12,
        headers: { authorization: "Bearer private-key" }, error: new Error("private-error"), status: "completed",
      })
      await runtime.runPromise(Effect.gen(function* () {
        Log.create({ service: "bash-tool" }).info("private-shell-command", { count: 45003, args: ["private-command-arg"] })
        yield* EffectLogger.create({ service: "session" }).info("private-native-effect-content", { count: 45004, output: "private-output" })
      }).pipe(Effect.annotateLogs({ "session.id": "${sessionID}", privateContext: "private-context" }), Effect.withSpan("logger.integration")))
      await runtime.runPromise(EffectLogger.create({ service: "session" }).debug("private-effect-debug", { count: 45005 }))
      await disposeRuntimes()
      Log.Default.warn("private-after-disposal", { count: 45006 })
      console.log("LOGGER_CHILD_COMPLETE")
    `,
    ],
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_METRIC_EXPORT_INTERVAL: "600000",
      COGNITIO_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain("LOGGER_CHILD_COMPLETE")
    const records = batches
      .flatMap((batch) => batch.resourceLogs ?? [])
      .flatMap((resource) => resource.scopeLogs ?? [])
      .flatMap((scope) => scope.logRecords ?? [])
    for (const count of [45001, 45002, 45003, 45004, 45005]) {
      expect(records.filter((record) => fields(record).count === count)).toHaveLength(1)
      expect(stderr.split(`count=${count}`).length - 1).toBe(1)
    }
    expect(records.some((record) => fields(record).count === 45006)).toBe(false)
    expect(stderr).toContain("private-after-disposal")
    expect(JSON.stringify(batches)).not.toContain("private-")
    expect(records.filter((record) => fields(record).count === 45002)[0]?.severityText).toBe("Debug")
    expect(fields(records.find((record) => fields(record).count === 45002)!)).toMatchObject({
      service: "provider",
      duration: 12,
      status: "completed",
    })
    const inside = records.find((record) => fields(record).count === 45003)!
    const native = records.find((record) => fields(record).count === 45004)!
    expect(fields(inside)["session.id"]).toBe(sessionID)
    expect(inside.traceId).toBeDefined()
    expect(inside.traceId).toBe(native.traceId)
    expect(inside.spanId).toBe(native.spanId)
    expect(inside.body.stringValue).toBe("[redacted]")
  } finally {
    child.kill()
    await child.exited
  }
}, 30000)

test("shutdown waits for multiple size-triggered batches and the remaining buffer after initialization", async () => {
  const batches: Logs[] = []
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/logs") {
        await request.text()
        return Response.json({})
      }
      const batch = (await request.json()) as Logs
      await Bun.sleep(150)
      batches.push(batch)
      return Response.json({})
    },
  })
  const child = Bun.spawn({
    cwd: path.resolve(import.meta.dir, "../.."),
    cmd: [
      process.execPath,
      "--eval",
      `
      import * as Log from "./src/util/log"
      import { disposeRuntimes } from "./src/effect/runtime-registry"
      await Log.init({ print: true, level: "INFO" })
      for (let index = 0; index < 2501; index++) Log.Default.info("private-in-flight-record", { count: 65000 + index })
      await disposeRuntimes()
    `,
    ],
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_METRIC_EXPORT_INTERVAL: "600000",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit, stderr).toBe(0)
    const counts = batches
      .flatMap((batch) => batch.resourceLogs ?? [])
      .flatMap((resource) => resource.scopeLogs ?? [])
      .flatMap((scope) => scope.logRecords ?? [])
      .map((record) => fields(record).count)
      .filter((count): count is number => typeof count === "number")
    expect(counts).toHaveLength(2501)
    expect(new Set(counts).size).toBe(2501)
    expect(Math.min(...counts)).toBe(65000)
    expect(Math.max(...counts)).toBe(67500)
    expect(JSON.stringify(batches)).not.toContain("private-in-flight-record")
  } finally {
    child.kill()
    await child.exited
  }
}, 30000)

test("legacy logging preserves synchronous local output and levels with no exporter configured", async () => {
  const child = Bun.spawn({
    cwd: path.resolve(import.meta.dir, "../.."),
    cmd: [
      process.execPath,
      "--eval",
      `
      import * as Log from "./src/util/log"
      import { disposeRuntimes } from "./src/effect/runtime-registry"
      await Log.init({ print: true, level: "WARN" })
      Log.Default.debug("hidden-debug")
      Log.Default.info("hidden-info")
      Log.Default.warn("visible-local-warning", { input: "local-content-stays" })
      Log.Default.error("visible-local-error")
      await disposeRuntimes()
    `,
    ],
    env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit, stderr).toBe(0)
    expect(stderr).not.toContain("hidden-")
    expect(stderr.split("visible-local-warning")).toHaveLength(2)
    expect(stderr.split("visible-local-error")).toHaveLength(2)
    expect(stderr).toContain("local-content-stays")
  } finally {
    child.kill()
    await child.exited
  }
}, 30000)

test("teardown initializes the exporter for buffered startup logs and reports overflow without Log.init", async () => {
  const batches: Logs[] = []
  using collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/logs") batches.push((await request.json()) as Logs)
      else await request.text()
      return Response.json({})
    },
  })
  const child = Bun.spawn({
    cwd: path.resolve(import.meta.dir, "../.."),
    cmd: [
      process.execPath,
      "--eval",
      `
      import * as Log from "./src/util/log"
      import { disposeRuntimes } from "./src/effect/runtime-registry"
      for (let index = 0; index < 1025; index++) Log.Default.info("private-startup-record", { count: 55000 + index })
      await disposeRuntimes()
    `,
    ],
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_METRIC_EXPORT_INTERVAL: "600000",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit, stderr).toBe(0)
    const records = batches
      .flatMap((batch) => batch.resourceLogs ?? [])
      .flatMap((resource) => resource.scopeLogs ?? [])
      .flatMap((scope) => scope.logRecords ?? [])
    const buffered = records.filter((record) => typeof fields(record).count === "number")
    expect(buffered).toHaveLength(1024)
    expect(new Set(buffered.map((record) => fields(record).count)).size).toBe(1024)
    expect(buffered.some((record) => fields(record).count === 55000)).toBe(false)
    expect(records.filter((record) => fields(record).service === "logging").map(fields)).toEqual([
      expect.objectContaining({ service: "logging", droppedCount: 1 }),
    ])
    expect(stderr.split("private-startup-record")).toHaveLength(1026)
    expect(JSON.stringify(batches)).not.toContain("private-startup-record")
  } finally {
    child.kill()
    await child.exited
  }
}, 30000)
