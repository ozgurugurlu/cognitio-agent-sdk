import { compile } from "@mdx-js/mdx"
import { readdir, readFile, stat, lstat } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const openapi = path.join(root, "openapi.json")
const specification = await readFile(openapi)
if (
  !(await lstat(openapi)).isFile() ||
  !specification.equals(await readFile(path.resolve(root, "../sdk/openapi.json")))
)
  throw new Error("Documentation OpenAPI copy is stale or is not a regular file; run bun run generate")
const config = JSON.parse(await readFile(path.join(root, "docs.json"), "utf8"))
const pages = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(pages)
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "pages" && Array.isArray(entry)
      ? entry.flatMap((page) => (typeof page === "string" ? [page] : pages(page)))
      : pages(entry),
  )
}
for (const page of pages(config.navigation)) await stat(path.join(root, `${page}.mdx`))
const files = (await readdir(root, { recursive: true })).filter(
  (file) => file.endsWith(".mdx") && !file.startsWith("node_modules/") && !file.startsWith(".mintlify/"),
)
for (const file of files) {
  const text = await readFile(path.join(root, file), "utf8")
  if (!/^---\ntitle: .+\n/.test(text) && !file.startsWith("snippets/")) throw new Error(`${file}: missing page title`)
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  await compile(body)
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1]!.split("#")[0]!
    if (!href || /^(https?:|mailto:)/.test(href)) continue
    const target = href.startsWith("/")
      ? path.join(root, href)
      : path.resolve(path.dirname(path.join(root, file)), href)
    await stat(path.extname(target) ? target : `${target}.mdx`).catch(() => {
      throw new Error(`${file}: broken link ${href}`)
    })
  }
}
const spec = JSON.parse(specification.toString("utf8"))
if (!spec.paths?.["/session/{sessionID}/runtime-config"])
  throw new Error("HTTP reference must use the local runtime OpenAPI document")
console.log(`Validated ${files.length} MDX pages, navigation, local links and runtime OpenAPI`)
