import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function run(source: string, endpoint = "") {
  await using tmp = await tmpdir()
  const proc = Bun.spawn({
    cmd: ["bun", "--conditions=browser", "--eval", source],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      COGNITIO_TEST_HOME: tmp.path,
      COGNITIO_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, stderr }).toMatchObject({ code: 0 })
  return { value: JSON.parse(stdout), stderr }
}

test("legacy calls retain Effect annotations and span, clone tags and timer semantics without duplicate output", async () => {
  const result = await run(`
    import { Effect, Logger, References } from "effect"
    import * as Log from "./src/util/log"
    import * as Output from "./src/util/log-output"
    import * as EffectLogger from "./src/effect/logger"
    await Log.init({print:false,dev:true,level:"DEBUG"})
    const records=[]
    const target=Logger.make((opts)=>records.push({
      message:opts.message, annotations:opts.fiber.getRef(References.CurrentLogAnnotations),
      traceId:opts.fiber.currentSpan?.traceId,spanId:opts.fiber.currentSpan?.spanId,
    }))
    let expected
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      yield* EffectLogger.installExporter(target)
      yield* Effect.gen(function*(){
        const span=yield* Effect.currentSpan
        expected={traceId:span.traceId,spanId:span.spanId}
        yield* Effect.sync(()=>{
          const original=Log.create({service:"legacy-test"})
          original.clone().tag("request","child").info("child-record")
          original.info("parent-record",{sessionID:"ses_test"})
          original.debug("debug-record")
          const timer=original.time("timer-record")
          timer.stop()
        })
        yield* EffectLogger.create({service:"effect-test"}).info("effect-record")
        yield* EffectLogger.create({service:"effect-test"}).debug("effect-debug-record")
      }).pipe(Effect.annotateLogs({"request.id":"ctx"}),Effect.withSpan("logger-context"))
    })).pipe(Effect.provide(EffectLogger.layer)))
    await Output.flush()
    console.log(JSON.stringify({records,expected,file:await Bun.file(Log.file()).text()}))
  `)
  expect(result.value.records).toHaveLength(7)
  for (const record of result.value.records) {
    expect(record).toMatchObject(result.value.expected)
    expect(record.annotations["request.id"]).toBe("ctx")
  }
  expect(result.value.records[0].annotations.request).toBe("child")
  expect(result.value.records[1].annotations.request).toBeUndefined()
  expect(result.value.records[1].annotations["session.id"]).toBe("ses_test")
  expect(result.value.records[2].message).toEqual(["debug-record"])
  expect(result.value.records[3].annotations.status).toBe("started")
  expect(result.value.records[4].annotations.status).toBe("completed")
  expect(result.value.records[4].annotations.duration).toBeGreaterThanOrEqual(0)
  for (const name of ["child-record", "parent-record", "effect-record", "effect-debug-record"]) {
    expect(result.value.file.split(name)).toHaveLength(2)
  }
  expect(result.value.file.split("timer-record")).toHaveLength(3)
  expect(result.stderr).toBe("")
})

test("CLI level filtering applies to both legacy and Effect records before local and exporter sinks", async () => {
  const result = await run(`
    import { Effect, Logger } from "effect"
    import * as Log from "./src/util/log"
    import * as Output from "./src/util/log-output"
    import * as EffectLogger from "./src/effect/logger"
    await Log.init({print:false,dev:true,level:"WARN"})
    const records=[]
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      yield* EffectLogger.installExporter(Logger.make(opts=>records.push(opts.message)))
      yield* Effect.sync(()=>{
        Log.Default.debug("filtered-debug")
        Log.Default.info("filtered-info")
        Log.Default.warn("visible-warn")
      })
      yield* EffectLogger.create().info("filtered-effect")
      yield* EffectLogger.create().error("visible-error")
    })).pipe(Effect.provide(EffectLogger.layer)))
    await Output.flush()
    console.log(JSON.stringify({records,file:await Bun.file(Log.file()).text()}))
  `)
  expect(result.value.records).toEqual([["visible-warn"], ["visible-error"]])
  expect(result.value.file).not.toContain("filtered")
  expect(result.value.file).toContain("WARN  ")
  expect(result.value.file).toContain("ERROR ")
})

test("endpoint-disabled logging preserves file/print output and remains usable after shutdown", async () => {
  const result = await run(`
    import * as Log from "./src/util/log"
    import * as Output from "./src/util/log-output"
    import { disposeRuntimesBounded } from "./src/effect/runtime-registry"
    await Log.init({print:false,dev:true})
    { using timer=Log.Default.time("auto-timer") }
    await Output.flush()
    const file=await Bun.file(Log.file()).text()
    await Log.init({print:true,level:"WARN"})
    Log.Default.info("hidden-after-print")
    Log.Default.warn("printed-before-disposal")
    await disposeRuntimesBounded()
    Log.Default.error("printed-after-disposal")
    console.log(JSON.stringify({file}))
  `)
  expect(result.value.file.split("auto-timer")).toHaveLength(3)
  expect(result.stderr).not.toContain("hidden-after-print")
  expect(result.stderr.split("printed-before-disposal")).toHaveLength(2)
  expect(result.stderr.split("printed-after-disposal")).toHaveLength(2)
})

test("startup backlog snapshots fields, is bounded, reports overflow and replays without duplicate local records", async () => {
  const result = await run(
    `
    import { Effect, Logger, References } from "effect"
    import * as Log from "./src/util/log"
    import * as Output from "./src/util/log-output"
    import * as EffectLogger from "./src/effect/logger"
    await Output.init({print:false,dev:true})
    const fields={nested:{value:"before"}}
    for(let i=0;i<1025;i++) Log.Default.info("buffer-record",{index:i,...fields})
    fields.nested.value="after"
    const records=[]
    await Effect.runPromise(Effect.scoped(EffectLogger.installExporter(Logger.make(opts=>records.push({
      message:opts.message,annotations:opts.fiber.getRef(References.CurrentLogAnnotations)
    })))))
    Log.Default.info("after-exporter-close")
    await Output.flush()
    console.log(JSON.stringify({records,file:await Bun.file(Log.file()).text()}))
  `,
    "http://127.0.0.1:9",
  )
  expect(result.value.records).toHaveLength(1025)
  expect(result.value.records[0].annotations.index).toBe(1)
  expect(result.value.records[0].annotations.nested).toEqual({ value: "before" })
  expect(result.value.records.at(-1)).toMatchObject({ annotations: { droppedCount: 1 } })
  expect(result.value.file.split("buffer-record")).toHaveLength(1026)
  expect(result.value.file.split("startup log buffer overflow")).toHaveLength(2)
  expect(result.value.file).toContain("after-exporter-close")
})

test("overlapping exporter scopes never restore an exporter whose scope already closed", async () => {
  const result = await run(`
    import { Effect, Exit, Logger, Scope } from "effect"
    import * as Log from "./src/util/log"
    import * as EffectLogger from "./src/effect/logger"
    await Log.init({print:false,dev:true})
    const first=[],second=[]
    const a=Scope.makeUnsafe(),b=Scope.makeUnsafe()
    await Effect.runPromise(Scope.provide(EffectLogger.installExporter(Logger.make(o=>first.push(o.message))),a))
    await Effect.runPromise(Scope.provide(EffectLogger.installExporter(Logger.make(o=>second.push(o.message))),b))
    await Effect.runPromise(Scope.close(a,Exit.succeed(undefined)))
    Log.Default.info("second-open")
    await Effect.runPromise(Scope.close(b,Exit.succeed(undefined)))
    Log.Default.info("both-closed")
    console.log(JSON.stringify({first,second}))
  `)
  expect(result.value).toEqual({ first: [], second: [["second-open"]] })
})
