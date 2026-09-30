import { createServer } from "node:net"

export function reserveLocalPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close()
        reject(new Error("Failed to reserve local port"))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}
