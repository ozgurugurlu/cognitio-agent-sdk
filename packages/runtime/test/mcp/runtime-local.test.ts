import { expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { MCP } from "../../src/mcp"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { fileURLToPath } from "node:url"

test("real session stdio MCP process receives explicit environment and cwd, stays scoped, and closes", async () => {
  // Existing transport unit tests mock the MCP package process-wide. Keep this
  // integration check in a fresh process even when the monolithic suite runs it.
  if (process.env.COGNITIO_MCP_TEST_CHILD !== "1") {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, COGNITIO_MCP_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`MCP process integration failed:\n${stdout}\n${stderr}`)
    return
  }
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = SessionID.descending()
      const tools = await AppRuntime.runPromise(
        MCP.Service.use((svc) =>
          svc.tools({
            sessionID,
            servers: [
              {
                name: "fixture",
                type: "local",
                command: [process.execPath, fileURLToPath(new URL("../fixture/runtime-mcp-stdio.ts", import.meta.url))],
                environment: { MCP_TEST_MARKER: "session-specific" },
                cwd: tmp.path,
                timeout: 5000,
              },
            ],
          }),
        ),
      )
      expect(Object.keys(tools)).toEqual(["fixture_context"])
      const output = await tools.fixture_context.execute?.(
        {},
        { toolCallId: "fixture", messages: [], abortSignal: new AbortController().signal },
      )
      expect(JSON.stringify(output)).toContain("session-specific")
      expect(JSON.stringify(output)).toContain(tmp.path)
      expect(
        await AppRuntime.runPromise(
          MCP.Service.use((svc) => svc.tools({ sessionID: SessionID.descending(), servers: [] })),
        ),
      ).toEqual({})
      await AppRuntime.runPromise(MCP.Service.use((svc) => svc.clearRuntime(sessionID)))
      expect(await AppRuntime.runPromise(MCP.Service.use((svc) => svc.tools({ sessionID, servers: [] })))).toEqual({})
    },
  })
}, 15000)
