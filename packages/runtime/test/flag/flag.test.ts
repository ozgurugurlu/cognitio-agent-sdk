import { describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const IMPLIED = [
  "COGNITIO_DISABLE_AUTOUPDATE",
  "COGNITIO_DISABLE_LSP_DOWNLOAD",
  "COGNITIO_DISABLE_EXTERNAL_SKILLS",
  "COGNITIO_DISABLE_PROJECT_CONFIG",
  "COGNITIO_PURE",
] as const

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) saved.set(key, process.env[key])
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("COGNITIO_ISOLATED", () => {
  test("defaults to false and implies nothing when unset", () => {
    withEnv(
      Object.fromEntries(["COGNITIO_ISOLATED", ...IMPLIED].map((key) => [key, undefined])),
      () => {
        expect(Flag.COGNITIO_ISOLATED).toBe(false)
        for (const name of IMPLIED) expect(Flag[name]).toBe(false)
      },
    )
  })

  test("implies all five isolation flags", () => {
    withEnv(
      {
        COGNITIO_ISOLATED: "1",
        ...Object.fromEntries(IMPLIED.map((key) => [key, undefined])),
      },
      () => {
        expect(Flag.COGNITIO_ISOLATED).toBe(true)
        for (const name of IMPLIED) expect(Flag[name]).toBe(true)
      },
    )
  })

  test("individual flags stay independent without the master switch", () => {
    for (const name of IMPLIED) {
      withEnv(
        {
          COGNITIO_ISOLATED: undefined,
          ...Object.fromEntries(IMPLIED.map((key) => [key, undefined])),
          [name]: "1",
        },
        () => {
          expect(Flag.COGNITIO_ISOLATED).toBe(false)
          for (const other of IMPLIED) expect(Flag[other]).toBe(other === name)
        },
      )
    }
  })

  test("explicit false on an implied flag cannot defeat the active master", () => {
    withEnv(
      {
        COGNITIO_ISOLATED: "1",
        ...Object.fromEntries(IMPLIED.map((key) => [key, "false"])),
      },
      () => {
        for (const name of IMPLIED) expect(Flag[name]).toBe(true)
      },
    )
  })

  test("non-truthy master values stay off", () => {
    for (const value of ["0", "false", ""]) {
      withEnv({ COGNITIO_ISOLATED: value }, () => {
        expect(Flag.COGNITIO_ISOLATED).toBe(false)
      })
    }
  })
})
