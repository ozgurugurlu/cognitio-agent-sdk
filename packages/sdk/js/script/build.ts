#!/usr/bin/env bun
import { $ } from "bun"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@hey-api/openapi-ts"
import prettier from "prettier"

const dir = fileURLToPath(new URL("..", import.meta.url))
const openapi = path.resolve(dir, "../openapi.json")
const generated = path.join(dir, "src/v2/gen")

async function files(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const relative = path.join(prefix, entry.name)
        return entry.isDirectory() ? files(root, relative) : [relative]
      }),
    )
  )
    .flat()
    .sort()
}

export async function generateClientTo(output: string, spec = openapi) {
  await createClient({
    input: spec,
    output: { path: output, tsConfigPath: path.join(dir, "tsconfig.json"), clean: true },
    logs: { level: "silent" },
    plugins: [
      { name: "@hey-api/typescript", exportFromIndex: false },
      {
        name: "@hey-api/sdk",
        instance: "CognitioClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      { name: "@hey-api/client-fetch", exportFromIndex: false, baseUrl: "http://localhost:4096" },
    ],
  })
  await patchFlatRequiredParams(output)
  const options = await prettier.resolveConfig(path.join(dir, "src/index.ts"))
  await Promise.all(
    (await files(output)).map(async (relative) => {
      const file = path.join(output, relative)
      await Bun.write(file, await prettier.format(await Bun.file(file).text(), { ...options, filepath: file }))
    }),
  )
}

/** Regenerate in a temporary directory; never modify committed files in check mode. */
export async function checkGeneratedClient(committed = generated, spec = openapi) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cognitio-sdk-check-"))
  try {
    await generateClientTo(temporary, spec)
    const freshFiles = await files(temporary)
    const committedFiles = await files(committed).catch(() => [] as string[])
    const freshSet = new Set(freshFiles)
    const committedSet = new Set(committedFiles)
    const changed = await Promise.all(
      freshFiles
        .filter((file) => committedSet.has(file))
        .map(async (file) =>
          (await Bun.file(path.join(temporary, file)).text()) === (await Bun.file(path.join(committed, file)).text())
            ? []
            : [file],
        ),
    )
    return {
      missing: freshFiles.filter((file) => !committedSet.has(file)),
      extra: committedFiles.filter((file) => !freshSet.has(file)),
      changed: changed.flat(),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function patchFlatRequiredParams(output: string) {
  const file = path.join(output, "sdk.gen.ts")
  const source = await Bun.file(file).text()
  const start = source.indexOf("public command<ThrowOnError extends boolean = false>(")
  if (start === -1) throw new Error("Unable to find generated session.command method")
  const nextComment = source.slice(start + 1).search(/\n\s+\/\*\*/)
  const end = nextComment === -1 ? -1 : start + 1 + nextComment
  if (end === -1) throw new Error("Unable to find end of generated session.command method")
  const block = source.slice(start, end)
  const patched = block
    .replace(/(\n\s*)arguments\?: string;/, "$1arguments: string;")
    .replace(/(\n\s*)command\?: string;/, "$1command: string;")
  if (patched === block || patched.includes("arguments?: string;") || patched.includes("command?: string;"))
    throw new Error("Unable to patch generated session.command required fields")
  await Bun.write(file, source.slice(0, start) + patched + source.slice(end))
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  if (args.some((arg) => arg !== "--check")) throw new Error(`Unknown build argument: ${args.join(" ")}`)
  if (args.includes("--check")) {
    const comparison = await checkGeneratedClient()
    if (Object.values(comparison).some((entries) => entries.length))
      throw new Error(`src/v2/gen is stale — run: bun run build\n${JSON.stringify(comparison, null, 2)}`)
    console.log("src/v2/gen is current")
    return
  }
  await $`bun dev generate > ${openapi}`.cwd(path.resolve(dir, "../../runtime"))
  await generateClientTo(generated)
  await rm(path.join(dir, "dist"), { recursive: true, force: true })
  await $`bun tsc`.cwd(dir)
}

if (import.meta.main) await main()
