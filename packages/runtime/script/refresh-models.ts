#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { rename } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { source: { type: "string", default: "https://models.dev/api.json" }, check: { type: "boolean" } },
})
process.env.COGNITIO_DISABLE_MODELS_FETCH = "1"
const { parseCatalog } = await import("../src/provider/models")
const directory = fileURLToPath(new URL("../", import.meta.url))
const source = values.source!
const bytes = /^https?:\/\//.test(source)
  ? await fetch(source, { signal: AbortSignal.timeout(30_000) }).then((response) => {
      if (!response.ok) throw new Error(`Model catalog refresh failed: HTTP ${response.status}`)
      return response.text()
    })
  : await Bun.file(path.resolve(source)).text()
const catalog = parseCatalog(JSON.parse(bytes))
const serialized = JSON.stringify(catalog, null, 2) + "\n"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const metadata =
  JSON.stringify(
    {
      source: /^https?:\/\//.test(source)
        ? source
        : path.relative(directory, path.resolve(source)).replaceAll(path.sep, "/"),
      upstream: "https://models.dev/api.json",
      sourceSha256: digest(bytes),
      catalogSha256: digest(serialized),
      providers: Object.keys(catalog).length,
    },
    null,
    2,
  ) + "\n"
for (const [name, content] of [
  ["models-catalog.json", serialized],
  ["models-catalog.meta.json", metadata],
]) {
  const target = path.join(directory, "script", name)
  if (values.check) {
    if ((await Bun.file(target).text()) !== content) throw new Error(`${name} differs from the validated source`)
    continue
  }
  const temporary = `${target}.${process.pid}.tmp`
  await Bun.write(temporary, content)
  await rename(temporary, target)
}
console.log(`Validated ${Object.keys(catalog).length} catalog providers (${digest(serialized)})`)
