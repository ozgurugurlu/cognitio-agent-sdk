import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless cognitio server",
  handler: async (args) => {
    if (!Flag.COGNITIO_SERVER_PASSWORD) {
      console.log("Warning: COGNITIO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`agent server listening at ${server.url}`)

    await new Promise(() => {})
    await server.stop()
  },
})
