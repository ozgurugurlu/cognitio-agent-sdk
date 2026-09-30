import { Application } from "typedoc"
import ts from "typescript"
import path from "node:path"
import os from "node:os"
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, cp, lstat } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "..")
const sdk = path.resolve(root, "../agent-sdk")
const checking = process.argv.includes("--check")
if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Expected only --check")
const openapi = path.join(root, "openapi.json")
const specification = await readFile(path.resolve(root, "../sdk/openapi.json"))
if (checking && (!(await lstat(openapi)).isFile() || !(await readFile(openapi)).equals(specification)))
  throw new Error("Documentation OpenAPI copy is stale or is not a regular file; run bun run generate")
const temporary = await mkdtemp(path.join(os.tmpdir(), "cognitio-reference-"))
process.chdir(root)

try {
  const app = await Application.bootstrapWithPlugins({ options: path.join(root, "typedoc.json") })
  // Raw wire types are documented from generated source alongside TypeDoc.
  // Resolving actual supplementary pages keeps notExported validation strict.
  const sources = new Map<string, ts.SourceFile>()
  for (const file of ["src/internal/runtime-client/gen/types.gen.ts", "src/types.ts", "src/tools/mcp-server.ts"]) {
    sources.set(
      file,
      ts.createSourceFile(file, await readFile(path.join(sdk, file), "utf8"), ts.ScriptTarget.Latest, true),
    )
  }
  const supplemental = new Map<
    string,
    { source: ts.SourceFile; node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration; page: string }
  >()
  const register = (file: string, name: string): string | undefined => {
    const key = `${file}:${name}`
    const existing = supplemental.get(key)
    if (existing) return `/api-reference/${existing.page}`
    const source = sources.get(file)
    const node = source?.statements.find(
      (node): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === name,
    )
    if (!source || !node) return
    const page = `${file.includes("/gen/") ? "protocol" : "supporting"}/${name}`
    supplemental.set(key, { source, node, page })
    const visit = (child: ts.Node) => {
      if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) register(file, child.typeName.text)
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
    return `/api-reference/${page}`
  }
  app.converter.addUnknownSymbolResolver((_ref, _owner, _part, symbol) => {
    if (symbol?.packageName !== "cognitio-agent-sdk") return
    if (
      symbol.packagePath === "src/internal/runtime-client/gen/sdk.gen.ts" &&
      symbol.qualifiedName === "CognitioClient"
    )
      return "/http-api/overview"
    return register(symbol.packagePath, symbol.qualifiedName)
  })
  const project = await app.convert()
  if (!project) throw new Error("TypeDoc could not convert the public SDK")
  app.validate(project)
  if (app.logger.hasErrors() || app.logger.hasWarnings()) throw new Error("Public API documentation validation failed")
  app.options.setValue("out", temporary)
  await app.generateOutputs(project)
  for (const file of (await readdir(temporary, { recursive: true })).filter((file) => file.endsWith(".mdx"))) {
    const target = path.join(temporary, file)
    const source = (await readFile(target, "utf8")).replace(/[ \t]+$/gm, "")
    const title = source.match(/^# (.+)$/m)?.[1]?.replace(/\\/g, "") ?? path.basename(file, ".mdx")
    await writeFile(
      target,
      `---\ntitle: ${JSON.stringify(title)}\ndescription: "Generated from the public TypeScript API."\n---\n\n${source.replace(/^# .+\n/m, "").replace(/\]\(([^)]+)\.mdx(#[^)]*)?\)/g, "]($1$2)")}`,
    )
  }
  for (const entry of supplemental.values()) {
    const dependencies = new Set<string>()
    const visit = (node: ts.Node) => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text !== entry.node.name.text
      ) {
        const dependency = supplemental.get(`${entry.source.fileName}:${node.typeName.text}`)
        if (dependency) dependencies.add(`[${node.typeName.text}](/api-reference/${dependency.page})`)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(entry.node, visit)
    await mkdir(path.dirname(path.join(temporary, entry.page)), { recursive: true })
    await writeFile(
      path.join(temporary, `${entry.page}.mdx`),
      `---\ntitle: ${JSON.stringify(entry.node.name.text)}\ndescription: "Exact type definition referenced by the public SDK."\n---\n\nThis definition is generated from the same source as the SDK. Protocol types describe the runtime HTTP API; prefer the high-level SDK for session ownership and callbacks.\n\n\`\`\`ts\n${entry.node.getText(entry.source)}\n\`\`\`\n${dependencies.size ? `\nRelated types: ${[...dependencies].sort().join(", ")}.\n` : ""}`,
    )
  }
  const files = (await readdir(temporary, { recursive: true })).filter((file) => file.endsWith(".mdx")).sort()
  const config = JSON.parse(await readFile(path.join(root, "docs.json"), "utf8"))
  const tab = config.navigation.tabs.find((item: { tab: string }) => item.tab === "API reference")
  if (!tab) throw new Error("docs.json must declare the API reference tab")
  tab.groups = [
    { group: "Public API", pages: ["api-reference/index"] },
    ...["classes", "functions", "interfaces", "type-aliases", "variables", "protocol", "supporting"].flatMap(
      (folder) => {
        const pages = files
          .filter((file) => file.startsWith(`${folder}/`))
          .map((file) => `api-reference/${file.slice(0, -4)}`)
        return pages.length
          ? [{ group: folder.replace("type-aliases", "Types").replace(/^./, (letter) => letter.toUpperCase()), pages }]
          : []
      },
    ),
  ]
  const navigation = JSON.stringify(config, null, 2) + "\n"
  if (checking) {
    const committed = path.join(root, "api-reference")
    const previous = (await readdir(committed, { recursive: true })).filter((file) => file.endsWith(".mdx")).sort()
    if (JSON.stringify(previous) !== JSON.stringify(files))
      throw new Error("API reference inventory is stale; run bun run generate")
    for (const file of files) {
      if ((await readFile(path.join(committed, file), "utf8")) !== (await readFile(path.join(temporary, file), "utf8")))
        throw new Error(`API reference is stale: ${file}; run bun run generate`)
    }
    if (navigation !== (await readFile(path.join(root, "docs.json"), "utf8")))
      throw new Error("API navigation is stale; run bun run generate")
  } else {
    await rm(path.join(root, "api-reference"), { recursive: true, force: true })
    await cp(temporary, path.join(root, "api-reference"), { recursive: true })
    await writeFile(path.join(root, "docs.json"), navigation)
    // Remove a previous symlink before writing the self-contained documentation copy.
    await rm(openapi, { force: true })
    await writeFile(openapi, specification)
  }
  console.log(`${checking ? "Verified" : "Generated"} ${files.length} public API and protocol pages`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
