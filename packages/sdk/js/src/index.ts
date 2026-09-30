export * from "./client.js"
export * from "./server.js"

import { createCognitioClient } from "./client.js"
import { createCognitioServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createCognitio(options?: ServerOptions) {
  const server = await createCognitioServer({
    ...options,
  })

  const client = createCognitioClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
