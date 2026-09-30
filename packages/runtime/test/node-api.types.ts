import type * as Contract from "../src/node-api"
import { Config, Server, Log, JsonMigration, bootstrap } from "../src/node"

// Keep the deliberately small desktop declaration boundary honest without
// exposing private Effect brands or bundler-specific imports as public types.
const contract: Pick<typeof Contract, "Config" | "Server" | "Log" | "JsonMigration" | "bootstrap"> = {
  Config,
  Server,
  Log,
  JsonMigration,
  bootstrap,
}
void contract
