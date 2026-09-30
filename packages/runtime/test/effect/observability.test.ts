import { afterEach, describe, expect, test } from "bun:test"
import { resource } from "../../src/effect/observability"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const cognitioClient = process.env.COGNITIO_CLIENT
const otelServiceName = process.env.OTEL_SERVICE_NAME

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (cognitioClient === undefined) delete process.env.COGNITIO_CLIENT
  else process.env.COGNITIO_CLIENT = cognitioClient

  if (otelServiceName === undefined) delete process.env.OTEL_SERVICE_NAME
  else process.env.OTEL_SERVICE_NAME = otelServiceName
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["cognitio.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.COGNITIO_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "cognitio.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "cognitio.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
  })
})

describe("service name", () => {
  test("defaults to cognitio", () => {
    delete process.env.OTEL_SERVICE_NAME
    expect(resource().serviceName).toBe("cognitio")
  })

  test("honors OTEL_SERVICE_NAME", () => {
    process.env.OTEL_SERVICE_NAME = "my-agent-platform"
    expect(resource().serviceName).toBe("my-agent-platform")
  })
})
