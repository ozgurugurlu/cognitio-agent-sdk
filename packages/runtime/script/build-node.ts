#!/usr/bin/env bun
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pkg from "../package.json"

const root = fileURLToPath(new URL("..", import.meta.url))
const output = path.join(root, "dist/node")
const migrations = await Promise.all(
  (await readdir(path.join(root, "migration")))
    .filter((name) => /^\d{14}_/.test(name))
    .sort()
    .map(async (name) => {
      const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)!
      return {
        name,
        timestamp: Date.UTC(+date[1], +date[2] - 1, +date[3], +date[4], +date[5], +date[6]),
        sql: await Bun.file(path.join(root, "migration", name, "migration.sql")).text(),
      }
    }),
)

// Preserve sibling compiled CLI artifacts; this build owns only the Node tree.
await rm(output, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [path.join(root, "src/node.ts")],
  tsconfig: path.join(root, "tsconfig.json"),
  target: "node",
  format: "esm",
  outdir: output,
  packages: "bundle",
  // Electron serves its renderer separately; satisfy the optional embedded UI
  // import so its second bundling pass never resolves a nonexistent CLI asset.
  files: { "cognitio-web-ui.gen.ts": "export default {}" },
  external: ["@lydell/node-pty", "node-gyp"],
  loader: { ".wasm": "file", ".txt": "text" },
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        // Its UMD entry passes require as a variable, escaping static bundling.
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: fileURLToPath(import.meta.resolve("jsonc-parser/lib/esm/main.js")),
        }))
      },
    },
  ],
  define: {
    COGNITIO_VERSION: JSON.stringify(process.env.COGNITIO_VERSION ?? pkg.version),
    COGNITIO_CHANNEL: JSON.stringify(process.env.COGNITIO_CHANNEL ?? "dev"),
    COGNITIO_LIBC: JSON.stringify(process.env.COGNITIO_LIBC ?? "glibc"),
    COGNITIO_MIGRATIONS: JSON.stringify(migrations),
  },
})
if (!result.success) throw new AggregateError(result.logs, "Node runtime build failed")
// This intentionally exposes only the supported desktop embedding boundary;
// internal runtime declarations contain private Effect brands and aren't public.
await Bun.write(path.join(root, "dist/types/src/node.d.ts"), Bun.file(path.join(root, "src/node-api.d.ts")))
console.log(`Built Node runtime (${result.outputs.length} assets, ${migrations.length} migrations)`)
