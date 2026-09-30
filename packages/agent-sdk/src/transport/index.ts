import type { CognitioClient } from "../internal/runtime-client/index.js"
import type { ClientOptions, TransportKind } from "../types.js"
import { sdkError } from "../errors.js"
import { createRemoteTransport } from "./remote.js"
import { createSpawnTransport } from "./spawn.js"

/**
 * Normalized transport handle. Transports wrap the low-level `CognitioClient`
 * and expose a uniform `close()` so consumers do not care whether the server
 * is spawned locally or remote.
 */
export interface Transport {
  kind: TransportKind
  /** Server base URL as seen by the client (spawn or remote). */
  baseUrl: string
  client: CognitioClient
  /** True when this transport spawned a hermetic (COGNITIO_ISOLATED) server. */
  isolated?: boolean
  close(): Promise<void>
}

export async function resolveTransport(options: ClientOptions | undefined): Promise<Transport> {
  if (options?.headers !== undefined && !options.baseUrl) {
    throw sdkError("configuration", "ClientOptions.headers requires baseUrl")
  }
  if (
    options?.headers !== undefined &&
    (!options.headers ||
      typeof options.headers !== "object" ||
      Array.isArray(options.headers) ||
      Object.values(options.headers).some((value) => typeof value !== "string"))
  ) {
    throw sdkError("configuration", "ClientOptions.headers must be a string record")
  }
  if (options?.baseUrl) return createRemoteTransport(options)
  return createSpawnTransport(options ?? {})
}

export { createSpawnTransport, createRemoteTransport }
