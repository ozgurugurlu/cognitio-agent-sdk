import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  COGNITIO_CHANNEL: process.env["COGNITIO_CHANNEL"],
  COGNITIO_BUMP: process.env["COGNITIO_BUMP"],
  COGNITIO_VERSION: process.env["COGNITIO_VERSION"],
  COGNITIO_RELEASE: process.env["COGNITIO_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.COGNITIO_CHANNEL) return env.COGNITIO_CHANNEL
  if (env.COGNITIO_BUMP) return "latest"
  if (env.COGNITIO_VERSION && !env.COGNITIO_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.COGNITIO_VERSION) return env.COGNITIO_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = (await Bun.file(path.resolve(import.meta.dir, "../../runtime/package.json")).json()).version as string
  if (!env.COGNITIO_BUMP) return version
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.COGNITIO_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "cognitio", "cognitio-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...((await Bun.file(teamPath).exists())
    ? await Bun.file(teamPath)
        .text()
        .then((text) =>
          text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#")),
        )
    : []),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.COGNITIO_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`cognitio script`, JSON.stringify(Script, null, 2))
