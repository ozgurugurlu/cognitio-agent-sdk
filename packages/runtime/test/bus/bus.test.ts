import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import "../../src/effect/app-runtime"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const TestEvent = {
  Ping: BusEvent.define("test.ping", z.object({ value: z.number() })),
  Pong: BusEvent.define("test.pong", z.object({ message: z.string() })),
}

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

describe("Bus", () => {
  afterEach(() => Instance.disposeAll())

  describe("publish + subscribe", () => {
    test("subscriber is live immediately after subscribe returns", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        await Bus.publish(TestEvent.Ping, { value: 42 })
        await Bun.sleep(10)
      })

      expect(received).toEqual([42])
    })

    test("subscriber receives matching events", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        // Give the subscriber fiber time to start consuming
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 42 })
        await Bus.publish(TestEvent.Ping, { value: 99 })
        // Give subscriber time to process
        await Bun.sleep(10)
      })

      expect(received).toEqual([42, 99])
    })

    test("subscriber does not receive events of other types", async () => {
      await using tmp = await tmpdir()
      const pings: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          pings.push(evt.properties.value)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Pong, { message: "hello" })
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      expect(pings).toEqual([1])
    })

    test("publish with no subscribers does not throw", async () => {
      await using tmp = await tmpdir()

      await withInstance(tmp.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 1 })
      })
    })
  })

  describe("unsubscribe", () => {
    test("unsubscribe stops delivery", async () => {
      await using tmp = await tmpdir()
      const received: number[] = []

      await withInstance(tmp.path, async () => {
        const unsub = Bus.subscribe(TestEvent.Ping, (evt) => {
          received.push(evt.properties.value)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
        unsub()
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 2 })
        await Bun.sleep(10)
      })

      expect(received).toEqual([1])
    })
  })

  describe("subscribeAll", () => {
    test("subscribeAll is live immediately after subscribe returns", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      expect(received).toEqual(["test.ping"])
    })

    test("receives all event types", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bus.publish(TestEvent.Pong, { message: "hi" })
        await Bun.sleep(10)
      })

      expect(received).toContain("test.ping")
      expect(received).toContain("test.pong")
    })
  })

  describe("multiple subscribers", () => {
    test("all subscribers for same event type are called", async () => {
      await using tmp = await tmpdir()
      const a: number[] = []
      const b: number[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          a.push(evt.properties.value)
        })
        Bus.subscribe(TestEvent.Ping, (evt) => {
          b.push(evt.properties.value)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 7 })
        await Bun.sleep(10)
      })

      expect(a).toEqual([7])
      expect(b).toEqual([7])
    })
  })

  describe("instance isolation", () => {
    test("events in one directory do not reach subscribers in another", async () => {
      await using tmpA = await tmpdir()
      await using tmpB = await tmpdir()
      const receivedA: number[] = []
      const receivedB: number[] = []

      await withInstance(tmpA.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          receivedA.push(evt.properties.value)
        })
        await Bun.sleep(10)
      })

      await withInstance(tmpB.path, async () => {
        Bus.subscribe(TestEvent.Ping, (evt) => {
          receivedB.push(evt.properties.value)
        })
        await Bun.sleep(10)
      })

      await withInstance(tmpA.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      await withInstance(tmpB.path, async () => {
        await Bus.publish(TestEvent.Ping, { value: 2 })
        await Bun.sleep(10)
      })

      expect(receivedA).toEqual([1])
      expect(receivedB).toEqual([2])
    })
  })

  describe("instance disposal", () => {
    test("InstanceDisposed is delivered to wildcard subscribers before stream ends", async () => {
      await using tmp = await tmpdir()
      const received: string[] = []

      await withInstance(tmp.path, async () => {
        Bus.subscribeAll((evt) => {
          received.push(evt.type)
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent.Ping, { value: 1 })
        await Bun.sleep(10)
      })

      // Instance.disposeAll triggers the finalizer which publishes InstanceDisposed
      await Instance.disposeAll()
      await Bun.sleep(50)

      expect(received).toContain("test.ping")
      expect(received).toContain(Bus.InstanceDisposed.type)
    })
  })

  describe("payload registry", () => {
    test("includes phase 1A event schemas via import side effects", () => {
      const sessionID = SessionID.descending()
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const samples = [
        {
          type: "control.request",
          properties: {
            id: crypto.randomUUID(),
            sessionID,
            subtype: "hook_callback",
            payload: {},
            createdAt: Date.now(),
            timeoutMs: 30_000,
          },
        },
        {
          type: "control.cancelled",
          properties: {
            id: crypto.randomUUID(),
            sessionID,
            reason: "timeout",
          },
        },
        {
          type: "system.compact_boundary",
          properties: {
            sessionID,
            messageID,
            partID,
            checkpointId: undefined,
            auto: true,
            overflow: false,
            tailStartMessageID: messageID,
          },
        },
        {
          type: Session.Event.Result.type,
          properties: {
            sessionID,
            messageID,
            parentMessageID: messageID,
            subtype: "success",
            stopReason: "stop",
            numTurns: 1,
            totalCostUsd: 0,
            usage: {
              total: 1,
              input: 0,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelUsage: {
              "test/model": {
                tokens: {
                  total: 1,
                  input: 0,
                  output: 1,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                cost: 0,
              },
            },
          },
        },
      ]

      const payloads = BusEvent.payloads()
      for (const sample of samples) {
        expect(payloads.some((schema) => schema.safeParse(sample).success)).toBe(true)
      }
    })
  })
})
