import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  PLATFORM_TARGETS,
  platformCandidate,
  platformPackageName,
  serverBinaryFileName,
} from "../src/internal/runtime-client/platform-packages.js"
import {
  describeMissingBinary,
  resetLibcCache,
  resolveServerBinary,
} from "../src/internal/runtime-client/resolve-binary.js"

/**
 * Binary resolution is pure and fully injected, so all eight targets are
 * exercised from one machine. The one place a real `require.resolve` and a real
 * filesystem are used is the fixture test at the bottom — everything the SDK
 * ships depends on that path behaving under hoisting and nested node_modules.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  resetLibcCache()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A resolver whose only known packages are the ones handed to it. */
function fakeResolver(installed: Record<string, string>) {
  return (specifier: string) => {
    const hit = installed[specifier]
    if (hit === undefined)
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" })
    return hit
  }
}

const allPresent = { exists: () => true, isExecutable: () => true }

describe("resolveServerBinary — order", () => {
  test("binaryPath beats the env var, the package, and PATH", () => {
    const resolved = resolveServerBinary({
      binaryPath: "/opt/custom/cognitio",
      env: { COGNITIO_BIN_PATH: "/opt/env/cognitio" },
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-darwin-arm64/package.json": "/pkg/package.json" }),
      ...allPresent,
    })
    // No candidate: an explicit path must not make a spawn failure blame a
    // bundled platform package the caller never asked for.
    expect(resolved).toEqual({ command: resolve("/opt/custom/cognitio"), source: "option" })
  })

  test("COGNITIO_BIN_PATH beats the package and PATH", () => {
    const resolved = resolveServerBinary({
      env: { COGNITIO_BIN_PATH: "/opt/env/cognitio" },
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-darwin-arm64/package.json": "/pkg/package.json" }),
      ...allPresent,
    })
    expect(resolved).toEqual({ command: resolve("/opt/env/cognitio"), source: "env" })
  })

  test("the platform package beats PATH", () => {
    const resolved = resolveServerBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-linux-x64/package.json": "/nm/pkg/package.json" }),
      ...allPresent,
    })
    expect(resolved).toEqual({
      command: join("/nm/pkg", "bin", "cognitio"),
      source: "package",
      candidate: "cognitio-agent-sdk-linux-x64",
    })
  })

  test("PATH is the last resort and hands the bare name to cross-spawn", () => {
    const resolved = resolveServerBinary({
      env: {},
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({}),
      ...allPresent,
    })
    // Never suffixed with .exe: cross-spawn owns PATHEXT resolution on win32.
    expect(resolved).toEqual({
      command: "cognitio",
      source: "path",
      candidate: "cognitio-agent-sdk-darwin-arm64",
    })
  })
})

describe("resolveServerBinary — the matrix", () => {
  test("every supported host has exactly one candidate", () => {
    const hosts = [
      { platform: "darwin", arch: "arm64", expected: "cognitio-agent-sdk-darwin-arm64" },
      { platform: "darwin", arch: "x64", expected: "cognitio-agent-sdk-darwin-x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" as const, expected: "cognitio-agent-sdk-linux-arm64" },
      { platform: "linux", arch: "arm64", libc: "musl" as const, expected: "cognitio-agent-sdk-linux-arm64-musl" },
      { platform: "linux", arch: "x64", libc: "glibc" as const, expected: "cognitio-agent-sdk-linux-x64" },
      { platform: "linux", arch: "x64", libc: "musl" as const, expected: "cognitio-agent-sdk-linux-x64-musl" },
      { platform: "win32", arch: "arm64", expected: "cognitio-agent-sdk-win32-arm64" },
      { platform: "win32", arch: "x64", expected: "cognitio-agent-sdk-win32-x64" },
    ]
    expect(hosts).toHaveLength(PLATFORM_TARGETS.length)
    for (const host of hosts) {
      expect(platformCandidate(host)?.packageName).toBe(host.expected)
    }
  })

  test("libc is strict: a musl host never falls back to glibc, or the reverse", () => {
    const musl = resolveServerBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      libc: "musl",
      // Only the glibc package is installed.
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-linux-x64/package.json": "/nm/glibc/package.json" }),
      ...allPresent,
    })
    expect(musl.source).toBe("path")
    expect(musl.candidate).toBe("cognitio-agent-sdk-linux-x64-musl")

    const glibc = resolveServerBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-linux-x64-musl/package.json": "/nm/musl/package.json" }),
      ...allPresent,
    })
    expect(glibc.source).toBe("path")
  })

  test("win32 looks for cognitio.exe", () => {
    const resolved = resolveServerBinary({
      env: {},
      platform: "win32",
      arch: "x64",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-win32-x64/package.json": "/nm/win/package.json" }),
      ...allPresent,
    })
    expect(resolved.command).toBe(join("/nm/win", "bin", "cognitio.exe"))
    expect(serverBinaryFileName("win32")).toBe("cognitio.exe")
    expect(serverBinaryFileName("linux")).toBe("cognitio")
  })

  test("an unsupported host still honours explicit choices and reports no candidate", () => {
    const shared = { env: {}, platform: "freebsd", arch: "riscv64", resolvePackage: fakeResolver({}), ...allPresent }
    expect(platformCandidate({ platform: "freebsd", arch: "riscv64" })).toBeUndefined()
    expect(resolveServerBinary(shared)).toEqual({ command: "cognitio", source: "path" })
    expect(resolveServerBinary({ ...shared, binaryPath: "/opt/cognitio" })).toMatchObject({ source: "option" })
    expect(resolveServerBinary({ ...shared, env: { COGNITIO_BIN_PATH: "/opt/cognitio" } })).toMatchObject({
      source: "env",
    })
    expect(describeMissingBinary(resolveServerBinary(shared), "freebsd", "riscv64")).toContain(
      "There is no bundled platform package for freebsd-riscv64",
    )
  })

  test("the missing-binary message never blames a package the caller did not choose", () => {
    const explicit = resolveServerBinary({
      binaryPath: "/opt/custom/cognitio",
      env: {},
      platform: "darwin",
      arch: "arm64",
      ...allPresent,
    })
    const message = describeMissingBinary(explicit, "darwin", "arm64")
    expect(message).toContain("supplied explicitly")
    expect(message).not.toContain("is not installed")

    const viaPath = resolveServerBinary({
      env: {},
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({}),
      ...allPresent,
    })
    expect(describeMissingBinary(viaPath, "darwin", "arm64")).toContain(
      "cognitio-agent-sdk-darwin-arm64 is not installed",
    )
  })

  test("platformPackageName is the only place scope and prefix are joined", () => {
    expect(platformPackageName("darwin", "arm64")).toBe("cognitio-agent-sdk-darwin-arm64")
    expect(platformPackageName("linux", "x64", "musl")).toBe("cognitio-agent-sdk-linux-x64-musl")
    expect(platformPackageName("linux", "x64", "glibc")).toBe("cognitio-agent-sdk-linux-x64")
  })
})

describe("resolveServerBinary — explicit paths", () => {
  test("relative paths normalize against cwd", () => {
    const resolved = resolveServerBinary({
      binaryPath: "./bin/cognitio",
      cwd: "/work/repo",
      env: {},
      platform: "linux",
      arch: "x64",
      ...allPresent,
    })
    expect(resolved.command).toBe(resolve("/work/repo", "bin", "cognitio"))
  })

  test("a bare command name is rejected rather than guessed at", () => {
    expect(() => resolveServerBinary({ binaryPath: "cognitio", env: {}, ...allPresent })).toThrow(
      /must be a path to the cognitio server binary, not the bare command name "cognitio"/,
    )
    expect(() => resolveServerBinary({ env: { COGNITIO_BIN_PATH: "cognitio" }, ...allPresent })).toThrow(
      /COGNITIO_BIN_PATH must be a path/,
    )
  })

  test("a missing or non-executable explicit path throws, naming the path", () => {
    expect(() =>
      resolveServerBinary({ binaryPath: "/nope/cognitio", env: {}, exists: () => false, isExecutable: () => true }),
    ).toThrow(`spawn.binaryPath points at ${resolve("/nope/cognitio")}, which does not exist.`)
    expect(() =>
      resolveServerBinary({ binaryPath: "/nope/cognitio", env: {}, exists: () => true, isExecutable: () => false }),
    ).toThrow(`spawn.binaryPath points at ${resolve("/nope/cognitio")}, which is not executable.`)
  })

  test("an empty binaryPath or env value is treated as unset", () => {
    expect(
      resolveServerBinary({ binaryPath: "", env: { COGNITIO_BIN_PATH: "" }, resolvePackage: fakeResolver({}) }),
    ).toMatchObject({ source: "path" })
  })
})

describe("resolveServerBinary — package errors", () => {
  test("MODULE_NOT_FOUND falls through to PATH", () => {
    const resolved = resolveServerBinary({
      env: {},
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({}),
      ...allPresent,
    })
    expect(resolved.source).toBe("path")
  })

  test("a corrupt or permission-denied package propagates instead of degrading silently", () => {
    // Claude's resolver swallows every error here, so a broken install quietly
    // becomes a PATH lookup and the user is told to reinstall. We do not copy that.
    for (const code of ["EACCES", "ERR_PACKAGE_PATH_NOT_EXPORTED", undefined]) {
      expect(() =>
        resolveServerBinary({
          env: {},
          platform: "darwin",
          arch: "arm64",
          resolvePackage: () => {
            throw Object.assign(new Error(`broken: ${code}`), code === undefined ? {} : { code })
          },
          ...allPresent,
        }),
      ).toThrow(`broken: ${code}`)
    }
  })

  test("a resolvable package whose binary is missing or unusable is an error, not a PATH fallback", () => {
    // Installed, resolvable, and yet unusable — a truncated download or a
    // dropped executable bit. Falling through to PATH hides that behind a
    // "not installed" message about a package that plainly is installed.
    const base = {
      env: {},
      platform: "darwin",
      arch: "arm64",
      resolvePackage: fakeResolver({ "cognitio-agent-sdk-darwin-arm64/package.json": "/nm/pkg/package.json" }),
    }
    expect(() => resolveServerBinary({ ...base, exists: () => false, isExecutable: () => true })).toThrow(
      /is installed but .* is missing/,
    )
    expect(() => resolveServerBinary({ ...base, exists: () => true, isExecutable: () => false })).toThrow(
      /is installed but .* is not executable/,
    )
  })
})

describe("resolveServerBinary — a real platform package on disk", () => {
  test.skipIf(process.platform === "win32")(
    "resolves through a real createRequire against a real node_modules tree",
    () => {
      // realpath: require.resolve returns the real path, and on macOS the OS
      // temp dir is a /var -> /private/var symlink.
      const root = realpathSync(tempDir("agent-sdk-platform-fixture-"))
      const target = platformCandidate({ platform: process.platform, arch: process.arch, libc: "glibc" })
      // The fixture only makes sense on a host we actually ship for.
      if (!target) return
      const pkgDir = join(root, "node_modules", ...target.packageName.split("/"))
      mkdirSync(join(pkgDir, "bin"), { recursive: true })
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: target.packageName, version: "2.0.0-beta.1", os: [target.os], cpu: [target.arch] }),
      )
      const binary = join(pkgDir, "bin", serverBinaryFileName(target.os))
      writeFileSync(binary, "#!/bin/sh\nexit 0\n")
      chmodSync(binary, 0o755)

      const require_ = createRequire(join(root, "index.js"))
      const resolved = resolveServerBinary({
        env: {},
        libc: "glibc",
        resolvePackage: (specifier) => require_.resolve(specifier),
      })
      expect(resolved).toEqual({ command: binary, source: "package", candidate: target.packageName })

      // And the manifest the resolver went through carries the pinned version,
      // which is what makes the four-way pin check meaningful at install time.
      expect(require(join(pkgDir, "package.json")).version).toBe("2.0.0-beta.1")
    },
  )
})
