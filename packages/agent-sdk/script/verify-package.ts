/**
 * Proves the published tarball is self-contained, by installing it.
 *
 * Everything here is deliberately outside the workspace: a fresh directory, a
 * real `npm install` of a real tarball, and `node` — not `bun` — running the
 * built `dist/`. Inside the monorepo `@cognitio/sdk` resolves through a
 * symlink to TypeScript source, which is exactly why the old shape appeared to
 * work and could never have worked for a consumer.
 *
 * Steps that need a platform binary are skipped, loudly, when
 * `dist-binaries/` has not been staged. A skipped step is always reported as
 * skipped — "CI guards this" may not be claimed for something that did not run.
 */

import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { STAGE_DIR } from "./build-server-binaries.js"
import {
  PLATFORM_TARGETS,
  platformCandidate,
  serverBinaryFileName,
} from "../src/internal/runtime-client/platform-packages.js"
import { detectLibc } from "../src/internal/runtime-client/resolve-binary.js"
import { EXPECTED_SERVER_VERSION } from "../src/internal/runtime-client/runtime-version.js"
import { packDirectory, readCommittedManifest, stagePackage } from "./pack.js"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")
const repoDir = path.resolve(packageDir, "..", "..")

const results: Array<{ name: string; status: "ok" | "skip"; detail?: string }> = []
function ok(name: string, detail?: string) {
  results.push({ name, status: "ok", ...(detail === undefined ? {} : { detail }) })
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`)
}
function skip(name: string, detail: string) {
  results.push({ name, status: "skip", detail })
  console.log(`  SKIP  ${name} — ${detail}`)
}
function fail(name: string, detail: string): never {
  console.error(`  FAIL  ${name} — ${detail}`)
  throw new Error(`${name}: ${detail}`)
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: { ...process.env, ...options.env },
  })
}

function extract(tarball: string, into: string): string {
  mkdirSync(into, { recursive: true })
  // GNU tar treats a Windows drive-letter archive path as a remote host.
  const result = run("tar", ["-xzf", "-"], { cwd: into, input: readFileSync(tarball) })
  if (result.status !== 0) fail("extract", result.stderr)
  return path.join(into, "package")
}

function walk(dir: string, prefix = ""): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

/**
 * The four-part tarball audit.
 *
 * Scoped deliberately. `CHANGELOG.md` carries 15+ legitimate historical
 * mentions of `@cognitio/sdk` and the vendored files carry provenance
 * comments naming where they came from — a blind grep would fail on prose and
 * on a comment that warns about the very hazard it names. What matters is that
 * nothing *resolves* to that package.
 */
function auditTarball(root: string) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>

  // 1. No field references the sibling package, and optionalDependencies holds
  //    the platform packages and nothing else. `cognitio-agent-sdk-*` is
  //    this package's own scope, so a blanket "no @cognitio/*" rule would be
  //    wrong — the platform packages are the point of the phase.
  const expectedOptional = PLATFORM_TARGETS.map((target) => target.packageName).sort()
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const names = Object.keys((manifest[field] ?? {}) as object)
    if (names.includes("@cognitio/sdk")) fail("tarball: dependency fields", `${field} still declares @cognitio/sdk`)
    if (field === "optionalDependencies") {
      if (JSON.stringify(names.sort()) !== JSON.stringify(expectedOptional)) {
        fail("tarball: dependency fields", `optionalDependencies is ${names.join(", ")}`)
      }
      for (const [name, pinned] of Object.entries(manifest[field] as Record<string, string>)) {
        if (pinned !== manifest.version) {
          fail("tarball: dependency fields", `${name} is pinned to ${pinned}, not ${manifest.version}`)
        }
      }
      continue
    }
    const offenders = names.filter((name) => name.startsWith("@cognitio/"))
    if (offenders.length) fail("tarball: dependency fields", `${field} still has ${offenders.join(", ")}`)
  }
  ok(
    "tarball: no @cognitio/sdk anywhere",
    `optionalDependencies pins all ${expectedOptional.length} platform packages exactly`,
  )

  for (const file of ["LICENSE", "NOTICE"]) {
    if (!existsSync(path.join(root, file))) fail("tarball: attribution", `${file} is missing`)
  }
  ok("tarball: LICENSE and NOTICE included")
  const files = walk(root)

  // 2 & 3. No JS or .d.ts specifier references it.
  const specifier = /(?:from|import|require)\s*\(?\s*["'][^"']*@cognitio\/sdk/
  const codeOffenders = files
    .filter((file) => /\.(js|mjs|cjs|d\.ts|ts)$/.test(file))
    .filter((file) => specifier.test(readFileSync(path.join(root, file), "utf8")))
  if (codeOffenders.length) fail("tarball: specifiers", `still resolve @cognitio/sdk: ${codeOffenders.join(", ")}`)
  ok("tarball: no JS or .d.ts specifier resolves @cognitio/sdk")

  // 4. Nothing leaked, and the vendored client is actually present.
  const leaked = files.filter(
    (file) =>
      file.startsWith("src/") ||
      file.startsWith("test/") ||
      file.startsWith("script/") ||
      file.startsWith("node_modules/") ||
      file.endsWith(".tsbuildinfo"),
  )
  if (leaked.length) fail("tarball: contents", `unexpected entries: ${leaked.slice(0, 5).join(", ")}`)
  const vendored = files.filter((file) => file.startsWith("dist/internal/runtime-client/"))
  if (vendored.length === 0) fail("tarball: contents", "dist/internal/runtime-client/** is missing")
  ok("tarball: no source/test/script/node_modules leaked", `${vendored.length} vendored client files present`)

  if (manifest.scripts) fail("tarball: scripts", "a published tarball must not carry lifecycle scripts")
  ok("tarball: no lifecycle scripts (no postinstall, no install-time download)")
  return manifest
}

/** The control: today's shape, proving problem 1 was real and not cosmetic. */
function currentShapeControl(sdkStaging: string, temp: string) {
  const control = path.join(temp, "control")
  cpSync(sdkStaging, control, { recursive: true })
  const manifest = JSON.parse(readFileSync(path.join(control, "package.json"), "utf8"))
  manifest.name = "agent-sdk-current-shape-control"
  manifest.dependencies = { ...manifest.dependencies, "@cognitio/sdk": "workspace:*" }
  delete manifest.optionalDependencies
  writeFileSync(path.join(control, "package.json"), JSON.stringify(manifest, null, 2))
  const tarball = packDirectory(control, path.join(temp, "control-pack"))
  const consumer = path.join(temp, "control-consumer")
  mkdirSync(consumer, { recursive: true })
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "control-consumer", private: true }))
  const result = run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: consumer })
  if (result.status === 0) {
    fail("control tarball", "a manifest declaring @cognitio/sdk installed cleanly outside the workspace")
  }
  ok("control tarball fails outside the workspace", "workspace:* is unresolvable, as expected")
}

function nodeSmokeSource(expectedVersion: string, platformPackage: string | undefined) {
  return `
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createAgentClient, createSdkMcpServer, defineTool } from "cognitio-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const require_ = createRequire(import.meta.url)
const sdkRoot = path.dirname(require_.resolve("cognitio-agent-sdk/package.json"))
// Absolute file URLs, not package specifiers: the exports map deliberately
// exposes only the root entry, so a consumer cannot deep-import internals. This
// script is allowed to look because it is verifying the package, not using it.
const internal = (...parts) => import(pathToFileURL(path.join(sdkRoot, "dist", ...parts)).href)
const { resolveServerBinary } = await internal("internal", "runtime-client", "resolve-binary.js")

const resolved = resolveServerBinary()
console.log(JSON.stringify({ step: "resolve", ...resolved }))
${
  platformPackage
    ? `assert.equal(resolved.source, "package", "expected the bundled platform package, got " + resolved.source)
assert.equal(resolved.candidate, ${JSON.stringify(platformPackage)})`
    : `assert.equal(resolved.source, "path", "with --omit=optional the resolver must fall through to PATH")`
}

// SDK-hosted MCP over node:http — this is the path that used to call Bun.serve.
const { startSdkMcpServers, stopSdkMcpHosts } = await internal("tools", "mcp-server.js")
const mcp = await startSdkMcpServers(
  [
    createSdkMcpServer({
      name: "verify",
      tools: [
        defineTool({
          name: "echo",
          description: "echo",
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          execute: (input) => "echo:" + input.message,
        }),
      ],
    }),
  ],
  { sessionId: "ses_verify" },
)
try {
  const client = new Client({ name: "verify", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.specs[0].url)))
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map((t) => t.name), ["echo"])
  const called = await client.callTool({ name: "echo", arguments: { message: "hi" } })
  assert.deepEqual(called.content, [{ type: "text", text: "echo:hi" }])
  await client.close()
  console.log(JSON.stringify({ step: "mcp", listed: listed.tools.length }))
} finally {
  await stopSdkMcpHosts(mcp.hosts)
}

${
  platformPackage
    ? `
// A real spawn of the real binary, isolated, with the scratch lifecycle checked.
const scratchParent = mkdtempSync(path.join(os.tmpdir(), "verify-scratch-"))
try {
  const agentClient = await createAgentClient({
    spawn: {
      isolated: true,
      port: 0,
      scratchDir: scratchParent,
      timeout: 60000,
      env: { COGNITIO_DISABLE_MODELS_FETCH: "1" },
    },
  })
  const health = await fetch(new URL("/global/health", agentClient.baseUrl)).then((r) => r.json())
  assert.equal(health.version, ${JSON.stringify(expectedVersion)})
  assert.equal(readdirSync(scratchParent).length, 1)
  const session = await agentClient.sessions.create({})
  await session.close()
  await agentClient.close()
  assert.deepEqual(readdirSync(scratchParent), [], "the owned scratch must be removed on close")
  console.log(JSON.stringify({ step: "spawn", version: health.version }))
} finally {
  rmSync(scratchParent, { recursive: true, force: true })
}
`
    : `
// With the optional dependency omitted, the default spawn must fail with an
// actionable message rather than a bare ENOENT.
let message = ""
try {
  await createAgentClient({ spawn: { port: 0, timeout: 20000 } })
  throw new Error("expected the spawn to fail with no binary available")
} catch (error) {
  message = error instanceof Error ? error.message : String(error)
}
for (const needle of ["--omit=optional", "spawn.binaryPath", "COGNITIO_BIN_PATH", "PATH"]) {
  assert.ok(message.includes(needle), "missing '" + needle + "' in: " + message)
}
console.log(JSON.stringify({ step: "omit-optional", actionable: true }))
`
}
console.log("VERIFY_OK")
`
}

function makeConsumer(temp: string, name: string): string {
  const consumer = path.join(temp, name)
  mkdirSync(consumer, { recursive: true })
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name, private: true, type: "module", version: "0.0.0" }, null, 2),
  )
  return consumer
}

/** PATH with nothing on it, so an accidental PATH resolution cannot succeed. */
function sanitizedPath(temp: string): string {
  const empty = path.join(temp, "empty-path")
  mkdirSync(empty, { recursive: true })
  return empty
}

/**
 * The absolute path to the node interpreter, resolved while PATH is still
 * intact — the smoke runs with an empty PATH, so a bare `node` would not be
 * findable and the failure would look like a package problem.
 */
function nodeInterpreter(): string {
  const explicit = process.env.VERIFY_NODE
  if (explicit) return explicit
  const which = run(process.platform === "win32" ? "where" : "which", ["node"])
  const found = which.stdout.split("\n")[0]?.trim()
  if (which.status !== 0 || !found) fail("node", "no `node` on PATH; set VERIFY_NODE to an absolute path")
  return found
}

function runNodeSmoke(consumer: string, source: string, emptyPath: string, label: string, node: string) {
  const file = path.join(consumer, "smoke.mjs")
  writeFileSync(file, source)
  // Empty PATH: an accidental PATH resolution of the server binary must not be
  // able to make a broken install look healthy.
  const result = run(node, [file], { cwd: consumer, env: { PATH: emptyPath, NODE_OPTIONS: "" } })
  if (result.status !== 0 || !result.stdout.includes("VERIFY_OK")) {
    fail(label, `exit ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--")
  const unknown = argv.filter((arg) => !["--skip-build", "--require-platform"].includes(arg))
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`)

  console.log("=== verify:package ===\n")

  if (!argv.includes("--skip-build") || !existsSync(path.join(packageDir, "dist"))) {
    // See script/pack.ts: `composite: true` plus a stale tsbuildinfo makes tsc
    // a silent no-op, so the incremental cache is dropped before building.
    rmSync(path.join(packageDir, "tsconfig.tsbuildinfo"), { force: true })
    const build = spawnSync(process.execPath, ["run", "build"], { cwd: packageDir, stdio: "inherit" })
    if (build.status !== 0) throw new Error("bun run build failed")
  }

  const node = nodeInterpreter()
  const nodeVersion = run(node, ["--version"]).stdout.trim()
  const npmVersion = run("npm", ["--version"]).stdout.trim()
  console.log(`node ${nodeVersion} · npm ${npmVersion} · bun ${process.versions.bun}\n`)

  const temp = mkdtempSync(path.join(os.tmpdir(), "agent-sdk-verify-"))
  try {
    const staging = path.join(temp, "staging")
    const { version } = stagePackage(staging)
    const tarball = packDirectory(staging, path.join(temp, "pack"))
    const extracted = extract(tarball, path.join(temp, "extracted"))
    auditTarball(extracted)
    currentShapeControl(staging, temp)

    // libc matters: without it a musl host resolves the glibc package and would
    // stage or verify the wrong artifact entirely.
    const host = platformCandidate({
      platform: process.platform,
      arch: process.arch,
      ...(detectLibc() === undefined ? {} : { libc: detectLibc()! }),
    })
    const hostDir = host ? path.join(STAGE_DIR, host.packageName) : undefined
    const platformTarball =
      host && hostDir && existsSync(hostDir) ? packDirectory(hostDir, path.join(temp, "pack")) : undefined

    const emptyPath = sanitizedPath(temp)
    const sizes: string[] = [`sdk tarball ${(statSync(tarball).size / 1e6).toFixed(2)} MB`]

    if (argv.includes("--require-platform") && (!platformTarball || !host)) {
      fail("release platform required", "build the host platform binary before running verify:release")
    }

    // --- npm, with the platform package installed -------------------------
    if (!platformTarball || !host) {
      for (const manager of ["npm", "bun"]) {
        skip(`${manager} install of the tarball + platform package`, "no staged host platform package")
        skip(`plain-node smoke (${manager})`, "no staged host platform package")
      }
    } else {
      sizes.push(`platform tarball ${(statSync(platformTarball).size / 1e6).toFixed(2)} MB`)
      for (const manager of ["npm", "bun"] as const) {
        const consumer = makeConsumer(temp, `consumer-${manager}`)
        // --omit=optional on the install, then the platform tarball explicitly:
        // the eight optional deps are not published yet, so letting the manager
        // reach for them would 404. The published manifest's optionalDependencies
        // block is pinned separately by test/packaging.test.ts.
        const install =
          manager === "npm"
            ? run("npm", ["install", "--no-audit", "--no-fund", "--omit=optional", tarball, platformTarball], {
                cwd: consumer,
              })
            : run("bun", ["install", "--omit=optional", tarball, platformTarball], { cwd: consumer })
        if (install.status !== 0) fail(`${manager} install`, install.stderr || install.stdout)
        ok(`${manager} install of the tarball + platform package`)

        const out = runNodeSmoke(
          consumer,
          nodeSmokeSource(EXPECTED_SERVER_VERSION, host.packageName),
          emptyPath,
          `plain-node smoke (${manager})`,
          node,
        )
        ok(
          `plain-node smoke (${manager})`,
          out
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .join(" "),
        )
        const diskUsage = run("du", ["-sh", path.join(consumer, "node_modules")])
        const unpacked = diskUsage.status === 0 ? diskUsage.stdout?.split("\t")[0]?.trim() : undefined
        if (unpacked) sizes.push(`${manager} node_modules ${unpacked}`)
      }
    }

    // --- npm, with the optional dependency omitted --------------------------
    const omitted = makeConsumer(temp, "consumer-omit-optional")
    const omitInstall = run("npm", ["install", "--no-audit", "--no-fund", "--omit=optional", tarball], { cwd: omitted })
    if (omitInstall.status !== 0) fail("npm install --omit=optional", omitInstall.stderr || omitInstall.stdout)
    runNodeSmoke(omitted, nodeSmokeSource(EXPECTED_SERVER_VERSION, undefined), emptyPath, "omit-optional smoke", node)
    ok("--omit=optional: MCP still works and the default spawn fails actionably")

    if (host && platformTarball) {
      // And the documented escape hatch recovers it.
      const binary = path.join(STAGE_DIR, host.packageName, "bin", serverBinaryFileName(host.os))
      const recovery = `
import assert from "node:assert/strict"
import { createAgentClient } from "cognitio-agent-sdk"
const client = await createAgentClient({
  spawn: { isolated: true, port: 0, timeout: 60000, binaryPath: ${JSON.stringify(binary)},
           env: { COGNITIO_DISABLE_MODELS_FETCH: "1" } },
})
const health = await fetch(new URL("/global/health", client.baseUrl)).then((r) => r.json())
assert.equal(health.version, ${JSON.stringify(EXPECTED_SERVER_VERSION)})
await client.close()
console.log("VERIFY_OK")
`
      runNodeSmoke(omitted, recovery, emptyPath, "binaryPath recovery", node)
      ok("--omit=optional: spawn.binaryPath recovers")
    } else {
      skip("binaryPath recovery", "no staged platform package")
    }

    console.log(`\nsizes: ${sizes.join(" · ")}`)
    const version_ = version
    const skipped = results.filter((entry) => entry.status === "skip")
    console.log(
      `\n${results.filter((r) => r.status === "ok").length} checks passed, ${skipped.length} skipped` +
        ` for cognitio-agent-sdk@${version_}`,
    )
    if (skipped.length) {
      console.log("skipped checks did NOT run and must not be reported as coverage:")
      for (const entry of skipped) console.log(`  - ${entry.name}: ${entry.detail}`)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
