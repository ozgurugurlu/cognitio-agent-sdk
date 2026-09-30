import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, Context } from "effect"
import { NamedError } from "@cognitio/shared/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@cognitio/shared/filesystem"
import { Config } from "../config"
import { ConfigMarkdown } from "../config"
import { ConfigPaths } from "@/config/paths"
import { ConfigResources } from "@/config/resources"
import { Glob } from "@cognitio/shared/util/glob"
import { Log } from "../util"
import { Discovery } from "./discovery"

const log = Log.create({ service: "skill" })
const EXTERNAL_DIRS = [".claude", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const COGNITIO_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

export const Info = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string().optional(),
  content: z.string(),
})
export type Info = z.infer<typeof Info>

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type State = {
  // Scan-ordered entries with their provenance; views replay allowed layers
  // with deterministic last-allowed-wins name dedupe.
  entries: Array<{ info: Info; source: ConfigResources.Source }>
}

type DiscoveryState = {
  matches: Array<{ path: string; source: ConfigResources.Source }>
  dirs: Array<{ path: string; source: ConfigResources.Source }>
}

type ScanState = {
  matches: Map<string, ConfigResources.Source>
  dirs: Map<string, ConfigResources.Source>
}

export interface Interface {
  readonly get: (name: string, sources?: readonly ConfigResources.Gate[]) => Effect.Effect<Info | undefined>
  readonly all: (sources?: readonly ConfigResources.Gate[]) => Effect.Effect<Info[]>
  readonly dirs: (sources?: readonly ConfigResources.Gate[]) => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info, sources?: readonly ConfigResources.Gate[]) => Effect.Effect<Info[]>
}

const parse = Effect.fnUntraced(function* (match: string, bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return undefined

  const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
  if (!parsed.success) return undefined

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
  } satisfies Info
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  source: ConfigResources.Source,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    if (!state.matches.has(match)) state.matches.set(match, source)
    const dir = path.dirname(match)
    if (!state.dirs.has(dir)) state.dirs.set(dir, source)
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Map(), dirs: new Map() }

  if (!Flag.COGNITIO_DISABLE_EXTERNAL_SKILLS) {
    for (const dir of EXTERNAL_DIRS) {
      const root = path.join(Global.Path.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, "user", { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, "project", { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, COGNITIO_SKILL_PATTERN, ConfigPaths.classifyConfigDir(dir))
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN, "local")
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN, "local")
    }
  }

  return {
    matches: Array.from(state.matches, ([match, source]) => ({ path: match, source })),
    dirs: Array.from(state.dirs, ([dir, source]) => ({ path: dir, source })),
  }
})

const loadSkills = Effect.fnUntraced(function* (discovered: DiscoveryState, bus: Bus.Interface) {
  // Parse concurrently but assemble in scan order so duplicate-name precedence
  // is deterministic (previously it was completion-order random).
  const parsed = yield* Effect.forEach(
    discovered.matches,
    (match) => parse(match.path, bus).pipe(Effect.map((info) => (info ? { info, source: match.source } : undefined))),
    { concurrency: "unbounded" },
  )

  const entries: State["entries"] = []
  const seen = new Map<string, string | undefined>()
  for (const item of parsed) {
    if (!item) continue
    if (seen.has(item.info.name)) {
      log.warn("duplicate skill name", {
        name: item.info.name,
        existing: seen.get(item.info.name),
        duplicate: item.info.location,
      })
    }
    seen.set(item.info.name, item.info.location)
    entries.push(item)
  }

  log.info("init", { count: seen.size })
  return entries
})

export class Service extends Context.Service<Service, Interface>()("@cognitio/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(config, discovery, fsys, ctx.directory, ctx.worktree)
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (_ctx) {
        const entries = yield* loadSkills(yield* InstanceState.get(discovered), bus)
        return { entries } satisfies State
      }),
    )

    const all = Effect.fn("Skill.all")(function* (sources?: readonly ConfigResources.Gate[]) {
      const s = yield* InstanceState.get(state)
      const map = new Map<string, Info>()
      for (const item of s.entries) {
        if (!ConfigResources.allowed(sources, item.source)) continue
        map.set(item.info.name, item.info)
      }
      return Array.from(map.values())
    })

    const get = Effect.fn("Skill.get")(function* (name: string, sources?: readonly ConfigResources.Gate[]) {
      return (yield* all(sources)).find((skill) => skill.name === name)
    })

    const dirs = Effect.fn("Skill.dirs")(function* (sources?: readonly ConfigResources.Gate[]) {
      return (yield* InstanceState.get(discovered)).dirs
        .filter((dir) => ConfigResources.allowed(sources, dir.source))
        .map((dir) => dir.path)
    })

    const available = Effect.fn("Skill.available")(function* (
      agent?: Agent.Info,
      sources?: readonly ConfigResources.Gate[],
    ) {
      const list = (yield* all(sources)).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, all, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          ...(skill.location ? [`    <location>${pathToFileURL(skill.location).href}</location>`] : []),
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
