import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent, defineCommand, definePlugin, defineSkill, type AgentOptions } from "cognitio-agent-sdk"
import { exampleOptions, runExample } from "./support/options.js"

/**
 * Uses a disposable Git workspace and an owned local runtime so rewind cannot
 * touch the caller's project. Pass spawn options to customize that runtime;
 * borrowed clients and remote connections cannot own this workspace's cleanup.
 */
export async function run(options: AgentOptions = {}) {
  if (options.client !== undefined || options.baseUrl !== undefined)
    throw new Error("This disposable-workspace example requires an owned local runtime; pass spawn options instead.")
  const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cognitio-session-example-")))
  const file = path.join(workspace, "example.txt")
  const hooks: string[] = []
  const agent = new Agent({
    ...exampleOptions(options),
    spawn: options.spawn ?? {},
    cwd: undefined,
    directory: undefined,
    disallowedTools: ["*"],
    compaction: { auto: false, includeFiles: false },
    checkpointing: { enabled: true, beforeCompaction: true },
    commands: [defineCommand({ name: "review", template: "EXAMPLE_COMMAND: Review this: $ARGUMENTS" })],
    plugins: [
      definePlugin({
        name: "editorial",
        skills: [
          defineSkill({ name: "plain-writing", description: "Write clearly.", content: "Use short sentences." }),
        ],
      }),
    ],
    hooks: {
      PreCompact: [
        () => {
          hooks.push("PreCompact")
          return { customInstructions: "EXAMPLE_HOOK_INSTRUCTION" }
        },
      ],
      PostCompact: [
        () => {
          hooks.push("PostCompact")
        },
      ],
    },
  })
  try {
    writeFileSync(file, "original\n")
    for (const args of [
      ["init"],
      ["add", "example.txt"],
      [
        "-c",
        "user.name=Example",
        "-c",
        "user.email=example@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Example fixture",
      ],
    ]) {
      const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(`Git workspace setup failed: ${result.stderr}`)
    }
    const session = await agent.createSession({ cwd: workspace, title: "Session features" })
    await session.send("EXAMPLE_SESSION_FEATURES: Remember the acceptance criteria.")
    const checkpoint = await session.checkpoint("before-change")
    writeFileSync(file, "changed\n")
    const rewind = await session.rewind(checkpoint.id)
    const restoredText = readFileSync(file, "utf8")
    const command = await session.command("review", "Agents use tools.")
    const fork = await agent.fork(session.id)
    writeFileSync(file, "state before compaction\n")
    const summary = await session.compact({
      customInstructions: "EXAMPLE_COMPACT_INSTRUCTION: Preserve acceptance criteria.",
    })
    return {
      restoredText,
      rewind,
      command,
      summary,
      hooks,
      forkId: fork.id,
      sessionId: session.id,
      checkpoints: await session.listCheckpoints(),
      settings: await session.getAppliedSettings(),
    }
  } finally {
    // Closing the dedicated runtime releases its instance resources before
    // removing the directory. A shared runtime could keep it locked on Windows.
    await agent.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (import.meta.main) await runExample(run)
