import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "..")
const pages = (await readdir(root, { recursive: true })).filter(
  (file) => file.endsWith(".mdx") && !/^(api-reference|node_modules|\.mintlify)\//.test(file),
)
const files = new Map<string, { text: string; page: string; block: number; offset: number }>()
const bindings = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindings(element.name)))

for (const page of [...pages, "../../README.md", "../agent-sdk/README.md"]) {
  const content = await readFile(path.join(root, page), "utf8")
  const blocks = [...content.matchAll(/```(?:ts|typescript|js|javascript)\s*\n([\s\S]*?)```/g)]
  for (const [index, block] of blocks.entries()) {
    const code = block[1]!
    const source = ts.createSourceFile("snippet.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declared = new Set(
      source.statements.flatMap((statement): string[] => {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause
          return [
            ...(clause?.name ? [clause.name.text] : []),
            ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
              ? clause.namedBindings.elements.map((item) => item.name.text)
              : clause?.namedBindings
                ? [clause.namedBindings.name.text]
                : []),
          ]
        }
        if (ts.isVariableStatement(statement))
          return statement.declarationList.declarations.flatMap((item) => bindings(item.name))
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
          return [statement.name.text]
        return []
      }),
    )
    // Partial guide snippets assume these established bindings. Their actual API
    // types come from the public declaration build; snippet bodies are untouched.
    const symbols = [
      "Agent",
      "query",
      "shutdown",
      "createAgentClient",
      "defineAgent",
      "defineTool",
      "defineHook",
      "defineSkill",
      "defineCommand",
      "definePlugin",
      "defineOutputFormat",
      "createSdkMcpServer",
      "PermissionDecision",
      "models",
    ].filter((name) => !declared.has(name))
    const prelude =
      [
        `import { ${symbols.join(", ")} } from "cognitio-agent-sdk"`,
        ...(!declared.has("z") ? ['import { z } from "zod"'] : []),
        ...Object.entries({ agent: "Agent", session: "Session", client: "AgentClient" })
          .filter(([name]) => !declared.has(name))
          .map(([name, type]) => `declare const ${name}: import("cognitio-agent-sdk").${type}`),
      ].join("\n") + "\n"
    files.set(path.join(root, `.snippet-${files.size}.ts`), {
      text: prelude + code,
      page,
      block: index + 1,
      offset: prelude.split("\n").length - 1,
    })
  }
}
if (!files.size) throw new Error("No guide snippets found")
const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  baseUrl: root,
  paths: {
    "cognitio-agent-sdk": ["../agent-sdk/dist/index.d.ts"],
    zod: ["../agent-sdk/node_modules/zod/index.d.cts"],
  },
  typeRoots: [path.join(root, "../agent-sdk/node_modules/@types")],
  types: ["node"],
}
const host = ts.createCompilerHost(options)
const read = host.readFile.bind(host)
const exists = host.fileExists.bind(host)
host.readFile = (file) => files.get(file)?.text ?? read(file)
host.fileExists = (file) => files.has(file) || exists(file)
const program = ts.createProgram([...files.keys()], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
for (const diagnostic of diagnostics) {
  const item = diagnostic.file ? files.get(diagnostic.file.fileName) : undefined
  const location =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined
  const label = item
    ? `${item.page} block ${item.block}:${Math.max(1, (location?.line ?? 0) - item.offset + 1)}`
    : (diagnostic.file?.fileName ?? "TypeScript")
  console.error(`${label}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)
}
if (diagnostics.length) process.exit(1)
console.log(`Typechecked ${files.size} literal guide/README snippets against the public SDK declarations`)
