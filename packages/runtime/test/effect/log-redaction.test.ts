import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OtlpResource, type OtlpLogger } from "effect/unstable/observability"
import { redactLogData } from "../../src/effect/log-redaction"

function payload(attributes: OtlpResource.KeyValue[], body: unknown = "private runtime message"): OtlpLogger.LogsData {
  return {
    resourceLogs: [
      {
        resource: OtlpResource.make({
          serviceName: "operator-configured-service",
          attributes: { "operator.annotation": "explicit resource content" },
        }),
        schemaUrl: "https://example.test/resource-schema",
        scopeLogs: [
          {
            scope: { name: "operator-configured-service" },
            logRecords: [
              {
                timeUnixNano: "1790000000000000000",
                observedTimeUnixNano: "1790000000000001000",
                severityNumber: 9,
                severityText: "Info",
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                flags: 1,
                body: OtlpResource.unknownToAttributeValue(body),
                attributes,
                droppedAttributesCount: 2,
              },
            ],
          },
        ],
      },
    ],
  }
}

function record(data: OtlpLogger.LogsData) {
  return data.resourceLogs[0]!.scopeLogs[0]!.logRecords![0]!
}

test("exported records omit raw bodies and opaque fields without mutating local diagnostics", () => {
  const input = payload(
    OtlpResource.entriesToAttributes(
      Object.entries({
        service: "session.prompt",
        duration: 12.5,
        count: 0,
        success: true,
        status: "completed",
        method: "POST",
        input: "private prompt input",
        output: ["private model output"],
        parts: [{ text: "private attachment" }],
        messages: [{ role: "user", content: "private transcript" }],
        args: { command: "private shell argument" },
        env: { PROVIDER_KEY: "private environment value" },
        config: { provider: { secret: "private configuration" } },
        error: "private provider failure",
        cause: { message: "private nested cause" },
        "log.error": "private Effect cause",
        "logSpan.private operation": "12ms",
        arbitrary: { nested: ["private unknown value"] },
      }),
    ),
    { prompt: "private body", nested: [{ stderr: "private MCP output" }] },
  )
  const before = structuredClone(input)
  const output = redactLogData(input)
  expect(record(output).body).toEqual({ stringValue: "[redacted]" })
  expect(record(output).attributes).toEqual(
    OtlpResource.entriesToAttributes([
      ["service", "session.prompt"],
      ["duration", 12.5],
      ["count", 0],
      ["success", true],
      ["status", "completed"],
      ["method", "POST"],
    ]),
  )
  expect(JSON.stringify(output)).not.toContain("private ")
  expect(record(output).droppedAttributesCount).toBe(14)
  expect(input).toEqual(before)
  expect(record(output)).toMatchObject({
    timeUnixNano: record(input).timeUnixNano,
    observedTimeUnixNano: record(input).observedTimeUnixNano,
    severityNumber: 9,
    severityText: "Info",
    traceId: record(input).traceId,
    spanId: record(input).spanId,
    flags: 1,
  })
  // Explicit resource configuration is separate from log-record annotations.
  expect(output.resourceLogs[0]!.resource).toEqual(input.resourceLogs[0]!.resource)
  expect(output.resourceLogs[0]!.schemaUrl).toBe(input.resourceLogs[0]!.schemaUrl)
  expect(output.resourceLogs[0]!.scopeLogs[0]!.scope).toEqual(input.resourceLogs[0]!.scopeLogs[0]!.scope)
})

test("accepted scalar fields cannot carry unapproved sibling values", () => {
  const input = payload([
    { key: "duration", value: { intValue: 4, stringValue: "hidden duration content" } },
    {
      key: "cached",
      value: {
        boolValue: false,
        kvlistValue: { values: [{ key: "secret", value: { stringValue: "hidden nested content" } }] },
      },
    },
    {
      key: "service",
      value: { stringValue: "mcp", arrayValue: { values: [{ stringValue: "hidden service content" }] } },
    },
    { key: "decision", value: { stringValue: "deny", bytesValue: new Uint8Array([1, 2, 3]) } },
    { key: "method", value: { stringValue: "GET", intValue: 123 } },
    ...OtlpResource.entriesToAttributes([
      ["count", Number.NaN],
      ["duration", Number.POSITIVE_INFINITY],
      ["cost", -1],
      ["pid", "123"],
      ["success", "true"],
      ["status", "private failure message"],
      ["method", "GET private URL"],
      ["unknownNumeric", 42],
    ]),
  ])
  const output = record(redactLogData(input))
  expect(output.attributes).toEqual(
    OtlpResource.entriesToAttributes([
      ["duration", 4],
      ["cached", false],
      ["service", "mcp"],
      ["decision", "deny"],
      ["method", "GET"],
    ]),
  )
  expect(output.droppedAttributesCount).toBe(10)
  expect(JSON.stringify(output)).not.toMatch(/hidden|private|unknownNumeric/)
})

test("only framework IDs in their matching fields remain raw; opaque identifiers are hashed", () => {
  const sessionID = "ses_0123456789abcdefghij"
  const messageID = "msg_0123456789abcdefghij"
  const input = payload(
    OtlpResource.entriesToAttributes([
      ["session.id", sessionID],
      ["messageID", messageID],
      ["parentID", sessionID],
      ["workspaceID", "wrk_0123456789abcdefghij"],
      ["providerID", sessionID],
      ["modelID", messageID],
      ["toolCallID", sessionID],
      ["sessionID", messageID],
      ["projectID", "private/project/path"],
      ["service", "private-custom-service"],
    ]),
  )
  const attributes = Object.fromEntries(
    record(redactLogData(input)).attributes.map((entry) => [entry.key, entry.value]),
  )
  expect(attributes["session.id"]).toEqual({ stringValue: sessionID })
  expect(attributes.messageID).toEqual({ stringValue: messageID })
  expect(attributes.parentID).toEqual({ stringValue: sessionID })
  expect(attributes.workspaceID).toEqual({ stringValue: "wrk_0123456789abcdefghij" })
  for (const key of ["providerID", "modelID", "toolCallID", "sessionID", "projectID", "service"]) {
    const original = record(input).attributes.find((entry) => entry.key === key)!.value.stringValue!
    expect(attributes[key]).toBeUndefined()
    expect(attributes[`${key}.hash`]).toEqual({ stringValue: createHash("sha256").update(original).digest("hex") })
  }
})

test("empty scopes and every record in multiple resources remain valid", () => {
  const first = payload([]).resourceLogs[0]!
  const second = payload([], ["private second body"]).resourceLogs[0]!
  const input: OtlpLogger.LogsData = {
    resourceLogs: [first, { scopeLogs: [{ scope: { name: "empty" } }] }, second],
  }
  const output = redactLogData(input)
  expect(output.resourceLogs).toHaveLength(3)
  expect(output.resourceLogs[1]!.scopeLogs[0]!.logRecords).toBeUndefined()
  expect(output.resourceLogs[0]!.scopeLogs[0]!.logRecords![0]!.body).toEqual({ stringValue: "[redacted]" })
  expect(output.resourceLogs[2]!.scopeLogs[0]!.logRecords![0]!.body).toEqual({ stringValue: "[redacted]" })
  expect(redactLogData({ resourceLogs: [] })).toEqual({ resourceLogs: [] })
})
