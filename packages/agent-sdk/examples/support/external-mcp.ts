import { createServer } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

/** A real HTTP MCP service, separate from the agent runtime and SDK control channel. */
export async function externalMcp() {
  const calls: Array<{ a: number; b: number }> = []
  const connections = new Set<McpServer>()
  const server = createServer(async (request, response) => {
    const mcp = new McpServer({ name: "example-catalog", version: "1.0.0" })
    connections.add(mcp)
    mcp.registerTool("multiply", { inputSchema: { a: z.number(), b: z.number() } }, (input) => {
      calls.push(input)
      return { content: [{ type: "text", text: String(input.a * input.b) }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on("close", () => {
      connections.delete(mcp)
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("MCP server did not bind a TCP port")
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    async close() {
      await Promise.all([...connections].map((mcp) => mcp.close()))
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) return reject(error)
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
}
