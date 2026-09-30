import { describe, expect, test } from "bun:test"
import { Npm } from "../src/npm"

const win = process.platform === "win32"

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@cognitio/acme")).toBe("@cognitio/acme")
    expect(Npm.sanitize("@cognitio/acme@1.0.0")).toBe("@cognitio/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/cognitio/acme.git"
    const expected = win ? "acme@git+https_//github.com/cognitio/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("provider package cache generations", () => {
  test("exact registry versions are stable across refresh windows", () => {
    expect(Npm.cacheGeneration("@ai-sdk/openai@3.0.53", 1, 100)).toBe("")
    expect(Npm.cacheGeneration("@ai-sdk/openai@3.0.53", 999, 100)).toBe("")
  })

  test("mutable tags, ranges and local sources refresh with distinct module paths", () => {
    for (const pkg of ["@ai-sdk/openai", "@ai-sdk/openai@latest", "@ai-sdk/openai@^3", "file:/tmp/provider"]) {
      expect(Npm.cacheGeneration(pkg, 101, 100)).toBe("1")
      expect(Npm.cacheGeneration(pkg, 199, 100)).toBe("1")
      expect(Npm.cacheGeneration(pkg, 200, 100)).toBe("2")
    }
  })

  test("invalid refresh intervals fail instead of silently keeping stale packages", () => {
    expect(() => Npm.cacheGeneration("provider", 100, 0)).toThrow("TTL")
    expect(() => Npm.cacheGeneration("provider", 100, Number.NaN)).toThrow("TTL")
  })
})
