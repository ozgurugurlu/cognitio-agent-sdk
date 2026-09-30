import { models } from "../../src/index.js"
import type { AnthropicModelId, KnownModelId, ModelId, RuntimeConfig, Session } from "../../src/index.js"

declare const arbitraryString: string
declare const session: Session

const known: KnownModelId = "anthropic/claude-sonnet-4-5"
const providerKnown: AnthropicModelId = "claude-sonnet-4-5"
const arbitrary: ModelId = "private-provider/future-model"
const stringToModel: ModelId = arbitraryString
const modelToString: string = arbitrary
const helperKnown: ModelId = models.anthropic(providerKnown)
const helperUnknown: ModelId = models.openai(arbitraryString)
const config: RuntimeConfig = {
  model: arbitraryString,
  autoPermissionClassifierModel: "openai/gpt-5.2",
  agents: { reviewer: { prompt: "Review", model: arbitraryString } },
  skills: [{ name: "review", description: "Review", content: "Review", model: arbitraryString }],
  commands: [{ name: "review", template: "Review", model: arbitraryString }],
}

// @ts-expect-error An arbitrary string must never collapse the curated union.
const narrow: KnownModelId = arbitraryString
// @ts-expect-error Provider-specific unions contain bare known model ids only.
const providerNarrow: AnthropicModelId = "future-model"

void session.setModel(arbitraryString)
void session.compact({ model: arbitraryString })
void session.command("review", "", { model: arbitraryString })
void [
  known,
  providerKnown,
  arbitrary,
  stringToModel,
  modelToString,
  helperKnown,
  helperUnknown,
  config,
  narrow,
  providerNarrow,
]
