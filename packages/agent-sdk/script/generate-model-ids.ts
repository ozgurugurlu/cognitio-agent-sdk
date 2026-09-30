/**
 * Generates the curated model-id completion surface for the Agent SDK.
 *
 * Why the scope is 27 reviewed providers rather than the whole catalog, in
 * numbers measured from live models.dev api.json on 2026-07-28 (173 providers,
 * 5,802 provider/model pairs):
 *
 * - Noise: those 5,802 pairs carry only 2,861 distinct model names, so 2,941 of
 *   them (51%) are aggregator pass-throughs — a name another provider already
 *   lists. Zero ids contain a literal space today, but an older 105-provider /
 *   4,108-pair catalog (the stale cognitio test fixture, newest release_date
 *   2026-03-30) had 16 such ids under nano-gpt. That is why `validateId`
 *   hard-fails on whitespace instead of trusting the feed.
 * - Cost: unioning all 5,802 pairs in this file's shape (plus the same eight
 *   per-provider unions, unfiltered) emits 212,700 bytes of `.d.ts` and makes
 *   tsserver answer one `KnownModelId` completion with 1,168,368 bytes across
 *   5,802 entries — per keystroke. The committed selection emits 35,550 bytes
 *   of `.d.ts` and 162,342 bytes across 808 entries: ~6x and ~7x less
 *   (TypeScript 5.8.2 declaration emit and `completionInfo` response body).
 * - Scale check: @ai-sdk/gateway@4.0.30 ships a comparable union of 205 string
 *   literals plus `(string & {})`, so a curated few hundred is the norm.
 *
 * The committed snapshot therefore holds 1,043 candidate models across those 27
 * providers, of which 808 pass the tool/text/status policy applied by
 * `selectModelIds`. Unknown and newly released ids remain accepted through
 * `ModelId`.
 *
 * Refreshing is an explicit, network-capable maintenance action. Normal
 * generation and drift checking read only the committed, pruned snapshot.
 */

import { createHash } from "node:crypto"
import { rename } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseModel } from "../src/internal/runtime-config.js"

export const MODEL_PROVIDERS = [
  "amazon-bedrock",
  "anthropic",
  "azure",
  "cerebras",
  "cohere",
  "deepinfra",
  "deepseek",
  "fireworks-ai",
  "github-copilot",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "groq",
  "llama",
  "lmstudio",
  "minimax",
  "mistral",
  "moonshotai",
  "ollama-cloud",
  "openai",
  "openrouter",
  "togetherai",
  "upstage",
  "xai",
  "zai",
  "zai-coding-plan",
] as const

export type ModelProvider = (typeof MODEL_PROVIDERS)[number]
export type ModelStatus = "alpha" | "beta" | "deprecated"

export interface SnapshotModel {
  id: string
  tool_call: boolean
  output: string[]
  status?: ModelStatus
}

export interface SnapshotProvider {
  env: string[]
  models: SnapshotModel[]
}

export interface ModelSnapshot {
  version: 1
  providers: Record<string, SnapshotProvider>
}

export interface SelectedModelIds {
  all: string[]
  byProvider: Record<string, string[]>
  rawCount: number
}

const HELPERS = [
  ["anthropic", "AnthropicModelId"],
  ["openai", "OpenaiModelId"],
  ["google", "GoogleModelId"],
  ["xai", "XaiModelId"],
  ["groq", "GroqModelId"],
  ["mistral", "MistralModelId"],
  ["deepseek", "DeepseekModelId"],
] as const

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")
const snapshotPath = path.join(scriptDir, "models-snapshot.json")
const generatedPath = path.join(packageDir, "src", "models.generated.ts")

export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`)
  }
  return [...new Set(value)].sort(compareCodeUnits) as string[]
}

function status(value: unknown, name: string): ModelStatus | undefined {
  if (value === undefined) return
  if (value === "alpha" || value === "beta" || value === "deprecated") return value
  throw new Error(`${name} must be alpha, beta, deprecated, or absent`)
}

function validateId(provider: string, model: string): string {
  const id = `${provider}/${model}`
  if (/["\\\s]/u.test(id)) {
    throw new Error(`Model id ${JSON.stringify(id)} must not contain quotes, backslashes, or whitespace`)
  }
  const parsed = parseModel(id)
  if (parsed.providerID !== provider || parsed.modelID !== model) {
    throw new Error(`Model id ${JSON.stringify(id)} does not round-trip through parseModel`)
  }
  return id
}

function canonicalModel(model: SnapshotModel): SnapshotModel {
  return {
    id: model.id,
    tool_call: model.tool_call,
    output: [...new Set(model.output)].sort(compareCodeUnits),
    ...(model.status !== undefined ? { status: model.status } : {}),
  }
}

function validateSnapshot(value: unknown): ModelSnapshot {
  const root = record(value, "snapshot")
  if (root.version !== 1) throw new Error("snapshot.version must be 1")
  const providers = record(root.providers, "snapshot.providers")
  const actualProviders = Object.keys(providers).sort(compareCodeUnits)
  const expectedProviders = [...MODEL_PROVIDERS].sort(compareCodeUnits)
  if (
    actualProviders.length !== expectedProviders.length ||
    actualProviders.some((provider, index) => provider !== expectedProviders[index])
  ) {
    throw new Error(`snapshot.providers must contain exactly: ${expectedProviders.join(", ")}`)
  }

  const normalized = Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => {
      const source = record(providers[provider], `snapshot.providers.${provider}`)
      const env = strings(source.env, `snapshot.providers.${provider}.env`)
      if (!Array.isArray(source.models)) {
        throw new Error(`snapshot.providers.${provider}.models must be an array`)
      }
      const models = source.models
        .map((value, index) => {
          const model = record(value, `snapshot.providers.${provider}.models[${index}]`)
          if (typeof model.id !== "string" || model.id.length === 0) {
            throw new Error(`snapshot.providers.${provider}.models[${index}].id must be a non-empty string`)
          }
          if (typeof model.tool_call !== "boolean") {
            throw new Error(`snapshot.providers.${provider}.models[${index}].tool_call must be boolean`)
          }
          validateId(provider, model.id)
          return canonicalModel({
            id: model.id,
            tool_call: model.tool_call,
            output: strings(model.output, `snapshot.providers.${provider}.models[${index}].output`),
            ...(model.status !== undefined
              ? { status: status(model.status, `snapshot.providers.${provider}.models[${index}].status`) }
              : {}),
          })
        })
        .sort((a, b) => compareCodeUnits(a.id, b.id))
      if (models.length === 0) throw new Error(`snapshot provider ${provider} has no models`)
      if (models.some((model, index) => index > 0 && model.id === models[index - 1]?.id)) {
        throw new Error(`snapshot provider ${provider} contains duplicate model ids`)
      }
      return [provider, { env, models }]
    }),
  )
  return { version: 1, providers: normalized }
}

/**
 * Validates and prunes a full models.dev catalog to the reviewed provider set
 * and the fields required to reapply the selection policy.
 */
export function pruneCatalog(value: unknown): ModelSnapshot {
  const catalog = record(value, "models.dev catalog")
  const snapshot = {
    version: 1 as const,
    providers: Object.fromEntries(
      MODEL_PROVIDERS.map((provider) => {
        const source = record(catalog[provider], `models.dev provider ${provider}`)
        if (source.id !== provider) throw new Error(`models.dev provider key/id mismatch for ${provider}`)
        const sourceModels = record(source.models, `models.dev provider ${provider}.models`)
        return [
          provider,
          {
            env: strings(source.env, `models.dev provider ${provider}.env`),
            models: Object.entries(sourceModels)
              .map(([modelKey, value]) => {
                const model = record(value, `models.dev model ${provider}/${modelKey}`)
                if (model.id !== modelKey)
                  throw new Error(`models.dev model key/id mismatch for ${provider}/${modelKey}`)
                if (typeof model.tool_call !== "boolean") {
                  throw new Error(`models.dev model ${provider}/${modelKey}.tool_call must be boolean`)
                }
                const modalities =
                  model.modalities === undefined
                    ? undefined
                    : record(model.modalities, `models.dev model ${provider}/${modelKey}.modalities`)
                validateId(provider, modelKey)
                return canonicalModel({
                  id: modelKey,
                  tool_call: model.tool_call,
                  output:
                    modalities?.output === undefined
                      ? []
                      : strings(modalities.output, `models.dev model ${provider}/${modelKey}.modalities.output`),
                  ...(model.status !== undefined
                    ? { status: status(model.status, `models.dev model ${provider}/${modelKey}.status`) }
                    : {}),
                })
              })
              .sort((a, b) => compareCodeUnits(a.id, b.id)),
          },
        ]
      }),
    ),
  }
  const result = validateSnapshot(snapshot)
  selectModelIds(result)
  return result
}

/** Applies the reviewed tool/text/status policy to a pruned snapshot. */
export function selectModelIds(value: ModelSnapshot): SelectedModelIds {
  const snapshot = validateSnapshot(value)
  const byProvider = Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => {
      const selected = snapshot.providers[provider]!.models.filter(
        (model) =>
          model.tool_call && model.output.includes("text") && model.status !== "deprecated" && model.status !== "alpha",
      )
        .map((model) => model.id)
        .sort(compareCodeUnits)
      if (selected.length === 0) throw new Error(`snapshot provider ${provider} has no models after filtering`)
      return [provider, selected]
    }),
  )
  const all = MODEL_PROVIDERS.flatMap((provider) =>
    byProvider[provider]!.map((model) => validateId(provider, model)),
  ).sort(compareCodeUnits)
  if (new Set(all).size !== all.length) throw new Error("selected model ids contain duplicates")
  return {
    all,
    byProvider,
    rawCount: MODEL_PROVIDERS.reduce((total, provider) => total + snapshot.providers[provider]!.models.length, 0),
  }
}

/** Renders the canonical, review-friendly snapshot (one model per line). */
export function renderSnapshot(value: ModelSnapshot): string {
  const snapshot = validateSnapshot(value)
  const providers = MODEL_PROVIDERS.map((provider, providerIndex) => {
    const entry = snapshot.providers[provider]!
    const models = entry.models.map(
      (model, modelIndex) =>
        `        ${JSON.stringify(canonicalModel(model))}${modelIndex === entry.models.length - 1 ? "" : ","}`,
    )
    return [
      `    ${JSON.stringify(provider)}: {`,
      `      "env": ${JSON.stringify(entry.env)},`,
      '      "models": [',
      ...models,
      "      ]",
      `    }${providerIndex === MODEL_PROVIDERS.length - 1 ? "" : ","}`,
    ].join("\n")
  })
  return ["{", '  "version": 1,', '  "providers": {', ...providers, "  }", "}", ""].join("\n")
}

function union(name: string, values: string[], description: string): string {
  return [
    "/**",
    ` * ${description}`,
    " *",
    " * This is an editor-completion snapshot, not a runtime availability check.",
    " *",
    " * @example",
    " * ```ts",
    ` * const model: ${name} = ${JSON.stringify(values[0])}`,
    " * ```",
    " */",
    `export type ${name} =`,
    ...values.map((value) => `  | ${JSON.stringify(value)}`),
    "",
  ].join("\n")
}

/** Renders the type-only completion surface. No model arrays reach runtime JS. */
export function renderModelIds(value: ModelSnapshot, bytes = renderSnapshot(value)): string {
  const snapshot = validateSnapshot(value)
  const canonical = renderSnapshot(snapshot)
  if (bytes !== canonical) throw new Error("models snapshot is not in canonical form")
  const selected = selectModelIds(snapshot)
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12)
  return [
    "/**",
    " * Generated by script/generate-model-ids.ts. Do not edit.",
    ` * Snapshot: sha256:${digest}; providers: ${MODEL_PROVIDERS.length}; candidates: ${selected.rawCount}; selected: ${selected.all.length}.`,
    ' * Policy: reviewed providers; tool_call === true; modalities.output includes "text";',
    ' * status is neither "deprecated" nor "alpha" (beta/preview models are retained).',
    " */",
    "",
    union("KnownModelId", selected.all, "Curated, fully-qualified model ids known to the committed snapshot."),
    ...HELPERS.map(([provider, name]) =>
      union(name, selected.byProvider[provider]!, `Curated ${provider} model names without the provider prefix.`),
    ),
  ].join("\n")
}

/** Parses and validates a committed snapshot. */
export function parseSnapshot(bytes: string): ModelSnapshot {
  return validateSnapshot(JSON.parse(bytes) as unknown)
}

async function atomicWrite(target: string, bytes: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`
  await Bun.write(temporary, bytes)
  await rename(temporary, target)
}

function parseArguments(args: string[]) {
  const meaningful = args.filter((arg) => arg !== "--")
  const sources = meaningful.filter((arg) => arg.startsWith("--source="))
  const unknown = meaningful.filter((arg) => arg !== "--check" && arg !== "--refresh" && !arg.startsWith("--source="))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)
  if (sources.length > 1) throw new Error("--source may be provided only once")
  const check = meaningful.includes("--check")
  const refresh = meaningful.includes("--refresh")
  if (meaningful.filter((arg) => arg === "--check").length > 1) throw new Error("--check may be provided only once")
  if (meaningful.filter((arg) => arg === "--refresh").length > 1) {
    throw new Error("--refresh may be provided only once")
  }
  if (check && refresh) throw new Error("--check and --refresh cannot be combined")
  const source = sources[0]?.slice("--source=".length)
  if (source === "") throw new Error("--source must not be empty")
  if (source !== undefined && !refresh) throw new Error("--source requires --refresh")
  return { check, refresh, source }
}

async function readRefreshSource(source: string): Promise<string> {
  if (path.isAbsolute(source) || !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)) {
    return Bun.file(path.resolve(source)).text()
  }
  const url = new URL(source)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported --source protocol: ${url.protocol}`)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Failed to refresh models from ${url.origin}: HTTP ${response.status}`)
  return response.text()
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.refresh) {
    const source = args.source ?? process.env.MODELS_DEV_API_JSON ?? "https://models.dev/api.json"
    const snapshot = pruneCatalog(JSON.parse(await readRefreshSource(source)) as unknown)
    await atomicWrite(snapshotPath, renderSnapshot(snapshot))
    console.log(`Refreshed ${path.relative(packageDir, snapshotPath)} from ${source}; run: bun run generate:models`)
    return
  }

  const bytes = await Bun.file(snapshotPath).text()
  const output = renderModelIds(parseSnapshot(bytes), bytes)
  if (args.check) {
    if (!(await Bun.file(generatedPath).exists()) || (await Bun.file(generatedPath).text()) !== output) {
      throw new Error("src/models.generated.ts is stale — run: bun run generate:models")
    }
    console.log("src/models.generated.ts is current")
    return
  }
  await atomicWrite(generatedPath, output)
  console.log(`Generated ${path.relative(packageDir, generatedPath)}`)
}

if (import.meta.main) await main()
