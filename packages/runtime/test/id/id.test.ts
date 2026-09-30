import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("ascending identifier timestamps", () => {
  test("recovers modern epoch milliseconds without changing the stored ID format", () => {
    const time = Date.UTC(2026, 8, 29, 12)
    const id = Identifier.create("tool", "ascending", time)
    expect(id).toMatch(/^tool_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(Identifier.timestamp(id, time)).toBe(time)
  })

  test("retention remains ordered across a 36-bit timestamp rollover", () => {
    const day = 86_400_000
    const now = 26 * 2 ** 36 + 3 * day
    const old = Identifier.create("tool", "ascending", now - 10 * day)
    const recent = Identifier.create("tool", "ascending", now - 3 * day)
    expect(Identifier.timestamp(old, now)).toBe(now - 10 * day)
    expect(Identifier.timestamp(recent, now)).toBe(now - 3 * day)
    expect(Identifier.timestamp(old, now)).toBeLessThan(now - 7 * day)
    expect(Identifier.timestamp(recent, now)).toBeGreaterThan(now - 7 * day)
  })

  test("historical records can supply their persisted creation era", () => {
    const time = Date.UTC(2020, 0, 1)
    expect(Identifier.timestamp(Identifier.create("msg", "ascending", time), time)).toBe(time)
  })
})
