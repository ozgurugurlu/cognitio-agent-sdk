import { Cause, Context, Effect, Fiber, Layer, Logger, References, type LogLevel, type Scope } from "effect"
import * as Output from "../util/log-output"
import { registerRuntimeDisposal } from "./runtime-registry"

type Fields = Record<string, unknown>
type Pending = {
  readonly context: Context.Context<never>
  readonly message: unknown
  readonly cause: Cause.Cause<unknown>
  readonly date: Date
  readonly logLevel: LogLevel.LogLevel
}

const configured = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const pending: Pending[] = []
const pendingLimit = 1024
let dropped = 0
let exporter: Logger.Logger<unknown, void> | undefined
const exporters = new Map<symbol, Logger.Logger<unknown, void>>()
let ready: Promise<void> | undefined
let stopped = false
let exporterClosed = false

const normalizeKey = (key: string) => (key === "sessionID" ? "session.id" : key)

export interface Handle {
  readonly debug: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly info: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly warn: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly error: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly with: (extra: Fields) => Handle
}

const clean = (input?: Fields): Fields =>
  Object.fromEntries(
    Object.entries(input ?? {})
      .filter((entry) => entry[1] !== undefined && entry[1] !== null)
      .map(([key, value]) => [normalizeKey(key), value]),
  )

const text = (input: unknown): string => {
  if (Array.isArray(input)) return input.map((item) => String(item)).join(" ")
  return input === undefined ? "" : String(input)
}

const call = (run: (msg?: unknown) => Effect.Effect<void>, base: Fields, msg?: unknown, extra?: Fields) => {
  const ann = clean({ ...base, ...extra })
  const fx = run(msg)
  return Object.keys(ann).length ? Effect.annotateLogs(fx, ann) : fx
}

function snapshot(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return String(value)
  }
}

function capture(opts: Logger.Options<unknown>): Pending {
  const annotations = Object.fromEntries(
    Object.entries(opts.fiber.getRef(References.CurrentLogAnnotations)).map(([key, value]) => [key, snapshot(value)]),
  )
  const context = Context.add(
    Context.add(opts.fiber.context, References.CurrentLogAnnotations, annotations),
    References.CurrentLogSpans,
    opts.fiber.getRef(References.CurrentLogSpans).map(([name, start]) => [name, start] as const),
  )
  return {
    context,
    message: snapshot(opts.message),
    cause: Cause.fromReasons(
      opts.cause.reasons.flatMap((reason) => {
        if (reason._tag === "Fail") return Cause.fail(snapshot(reason.error)).reasons
        if (reason._tag === "Die") return Cause.die(snapshot(reason.defect)).reasons
        return Cause.interrupt(reason.fiberId).reasons
      }),
    ),
    date: new Date(opts.date),
    logLevel: opts.logLevel,
  }
}

function forward(target: Logger.Logger<unknown, void>, options: Logger.Options<unknown>) {
  try {
    target.log(options)
  } catch (error) {
    Output.write("ERROR", "telemetry logger failed", { errorType: error instanceof Error ? error.name : typeof error })
  }
}

function replay(target: Logger.Logger<unknown, void>, entry: Pending) {
  Effect.runSyncWith(entry.context)(
    Effect.withFiber((fiber) => Effect.sync(() => forward(target, { ...entry, fiber }))),
  )
}

export const logger = Logger.make((opts) => {
  const severity =
    opts.logLevel === "Trace" || opts.logLevel === "Debug"
      ? "DEBUG"
      : opts.logLevel === "Warn"
        ? "WARN"
        : opts.logLevel === "Error" || opts.logLevel === "Fatal"
          ? "ERROR"
          : "INFO"
  if (!Output.enabled(severity)) return

  const extra = clean(opts.fiber.getRef(References.CurrentLogAnnotations))
  const now = opts.date.getTime()
  for (const [key, start] of opts.fiber.getRef(References.CurrentLogSpans)) {
    extra[`logSpan.${key}`] = `${now - start}ms`
  }
  if (opts.cause.reasons.length > 0) extra.cause = Cause.pretty(opts.cause)
  Output.write(severity, text(opts.message), extra, opts.date)

  if (exporter) {
    forward(exporter, opts)
    return
  }
  if (!configured || stopped || exporterClosed) return
  if (pending.length === pendingLimit) {
    pending.shift()
    dropped++
  }
  pending.push(capture(opts))
})

export const layer = Layer.merge(
  Logger.layer([logger], { mergeWithExisting: false }),
  Layer.succeed(References.MinimumLogLevel)("Trace"),
)

// Log methods are synchronous. Enter the current Effect context so annotations
// and parent spans survive, without moving records to detached background fibers.
export function emitSync(level: LogLevel.Severity, message?: unknown, fields?: Fields) {
  const current = Fiber.getCurrent()
  const loggers = new Set(current?.getRef(Logger.CurrentLoggers) ?? [])
  loggers.delete(Logger.defaultLogger)
  loggers.delete(Logger.tracerLogger)
  loggers.add(logger)
  const context = Context.add(
    Context.add(current?.context ?? Context.empty(), Logger.CurrentLoggers, loggers),
    // Legacy methods have always obeyed the CLI's configured level. The single
    // sink applies that level to both local and exported records.
    References.MinimumLogLevel,
    "Trace",
  )
  Effect.runSyncWith(context)(Effect.logWithLevel(level)(message).pipe(Effect.annotateLogs(clean(fields))))
}

export const installExporter = (target: Logger.Logger<unknown, void>): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (stopped) return
    const registration = Symbol()
    exporters.set(registration, target)
    exporter = target
    exporterClosed = false
    const backlog = pending.splice(0)
    for (const entry of backlog) replay(target, entry)
    if (dropped) {
      const count = dropped
      dropped = 0
      emitSync("Warn", "startup log buffer overflow", { service: "logging", droppedCount: count })
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        exporters.delete(registration)
        exporter = Array.from(exporters.values()).at(-1)
        exporterClosed = exporter === undefined
      }),
    )
  })

export async function initialize() {
  if (!configured || stopped || exporterClosed || exporter) return
  ready ??= import("./log-runtime").then((runtime) => runtime.initialize())
  await ready
}

registerRuntimeDisposal({
  before: async () => {
    if (pending.length || dropped) await initialize()
    await ready
    stopped = true
  },
  after: Output.flush,
})

export const create = (base: Fields = {}): Handle => ({
  debug: (msg, extra) => call((item) => Effect.logDebug(item), base, msg, extra),
  info: (msg, extra) => call((item) => Effect.logInfo(item), base, msg, extra),
  warn: (msg, extra) => call((item) => Effect.logWarning(item), base, msg, extra),
  error: (msg, extra) => call((item) => Effect.logError(item), base, msg, extra),
  with: (extra) => create({ ...base, ...extra }),
})
