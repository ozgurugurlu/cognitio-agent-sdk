import { ManagedRuntime } from "effect"
import { layer } from "./observability"
import { memoMap } from "./memo-map"
import { registerRuntime } from "./runtime-registry"

// Loaded only when an OTLP endpoint is configured. Sharing the memo map keeps
// this bootstrap and the application runtimes on one exporter lifecycle.
const runtime = registerRuntime(ManagedRuntime.make(layer, { memoMap }))

export async function initialize() {
  await runtime.context()
}
