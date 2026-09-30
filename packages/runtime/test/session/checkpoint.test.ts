import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Hash } from "@cognitio/shared/util/hash"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session, SessionCheckpoint } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database, and, eq } from "../../src/storage"
import { SessionCheckpointTable } from "../../src/session/session.sql"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")
const modelID = ModelID.make("test")

afterEach(async () => {
  await Instance.disposeAll()
})

function createSession(input?: Session.CreateInput) {
  return AppRuntime.runPromise(Session.Service.use((svc) => svc.create(input)))
}

function createCheckpoint(input: SessionCheckpoint.CreateInput) {
  return AppRuntime.runPromise(SessionCheckpoint.Service.use((svc) => svc.create(input)))
}

function listCheckpoints(sessionID: SessionID) {
  return AppRuntime.runPromise(SessionCheckpoint.Service.use((svc) => svc.list(sessionID)))
}

function rewind(input: { sessionID: SessionID; checkpointID: SessionCheckpoint.Info["id"] }) {
  return AppRuntime.runPromise(SessionCheckpoint.Service.use((svc) => svc.rewind(input)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(Session.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(Session.Service.use((svc) => svc.updatePart(part)))
}

function snapshotGitdir() {
  return path.join(Global.Path.data, "snapshot", Instance.project.id, Hash.fast(Instance.worktree))
}

async function gitSnapshot(args: string[]) {
  const proc = Bun.spawn(["git", "--git-dir", snapshotGitdir(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const result = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()])
  if (result[0] === 0) return
  throw new Error(result[1])
}

function storedSnapshot(sessionID: SessionID, checkpointID: SessionCheckpoint.Info["id"]) {
  const row = Database.use((db) =>
    db
      .select()
      .from(SessionCheckpointTable)
      .where(
        and(eq(SessionCheckpointTable.session_id, sessionID), eq(SessionCheckpointTable.checkpoint_id, checkpointID)),
      )
      .get(),
  )
  if (!row) throw new Error(`Missing checkpoint row: ${checkpointID}`)
  return row.snapshot
}

function replaceStoredSnapshot(sessionID: SessionID, checkpointID: SessionCheckpoint.Info["id"], snapshot: string) {
  Database.use((db) =>
    db
      .update(SessionCheckpointTable)
      .set({ snapshot })
      .where(
        and(eq(SessionCheckpointTable.session_id, sessionID), eq(SessionCheckpointTable.checkpoint_id, checkpointID)),
      )
      .run(),
  )
}

async function addUser(sessionID: SessionID, text = "checkpoint") {
  const message = await updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
  } satisfies MessageV2.User)
  await updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message
}

describe("SessionCheckpoint", () => {
  test("manual checkpoint create/list/rewind restores edits and deletes post-checkpoint files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-rewind" })
        const user = await addUser(session.id)
        const tracked = path.join(tmp.path, "tracked.txt")
        const added = path.join(tmp.path, "added.txt")

        await Bun.write(tracked, "before")
        const checkpoint = await createCheckpoint({
          sessionID: session.id,
          messageID: user.id,
          label: "before edit",
          source: "manual",
        })

        expect(checkpoint.id).toStartWith("chk_")
        expect(checkpoint).not.toHaveProperty("snapshot")
        expect(await listCheckpoints(session.id)).toEqual([checkpoint])

        await gitSnapshot(["gc", "--prune=now", "--quiet"])

        await Bun.write(tracked, "after")
        await Bun.write(added, "new")

        const result = await rewind({ sessionID: session.id, checkpointID: checkpoint.id })
        expect(result.checkpointID).toBe(checkpoint.id)
        expect(result.affectedFiles.toSorted()).toEqual(
          [tracked, added].map((file) => file.replaceAll("\\", "/")).toSorted(),
        )
        expect(await Bun.file(tracked).text()).toBe("before")
        expect(await Bun.file(added).exists()).toBe(false)
      },
    })
  })

  test("rewind rejects corrupt stored snapshots before changing files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-corrupt" })
        const tracked = path.join(tmp.path, "tracked.txt")
        const added = path.join(tmp.path, "added.txt")

        await Bun.write(tracked, "before")
        const checkpoint = await createCheckpoint({ sessionID: session.id, source: "manual" })
        await Bun.write(tracked, "after")
        await Bun.write(added, "new")
        replaceStoredSnapshot(session.id, checkpoint.id, "0".repeat(40))

        await expect(rewind({ sessionID: session.id, checkpointID: checkpoint.id })).rejects.toThrow(
          "SnapshotUnavailableError",
        )
        expect(await Bun.file(tracked).text()).toBe("after")
        expect(await Bun.file(added).text()).toBe("new")
      },
    })
  })

  test("auto checkpoints dedupe identical snapshots while manual checkpoints do not", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-dedupe" })
        await Bun.write(path.join(tmp.path, "state.txt"), "same")

        const first = await createCheckpoint({
          sessionID: session.id,
          source: "auto",
          metadata: { tool: "write", callID: "call-write" },
          allowBusy: true,
        })
        const second = await createCheckpoint({ sessionID: session.id, source: "auto", allowBusy: true })
        const manual = await createCheckpoint({ sessionID: session.id, source: "manual" })

        expect(second.id).toBe(first.id)
        expect(first.metadata).toEqual({ tool: "write", callID: "call-write" })
        expect(manual.id).not.toBe(first.id)
        expect((await listCheckpoints(session.id)).map((item) => item.id)).toEqual([first.id, manual.id])
      },
    })
  })

  test("auto checkpoint dedupe returns the existing row and restores pinning", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-dedupe-pin" })
        const state = path.join(tmp.path, "state.txt")

        await Bun.write(state, "same")
        const first = await createCheckpoint({ sessionID: session.id, source: "auto", allowBusy: true })
        const snapshot = storedSnapshot(session.id, first.id)
        await gitSnapshot(["update-ref", "-d", `refs/cognitio/checkpoints/${snapshot}`])

        const second = await createCheckpoint({ sessionID: session.id, source: "auto", allowBusy: true })
        expect(second.id).toBe(first.id)

        await gitSnapshot(["gc", "--prune=now", "--quiet"])
        await Bun.write(state, "after")

        const result = await rewind({ sessionID: session.id, checkpointID: first.id })
        expect(result.affectedFiles).toContain(state.replaceAll("\\", "/"))
        expect(await Bun.file(state).text()).toBe("same")
      },
    })
  })

  test("fork copies tags and eligible checkpoints with remapped message ids", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-fork" })
        const user = await addUser(session.id)
        await Bun.write(path.join(tmp.path, "fork.txt"), "before")
        await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.setTags({ sessionID: session.id, tags: ["phase7"] })),
        )
        const checkpoint = await createCheckpoint({
          sessionID: session.id,
          messageID: user.id,
          label: "fork me",
          source: "manual",
        })

        const fork = await AppRuntime.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: session.id })))
        const forkedCheckpoints = await listCheckpoints(fork.id)

        expect(fork.parentID).toBe(session.id)
        expect(fork.tags).toEqual(["phase7"])
        expect(forkedCheckpoints).toHaveLength(1)
        expect(forkedCheckpoints[0]).toMatchObject({
          id: checkpoint.id,
          sessionID: fork.id,
          label: "fork me",
          source: "manual",
        })
        expect(forkedCheckpoints[0]!.messageID).toStartWith("msg_")
        expect(forkedCheckpoints[0]!.messageID).not.toBe(checkpoint.messageID)
      },
    })
  })

  test("fork at message includes the target message and its checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-fork-at" })
        await addUser(session.id, "first")
        const target = await addUser(session.id, "target")
        const after = await addUser(session.id, "after")
        await Bun.write(path.join(tmp.path, "target.txt"), "before")
        const checkpoint = await createCheckpoint({
          sessionID: session.id,
          messageID: target.id,
          label: "target",
          source: "manual",
        })

        const fork = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.fork({ sessionID: session.id, messageID: target.id })),
        )
        const forkMessages = await AppRuntime.runPromise(
          Session.Service.use((svc) => svc.messages({ sessionID: fork.id })),
        )
        const forkedCheckpoints = await listCheckpoints(fork.id)

        expect(forkMessages.map((item) => item.parts.find((part) => part.type === "text")?.text)).toEqual([
          "first",
          "target",
        ])
        expect(forkMessages.map((item) => item.parts.find((part) => part.type === "text")?.text)).not.toContain("after")
        expect(forkedCheckpoints).toHaveLength(1)
        expect(forkedCheckpoints[0]).toMatchObject({
          id: checkpoint.id,
          sessionID: fork.id,
          label: "target",
        })
        expect(forkedCheckpoints[0]!.messageID).toBe(forkMessages[1]!.info.id)
        expect(after.id).toStartWith("msg_")
      },
    })
  })

  test("fork at missing or cross-session message fails before creating a child", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await createSession({ title: "checkpoint-fork-invalid" })
        const other = await createSession({ title: "checkpoint-fork-other" })
        const otherMessage = await addUser(other.id, "other")

        await expect(
          AppRuntime.runPromise(
            Session.Service.use((svc) => svc.fork({ sessionID: session.id, messageID: otherMessage.id })),
          ),
        ).rejects.toThrow("NotFoundError")

        const children = await AppRuntime.runPromise(Session.Service.use((svc) => svc.children(session.id)))
        expect(children).toEqual([])
      },
    })
  })
})
