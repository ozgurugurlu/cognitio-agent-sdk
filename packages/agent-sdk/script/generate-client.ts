/**
 * Generates the vendored cognitio HTTP client under
 * `src/internal/runtime-client/gen`.
 *
 * This is a port of `packages/sdk/js/script/build.ts` with three deliberate
 * differences:
 *
 * 1. **The spec is read, never produced.** `packages/sdk/js` regenerates
 *    `packages/sdk/openapi.json` from the live `packages/runtime` module graph
 *    on every build. This script reads the committed spec instead, so
 *    generating the agent-sdk client never depends on the server package
 *    compiling. `bun run check:openapi` is the separate guard that the
 *    committed spec still matches the server.
 * 2. **Prettier runs through the Node API, not the CLI.** Prettier resolves its
 *    configuration from the *file's* location and, since v3, skips paths listed
 *    in `.gitignore`. Formatting a temp directory through the CLI would
 *    therefore either pick up prettier's defaults (`semi: true`) or be skipped
 *    outright, and `--check` would report drift on every run. Resolving the
 *    config once from a committed path and passing it explicitly makes the
 *    output independent of where it is written.
 * 3. **No `tsc` and no `rm -rf dist`.** `bun run build` owns compilation.
 *
 * Everything else — the three plugin blocks, `clean: true`, and the textual
 * `patchFlatRequiredParams` fix-up — is kept byte-compatible with the low-level
 * script on purpose. The two generated trees must not diverge for
 * generator-configuration reasons; `@hey-api/openapi-ts` is pinned to the same
 * exact version in both packages.
 *
 * Regeneration order is always low-level first:
 *
 *   1. bun ./packages/sdk/js/script/build.ts      (spec + sdk/js client)
 *   2. bun ./packages/agent-sdk/script/generate-client.ts
 *
 * `script/generate.ts` at the repo root runs both in that order.
 */

import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@hey-api/openapi-ts"
import prettier from "prettier"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")
const repoDir = path.resolve(packageDir, "..", "..")

/** The committed OpenAPI document the vendored client is generated from. */
export const SPEC_PATH = path.join(repoDir, "packages", "sdk", "openapi.json")
/** The committed generated tree. */
export const GEN_DIR = path.join(packageDir, "src", "internal", "runtime-client", "gen")
/** Pinned exactly, and identically, in both packages that generate this client. */
export const GENERATOR = "@hey-api/openapi-ts@0.90.10"
/** Timestamp-free provenance sidecar; see `renderProvenance`. */
export const PROVENANCE_FILE = ".provenance.json"
/** Prettier options are resolved from a committed path so temp output matches. */
const PRETTIER_ANCHOR = path.join(packageDir, "src", "index.ts")

/**
 * The one sentence `bun run check:client` prints, reused verbatim by
 * `test/packaging.test.ts` so the unit guard and the CLI twin tell a human the
 * same thing.
 */
export const STALE = "src/internal/runtime-client/gen is stale — run: bun run generate:client"

export interface TreeComparison {
  /** Files present in the freshly generated tree but missing from the committed one. */
  missing: string[]
  /** Files present in the committed tree but not produced by the generator. */
  extra: string[]
  /** Files present in both whose bytes differ. */
  changed: string[]
}

export function isTreeInSync(comparison: TreeComparison): boolean {
  return comparison.missing.length === 0 && comparison.extra.length === 0 && comparison.changed.length === 0
}

/** Renders the drift message with the offending paths, in `STALE`'s style. */
export function describeComparison(comparison: TreeComparison): string {
  const details = [
    comparison.missing.length ? `missing: ${comparison.missing.join(", ")}` : undefined,
    comparison.extra.length ? `unexpected: ${comparison.extra.join(", ")}` : undefined,
    comparison.changed.length ? `changed: ${comparison.changed.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return details.length ? `${STALE}\n  ${details.join("\n  ")}` : STALE
}

/** Deterministic, timestamp-free provenance. A date would defeat byte comparison. */
export function renderProvenance(specBytes: string): string {
  return JSON.stringify({ generator: GENERATOR, specSha256: sha256(specBytes) }, null, 2) + "\n"
}

export function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relative)))
    else files.push(relative)
  }
  return files.sort()
}

/**
 * The textual fix-up ported verbatim from `packages/sdk/js/script/build.ts`.
 *
 * `session.command` needs `arguments` and `command` to be required, which the
 * generator will not emit. The patch is line-fragile by nature, so it throws
 * three distinct errors rather than silently producing a weaker type, and it
 * must run **before** prettier: it matches `;` terminators that prettier
 * (`semi: false`) strips.
 */
export async function patchFlatRequiredParams(genDir: string): Promise<void> {
  const file = path.join(genDir, "sdk.gen.ts")
  const source = await readFile(file, "utf8")
  const start = source.indexOf("public command<ThrowOnError extends boolean = false>(")
  if (start === -1) throw new Error("Unable to find generated session.command method")
  const nextComment = source.slice(start + 1).search(/\n\s+\/\*\*/)
  const end = nextComment === -1 ? -1 : start + 1 + nextComment
  if (end === -1) throw new Error("Unable to find end of generated session.command method")
  const block = source.slice(start, end)
  const patched = block
    .replace(/(\n\s*)arguments\?: string;/, "$1arguments: string;")
    .replace(/(\n\s*)command\?: string;/, "$1command: string;")
  if (patched === block || patched.includes("arguments?: string;") || patched.includes("command?: string;")) {
    throw new Error("Unable to patch generated session.command required fields")
  }
  await writeFile(file, source.slice(0, start) + patched + source.slice(end))
}

/**
 * Generates the client into `outDir` and leaves it prettier-canonical.
 *
 * The plugin configuration is load-bearing: `instance`, `auth`,
 * `paramsStructure` and `baseUrl` all change the emitted API shape, and
 * `tsConfigPath` decides the emitted specifier style. Changing any of them is a
 * breaking change to the vendored surface, not a formatting preference.
 */
export async function generateClientTo(outDir: string, specPath = SPEC_PATH): Promise<void> {
  const specBytes = await readFile(specPath, "utf8")
  await mkdir(outDir, { recursive: true })
  await createClient({
    input: specPath,
    output: {
      path: outDir,
      tsConfigPath: path.join(packageDir, "tsconfig.json"),
      clean: true,
    },
    logs: { level: "silent" },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        instance: "CognitioClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })

  await patchFlatRequiredParams(outDir)

  const options = await prettier.resolveConfig(PRETTIER_ANCHOR)
  for (const relative of await listFiles(outDir)) {
    const file = path.join(outDir, relative)
    const source = await readFile(file, "utf8")
    await writeFile(file, await prettier.format(source, { ...options, filepath: file }))
  }

  await writeFile(path.join(outDir, PROVENANCE_FILE), renderProvenance(specBytes))
}

/** Generates into a temp directory and byte-compares against the committed tree. */
export async function checkGeneratedClient(specPath = SPEC_PATH): Promise<TreeComparison> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-sdk-gen-check-"))
  try {
    const fresh = path.join(temp, "gen")
    await generateClientTo(fresh, specPath)
    const [freshFiles, committedFiles] = await Promise.all([
      listFiles(fresh),
      listFiles(GEN_DIR).catch(() => [] as string[]),
    ])
    const committed = new Set(committedFiles)
    const comparison: TreeComparison = {
      missing: freshFiles.filter((file) => !committed.has(file)),
      extra: committedFiles.filter((file) => !freshFiles.includes(file)),
      changed: [],
    }
    for (const relative of freshFiles) {
      if (!committed.has(relative)) continue
      const [a, b] = await Promise.all([
        readFile(path.join(fresh, relative), "utf8"),
        readFile(path.join(GEN_DIR, relative), "utf8"),
      ])
      if (a !== b) comparison.changed.push(relative)
    }
    return comparison
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function parseArguments(args: string[]) {
  const meaningful = args.filter((arg) => arg !== "--")
  const specs = meaningful.filter((arg) => arg.startsWith("--spec="))
  const unknown = meaningful.filter((arg) => arg !== "--check" && !arg.startsWith("--spec="))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  if (specs.length > 1) throw new Error("--spec may be provided only once")
  if (meaningful.filter((arg) => arg === "--check").length > 1) throw new Error("--check may be provided only once")
  const spec = specs[0]?.slice("--spec=".length)
  if (spec === "") throw new Error("--spec must not be empty")
  return { check: meaningful.includes("--check"), spec: spec === undefined ? SPEC_PATH : path.resolve(spec) }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.check) {
    const comparison = await checkGeneratedClient(args.spec)
    if (!isTreeInSync(comparison)) throw new Error(describeComparison(comparison))
    console.log("src/internal/runtime-client/gen is current")
    return
  }
  await generateClientTo(GEN_DIR, args.spec)
  console.log(`Generated ${path.relative(packageDir, GEN_DIR)} from ${path.relative(repoDir, args.spec)}`)
}

if (import.meta.main) await main()
