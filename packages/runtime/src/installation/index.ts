import { Effect, Layer, Schema, Context } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "../flag/flag"

import semver from "semver"
import { InstallationChannel, InstallationVersion } from "./version"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    z.object({
      version: z.string(),
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    z.object({
      version: z.string(),
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `cognitio/${InstallationChannel}/${InstallationVersion}/${Flag.COGNITIO_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@cognitio/Installation") {}

/**
 * The runtime is version-pinned inside Cognitio Agent SDK platform packages.
 * Updating it independently would violate the SDK/runtime protocol contract.
 * The consumer updates the SDK through their package manager instead.
 */
export const layer = Layer.succeed(
  Service,
  Service.of({
    info: () => Effect.succeed({ version: InstallationVersion, latest: InstallationVersion }),
    method: () => Effect.succeed("unknown" as Method),
    latest: () => Effect.succeed(InstallationVersion),
    upgrade: () =>
      Effect.fail(
        new UpgradeFailedError({
          stderr:
            "The bundled Cognitio runtime cannot update itself. Update cognitio-agent-sdk with your package manager.",
        }),
      ),
  }),
)

export const defaultLayer = layer

export * as Installation from "."
