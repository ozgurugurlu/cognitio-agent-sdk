import { expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkGeneratedClient } from "../script/build.js"

test("generated client guard detects modified, missing, and unexpected files without overwriting them", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cognitio-sdk-drift-test-"))
  try {
    await cp(new URL("../src/v2/gen", import.meta.url), temporary, { recursive: true })
    expect(await checkGeneratedClient(temporary)).toEqual({ missing: [], extra: [], changed: [] })
    await Bun.write(path.join(temporary, "types.gen.ts"), "// stale\n")
    await Bun.write(path.join(temporary, "unexpected.ts"), "// extra\n")
    await rm(path.join(temporary, "sdk.gen.ts"))
    expect(await checkGeneratedClient(temporary)).toEqual({
      missing: ["sdk.gen.ts"],
      extra: ["unexpected.ts"],
      changed: ["types.gen.ts"],
    })
    expect(await Bun.file(path.join(temporary, "types.gen.ts")).text()).toBe("// stale\n")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
