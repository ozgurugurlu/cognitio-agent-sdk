import { createCognitioClient } from "../internal/runtime-client/index.js"
import type { ClientOptions } from "../types.js"
import type { Transport } from "./index.js"

export function createRemoteTransport(options: ClientOptions): Transport {
  const baseUrl = options.baseUrl!
  const client = createCognitioClient({
    baseUrl,
    headers: options.headers,
    directory: options.directory,
    experimental_workspaceID: options.workspaceId,
  })
  return {
    kind: "remote",
    baseUrl,
    client,
    async close() {
      // remote transports do not own the server lifecycle
    },
  }
}
