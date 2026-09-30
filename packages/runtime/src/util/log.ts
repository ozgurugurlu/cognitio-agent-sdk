import * as EffectLogger from "../effect/logger"
import * as Output from "./log-output"

export const Level = Output.Level
export type Level = Output.Level
export type Options = Output.Options
export const file = Output.file

export type Logger = {
  debug(message?: unknown, extra?: object): void
  info(message?: unknown, extra?: object): void
  error(message?: unknown, extra?: object): void
  warn(message?: unknown, extra?: object): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(message: string, extra?: Record<string, unknown>): { stop(): void; [Symbol.dispose](): void }
}

export async function init(options: Options) {
  await Output.init(options)
  await EffectLogger.initialize()
}

// Synchronous compatibility API. Only log-output owns terminal/file writes.
export function create(input: Record<string, unknown> = {}): Logger {
  const tags = { ...input }
  const result: Logger = {
    debug: (message, extra) => EffectLogger.emitSync("Debug", message, { ...tags, ...extra }),
    info: (message, extra) => EffectLogger.emitSync("Info", message, { ...tags, ...extra }),
    error: (message, extra) => EffectLogger.emitSync("Error", message, { ...tags, ...extra }),
    warn: (message, extra) => EffectLogger.emitSync("Warn", message, { ...tags, ...extra }),
    tag(key, value) {
      tags[key] = value
      return result
    },
    clone: () => create(tags),
    time(message, extra) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      const stop = () => result.info(message, { status: "completed", duration: Date.now() - now, ...extra })
      return { stop, [Symbol.dispose]: stop }
    },
  }
  return result
}

export const Default = create({ service: "default" })
