/**
 * Builds the AI SDK `experimental_telemetry` settings with prompt/completion
 * content REDACTED by default: the AI SDK records full inputs and outputs on
 * its spans whenever telemetry is enabled unless recordInputs/recordOutputs
 * are explicitly false. Content leaves the process only when the operator
 * opts in via `experimental.openTelemetryRecordInputs` / `...Outputs`.
 */
export function telemetrySettings<Tracer>(input: {
  enabled: boolean | undefined
  recordInputs: boolean | undefined
  recordOutputs: boolean | undefined
  tracer: Tracer
  functionId: string
  metadata: Record<string, string>
}) {
  return {
    isEnabled: input.enabled,
    recordInputs: input.recordInputs === true,
    recordOutputs: input.recordOutputs === true,
    functionId: input.functionId,
    tracer: input.tracer,
    metadata: input.metadata,
  }
}

export * as SessionTelemetry from "./telemetry"
