import launch from "cross-spawn"
import { type Config } from "./gen/types.gen.js"
import { stop, drainOutput, bindAbort } from "./process.js"

export type ServerOptions = {
  hostname?: string
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: Config
}

export type TuiOptions = {
  project?: string
  model?: string
  session?: string
  agent?: string
  signal?: AbortSignal
  config?: Config
}

export async function createCognitioServer(options?: ServerOptions) {
  options = Object.assign(
    {
      hostname: "127.0.0.1",
      port: 4096,
      timeout: 5000,
    },
    options ?? {},
  )

  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`]
  if (options.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`)

  const proc = launch(`cognitio`, args, {
    env: {
      ...process.env,
      COGNITIO_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
    },
  })
  let clear = () => {}

  const url = await new Promise<string>((resolve, reject) => {
    let resolved = false
    let failed = false
    let draining = false
    const fail = (reason: unknown, afterDrain?: () => unknown) => {
      if (failed) return
      failed = true
      resolved = true
      clearTimeout(id)
      clear()
      if (!afterDrain) {
        reject(reason)
        return
      }
      draining = true
      void drainOutput(proc).then(() => {
        draining = false
        reject(afterDrain())
      })
    }
    const id = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${options.timeout}ms`))
      stop(proc)
    }, options.timeout)
    let output = ""
    proc.stdout?.on("data", (chunk) => {
      if (resolved && !draining) return
      output += chunk.toString()
      if (resolved) return
      const lines = output.split("\n")
      for (const line of lines.slice(0, -1)) {
        if (line.startsWith("agent server listening at ")) {
          const match = line.match(/at\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            fail(new Error(`Failed to parse server url from output: ${line}`))
            stop(proc)
            return
          }
          clearTimeout(id)
          resolved = true
          resolve(match[1]!)
          return
        }
      }
    })
    proc.stderr?.on("data", (chunk) => {
      if (resolved && !draining) return
      output += chunk.toString()
    })
    proc.on("exit", (code) => {
      clearTimeout(id)
      const exitError = () => {
        let msg = `Server exited with code ${code}`
        if (output.trim()) {
          msg += `\nServer output: ${output}`
        }
        return new Error(msg)
      }
      fail(exitError(), resolved ? undefined : exitError)
    })
    proc.on("error", (error) => {
      fail(error)
    })
    clear = bindAbort(proc, options.signal, () => {
      fail(options.signal?.reason)
    })
  })

  return {
    url,
    close() {
      clear()
      stop(proc)
    },
  }
}

export function createCognitioTui(options?: TuiOptions) {
  const args = []

  if (options?.project) {
    args.push(`--project=${options.project}`)
  }
  if (options?.model) {
    args.push(`--model=${options.model}`)
  }
  if (options?.session) {
    args.push(`--session=${options.session}`)
  }
  if (options?.agent) {
    args.push(`--agent=${options.agent}`)
  }

  const proc = launch(`cognitio`, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      COGNITIO_CONFIG_CONTENT: JSON.stringify(options?.config ?? {}),
    },
  })

  const clear = bindAbort(proc, options?.signal)

  return {
    close() {
      clear()
      stop(proc)
    },
  }
}
