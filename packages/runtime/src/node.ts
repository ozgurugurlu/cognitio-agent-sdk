import { Config as RuntimeConfig } from "./config"
import { AppRuntime } from "./effect/app-runtime"

export namespace Config {
  export type Info = RuntimeConfig.Info
  export function get(): Promise<Info> {
    return AppRuntime.runPromise(RuntimeConfig.Service.use((config) => config.get()))
  }
}
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export { Log } from "./util"
export { Database } from "./storage"
export { JsonMigration } from "./storage"
