import path from "path"
import fs from "fs/promises"
import { createWriteStream, type WriteStream } from "fs"
import z from "zod"
import { Glob } from "@cognitio/shared/util/glob"

// This is the terminal/file sink only. It must never call the Effect logger.
export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
export type Level = z.infer<typeof Level>
export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

const priority: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
const pending = new Set<Promise<void>>()
let level: Level = "INFO"
let logpath = ""
let stream: WriteStream | undefined
let last = Date.now()

export const file = () => logpath
export const enabled = (input: Level) => priority[input] >= priority[level]

export async function flush() {
  await Promise.allSettled([...pending])
}

export async function init(options: Options) {
  if (options.level) level = options.level
  const { Global } = await import("../global")
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: Global.Path.log,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  await Promise.all(files.slice(0, -10).map((file) => fs.unlink(path.join(Global.Path.log, file)).catch(() => {})))
  await flush()
  stream?.end()
  stream = undefined
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  await fs.truncate(logpath).catch(() => {})
  stream = createWriteStream(logpath, { flags: "a" })
  stream.on("error", () => {})
}

function formatError(error: Error, depth = 0): string {
  return error.cause instanceof Error && depth < 10
    ? error.message + " Caused by: " + formatError(error.cause, depth + 1)
    : error.message
}

export function write(input: Level, message: unknown, extra: Record<string, unknown>, date = new Date()) {
  if (!enabled(input)) return
  const prefix = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (value instanceof Error) return `${key}=${formatError(value)}`
      if (typeof value === "object") {
        try {
          return `${key}=${JSON.stringify(value)}`
        } catch {
          return `${key}=[unserializable]`
        }
      }
      return `${key}=${String(value)}`
    })
    .join(" ")
  const diff = date.getTime() - last
  last = date.getTime()
  const line =
    input.padEnd(5) +
    " " +
    [date.toISOString().split(".")[0], `+${diff}ms`, prefix, message].filter(Boolean).join(" ") +
    "\n"
  if (!stream) {
    process.stderr.write(line)
    return
  }
  const target = stream
  const completion = new Promise<void>((resolve) => target.write(line, () => resolve()))
  pending.add(completion)
  void completion.then(() => pending.delete(completion))
}
