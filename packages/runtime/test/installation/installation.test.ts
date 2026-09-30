import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "../../src/installation/version"

describe("bundled runtime installation", () => {
  test("reports its pinned version without network or subprocess services", async () => {
    const result = await Effect.runPromise(
      Installation.Service.use((service) => service.info()).pipe(Effect.provide(Installation.layer)),
    )
    expect(result).toEqual({ version: InstallationVersion, latest: InstallationVersion })
  })

  test("legacy installation methods remain pinned to the bundled version", async () => {
    for (const method of ["curl", "npm", "bun", "brew", "scoop", "choco", "unknown"] as const) {
      expect(await Effect.runPromise(
        Installation.Service.use((service) => service.latest(method)).pipe(Effect.provide(Installation.layer)),
      )).toBe(InstallationVersion)
    }
  })

  test("refuses independent runtime upgrades", async () => {
    const result = await Effect.runPromise(
      Installation.Service.use((service) => service.upgrade("npm", "99.0.0")).pipe(
        Effect.flip,
        Effect.provide(Installation.layer),
      ),
    )
    expect(result._tag).toBe("UpgradeFailedError")
    expect(result.stderr).toContain("Update cognitio-agent-sdk")
  })
})
