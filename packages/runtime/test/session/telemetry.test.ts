import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { simulateReadableStream, streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { SessionTelemetry } from "../../src/session/telemetry"

const privatePrompt = "private prompt: phase-10-redaction-input"
const privateOutput = "private completion: phase-10-redaction-output"

async function exportedAttributes(input: { recordInputs?: boolean; recordOutputs?: boolean }) {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const result = streamText({
    model: new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "response-1", modelId: "mock-model", timestamp: new Date(0) },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: privateOutput },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 4, text: 4, reasoning: 0 },
              },
            },
          ],
        }),
      },
    }),
    prompt: privatePrompt,
    experimental_telemetry: SessionTelemetry.telemetrySettings({
      enabled: true,
      recordInputs: input.recordInputs,
      recordOutputs: input.recordOutputs,
      tracer: provider.getTracer("session-telemetry-test"),
      functionId: "session.llm",
      metadata: { sessionId: "ses_x" },
    }),
  })
  expect(await result.text).toBe(privateOutput)
  await provider.forceFlush()
  const attributes = exporter.getFinishedSpans().map((span) => span.attributes)
  await provider.shutdown()
  return attributes
}

describe("session.telemetry", () => {
  test("redacts inputs and outputs by default", () => {
    const settings = SessionTelemetry.telemetrySettings({
      enabled: true,
      recordInputs: undefined,
      recordOutputs: undefined,
      tracer: undefined,
      functionId: "session.llm",
      metadata: { sessionId: "ses_x" },
    })
    expect(settings.isEnabled).toBe(true)
    expect(settings.recordInputs).toBe(false)
    expect(settings.recordOutputs).toBe(false)
    expect(settings.functionId).toBe("session.llm")
    expect(settings.metadata).toEqual({ sessionId: "ses_x" })
  })

  test("each content flag opts in independently", () => {
    const inputsOnly = SessionTelemetry.telemetrySettings({
      enabled: true,
      recordInputs: true,
      recordOutputs: undefined,
      tracer: undefined,
      functionId: "session.llm",
      metadata: {},
    })
    expect(inputsOnly.recordInputs).toBe(true)
    expect(inputsOnly.recordOutputs).toBe(false)

    const outputsOnly = SessionTelemetry.telemetrySettings({
      enabled: true,
      recordInputs: false,
      recordOutputs: true,
      tracer: undefined,
      functionId: "agent.generate",
      metadata: {},
    })
    expect(outputsOnly.recordInputs).toBe(false)
    expect(outputsOnly.recordOutputs).toBe(true)
  })

  test("exported AI SDK spans redact content by default and honor per-direction opt-ins", async () => {
    const redacted = await exportedAttributes({})
    expect(redacted.some((attributes) => attributes["gen_ai.request.model"] === "mock-model-id")).toBe(true)
    expect(JSON.stringify(redacted)).not.toContain(privatePrompt)
    expect(JSON.stringify(redacted)).not.toContain(privateOutput)

    const inputsOnly = await exportedAttributes({ recordInputs: true })
    expect(JSON.stringify(inputsOnly)).toContain(privatePrompt)
    expect(JSON.stringify(inputsOnly)).not.toContain(privateOutput)

    const outputsOnly = await exportedAttributes({ recordOutputs: true })
    expect(JSON.stringify(outputsOnly)).not.toContain(privatePrompt)
    expect(JSON.stringify(outputsOnly)).toContain(privateOutput)
  })

  test("passes the enabled flag through untouched", () => {
    const disabled = SessionTelemetry.telemetrySettings({
      enabled: undefined,
      recordInputs: true,
      recordOutputs: true,
      tracer: undefined,
      functionId: "session.llm",
      metadata: {},
    })
    expect(disabled.isEnabled).toBeUndefined()
  })
})
