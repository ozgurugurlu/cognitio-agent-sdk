import type {
  AnthropicModelId,
  DeepseekModelId,
  GoogleModelId,
  GroqModelId,
  MistralModelId,
  ModelId,
  OpenaiModelId,
  XaiModelId,
} from "./types.js"

/**
 * Pure model-id string helpers.
 *
 * These helpers only concatenate a provider prefix. They do not create a
 * provider client, read an API key, perform I/O, validate availability, or
 * depend on `@ai-sdk/*`. Known ids receive completions, while arbitrary
 * current or private ids remain accepted.
 *
 * @example
 * ```ts
 * const model = models.anthropic("claude-sonnet-4-5")
 * // "anthropic/claude-sonnet-4-5"
 * ```
 */
export const models = {
  /**
   * Prefix an Anthropic model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns An `anthropic/<model>` id.
   */
  anthropic(model: AnthropicModelId | (string & {})): ModelId {
    return `anthropic/${model}`
  },
  /**
   * Prefix an OpenAI model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns An `openai/<model>` id.
   */
  openai(model: OpenaiModelId | (string & {})): ModelId {
    return `openai/${model}`
  },
  /**
   * Prefix a Google model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns A `google/<model>` id.
   */
  google(model: GoogleModelId | (string & {})): ModelId {
    return `google/${model}`
  },
  /**
   * Prefix an xAI model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns An `xai/<model>` id.
   */
  xai(model: XaiModelId | (string & {})): ModelId {
    return `xai/${model}`
  },
  /**
   * Prefix a Groq model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns A `groq/<model>` id.
   */
  groq(model: GroqModelId | (string & {})): ModelId {
    return `groq/${model}`
  },
  /**
   * Prefix a Mistral model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns A `mistral/<model>` id.
   */
  mistral(model: MistralModelId | (string & {})): ModelId {
    return `mistral/${model}`
  },
  /**
   * Prefix a DeepSeek model name.
   *
   * @param model - Known or arbitrary provider-local model name.
   * @returns A `deepseek/<model>` id.
   */
  deepseek(model: DeepseekModelId | (string & {})): ModelId {
    return `deepseek/${model}`
  },
}
