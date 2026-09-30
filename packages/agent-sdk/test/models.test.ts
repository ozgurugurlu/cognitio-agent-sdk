import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { models } from "../src/index.js"
import { parseModel } from "../src/internal/runtime-config.js"
import {
  MODEL_PROVIDERS,
  compareCodeUnits,
  type ModelSnapshot,
  parseSnapshot,
  pruneCatalog,
  renderModelIds,
  renderSnapshot,
  selectModelIds,
} from "../script/generate-model-ids.js"

const snapshotFile = Bun.file(`${import.meta.dir}/../script/models-snapshot.json`)
const generatedFile = Bun.file(`${import.meta.dir}/../src/models.generated.ts`)
// Same sentence `bun run check:models` prints, so the unit test and the CLI
// twin tell a human the same thing.
const STALE = "src/models.generated.ts is stale — run: bun run generate:models"

interface SourceModel {
  id: string
  tool_call: boolean
  modalities: { output: string[] }
  status?: string
}

type SourceCatalog = Record<string, { id: string; env: string[]; models: Record<string, SourceModel> }>

/** Re-expands a pruned snapshot into the models.dev catalog shape `pruneCatalog` consumes. */
function sourceCatalog(snapshot: ModelSnapshot): SourceCatalog {
  return Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => [
      provider,
      {
        id: provider,
        env: snapshot.providers[provider]!.env,
        models: Object.fromEntries(
          snapshot.providers[provider]!.models.map((model) => [
            model.id,
            {
              id: model.id,
              tool_call: model.tool_call,
              modalities: { output: model.output },
              ...(model.status !== undefined ? { status: model.status } : {}),
            },
          ]),
        ),
      },
    ]),
  )
}

describe("curated model ids", () => {
  test("committed snapshot and generated types are canonical and byte-stable", async () => {
    const snapshotBytes = await snapshotFile.text()
    const snapshot = parseSnapshot(snapshotBytes)
    const generated = await generatedFile.text()
    const selected = selectModelIds(snapshot)
    const digest = createHash("sha256").update(snapshotBytes).digest("hex").slice(0, 12)

    // Still byte-for-byte, but a boolean carries the actionable message instead
    // of printing an 800-line union diff on the one failure that matters.
    const canonicalSnapshot = "script/models-snapshot.json is not in canonical form"
    expect(renderSnapshot(snapshot) === snapshotBytes, canonicalSnapshot).toBe(true)
    expect(renderModelIds(snapshot, snapshotBytes) === generated, STALE).toBe(true)
    expect(generated).toContain(
      `Snapshot: sha256:${digest}; providers: ${MODEL_PROVIDERS.length}; candidates: ${selected.rawCount}; selected: ${selected.all.length}.`,
    )
    // Header must stay stamp-free: no ISO datetime and no date-only stamp
    // either, or every regeneration would churn the committed bytes. Scoped to
    // the header because 10 selected ids are dated ("openai/gpt-4o-2024-08-06").
    expect(generated.split("\n").slice(0, 7).join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(generated.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\b(?:const|let|var)\b/)
    expect(selected.rawCount).toBeGreaterThan(selected.all.length)
    expect(selected.all.length).toBeGreaterThan(500)
  })

  test("selection policy is complete, sorted, unique, and parseModel-compatible", async () => {
    const snapshot = parseSnapshot(await snapshotFile.text())
    const selected = selectModelIds(snapshot)
    const selectedSet = new Set(selected.all)

    expect(Object.keys(snapshot.providers).sort(compareCodeUnits)).toEqual([...MODEL_PROVIDERS])
    expect(selected.all).toEqual([...selected.all].sort(compareCodeUnits))
    expect(selectedSet.size).toBe(selected.all.length)

    for (const provider of MODEL_PROVIDERS) {
      expect(selected.byProvider[provider]!.length).toBeGreaterThan(0)
      expect(selected.byProvider[provider]).toEqual([...selected.byProvider[provider]!].sort(compareCodeUnits))
      for (const model of snapshot.providers[provider]!.models) {
        const id = `${provider}/${model.id}`
        const eligible =
          model.tool_call && model.output.includes("text") && model.status !== "deprecated" && model.status !== "alpha"
        expect(selectedSet.has(id)).toBe(eligible)
        if (!eligible) continue
        expect(id).not.toMatch(/["\\\s]/u)
        expect(parseModel(id)).toEqual({ providerID: provider, modelID: model.id })
      }
    }

    expect(selected.byProvider.anthropic).toHaveLength(13)
    expect(selected.byProvider.openai).toHaveLength(30)
    expect(selected.byProvider.google).toHaveLength(20)
    expect(selected.byProvider.xai).toHaveLength(5)
    expect(selected.byProvider.groq).toHaveLength(7)
    expect(selected.byProvider.mistral).toHaveLength(21)
    expect(selected.byProvider.deepseek).toHaveLength(4)
  })

  test("pruning the equivalent source catalog is idempotent", async () => {
    const snapshot = parseSnapshot(await snapshotFile.text())
    expect(pruneCatalog(sourceCatalog(snapshot))).toEqual(snapshot)
  })

  test("generator rejects unparseable, malformed, duplicate, missing, and empty selections", async () => {
    const snapshot = parseSnapshot(await snapshotFile.text())
    expect(() => parseSnapshot("{ this is not json")).toThrow(SyntaxError)
    expect(() => parseSnapshot("[]")).toThrow(/snapshot must be an object/)
    expect(() => parseSnapshot('{"version":1}')).toThrow(/snapshot.providers must be an object/)

    const missing = structuredClone(snapshot)
    delete missing.providers.xai
    expect(() => selectModelIds(missing)).toThrow(/must contain exactly/)

    const duplicate = structuredClone(snapshot)
    duplicate.providers.anthropic!.models.push({ ...duplicate.providers.anthropic!.models[0]! })
    expect(() => selectModelIds(duplicate)).toThrow(/duplicate model ids/)

    const malformed = structuredClone(snapshot)
    malformed.providers.anthropic!.models[0]!.id = "model with whitespace"
    expect(() => selectModelIds(malformed)).toThrow(/quotes, backslashes, or whitespace/)

    // An empty model id clears the character check ("anthropic/" has no quote,
    // backslash, or whitespace) and is caught only by the parseModel round-trip
    // guard — the SDK's own parser refuses to split it back apart.
    const unsplittable = sourceCatalog(snapshot)
    unsplittable.anthropic!.models[""] = { id: "", tool_call: true, modalities: { output: ["text"] } }
    expect(() => pruneCatalog(unsplittable)).toThrow(/must use provider\/model format/)

    const empty = structuredClone(snapshot)
    empty.providers.xai!.models = empty.providers.xai!.models.map((model) => ({ ...model, tool_call: false }))
    expect(() => selectModelIds(empty)).toThrow(/xai has no models after filtering/)
  })

  test("models namespace is pure prefix sugar and accepts unknown ids", () => {
    expect(models.anthropic("claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5")
    expect(models.openai("future-model")).toBe("openai/future-model")
    expect(models.google("publisher/model:preview")).toBe("google/publisher/model:preview")
    expect(models.xai("grok-4")).toBe("xai/grok-4")
    expect(models.groq("llama-3.3-70b-versatile")).toBe("groq/llama-3.3-70b-versatile")
    expect(models.mistral("codestral-latest")).toBe("mistral/codestral-latest")
    expect(models.deepseek("deepseek-chat")).toBe("deepseek/deepseek-chat")
  })
})
