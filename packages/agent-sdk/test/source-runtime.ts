import { join } from "node:path"

const runtime = join(import.meta.dir, "..", "..", "runtime")

// Source runtimes start from SDK scratch directories, so Bun cannot rely on
// discovering the runtime package's JSX settings or preload from its cwd.
export const sourceRuntimeArgs = [
  "run",
  "--conditions=browser",
  "--tsconfig-override",
  join(runtime, "tsconfig.json"),
  "--preload",
  Bun.resolveSync("@opentui/solid/preload", runtime),
  join(runtime, "src", "index.ts"),
]
