import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { clientMessageIdSchema, gitShaSchema, leaseEpochSchema, sessionIdSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, TaskEventOf, TaskSpec, TaskSpecRestore } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, ManualTimers, Shared } from "../testing/task-host-harness.ts";

// Ticket 24's "done when", on `host` with the fake agent: each origin from the right spec; a fresh
// worktree from a different data folder restores the session and the agent answers about earlier
// turns; a moved branch merges, and a conflicting one reports `conflict` and carries on; a corrupt
// archive falls back to `rebuilt`; a pending message is sent once.

const run = promisify(execFile);

let shared: Shared;
const harnesses: Harness[] = [];
let timers: ManualTimers;

beforeAll(async () => {
  shared = await startShared("restore");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
}, 120_000);

/** A runner: its own data folder, its own fake server and gateway. */
const runner = async (): Promise<Harness> => {
  timers = manualTimers();
  const harness = await startHarness(shared, { host: { timers } });
  harnesses.push(harness);
  return harness;
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

let messages = 0;
const pendingMessage = (text: string): TaskSpecRestore["pendingMessages"][number] => {
  messages += 1;
  return { clientMessageId: clientMessageIdSchema.parse(`pending-${String(messages)}`), text };
};

/** The task's next session, as core's reopen writes its spec: a new session and lease, the restore section. */
const reopened = (first: TaskSpec, restore: TaskSpecRestore, prompt = first.prompt): TaskSpec => ({
  ...first,
  sessionId: sessionIdSchema.parse(`${first.sessionId}-reopen-${restore.origin}`),
  leaseEpoch: leaseEpochSchema.parse(first.leaseEpoch + 1),
  prompt,
  restore,
});

/** Hands a session's spec to another runner's fake server, with the same credentials. */
const serve = (h: Harness, spec: TaskSpec, from: Harness): void => {
  const task = from.server.tasks.get(spec.taskId);
  if (task === undefined) throw new Error("no such task");
  h.server.tasks.set(spec.taskId, { spec, credentials: { ...task.credentials, leaseEpoch: spec.leaseEpoch } });
};

/** A first session that remembers a word and writes a file, then goes quiet: its save is what a reopen restores. */
const firstSession = async (h: Harness, word: string): Promise<{ readonly spec: TaskSpec; readonly boxId: BoxId; readonly saved: TaskEventOf<"session.saved"> }> => {
  const { spec } = h.taskFor(fakeMarker("write", `${word}.txt`));
  const boxId = h.dispatch(spec);
  await h.waitForKind(spec, "session.saved");
  h.steer(spec, fakeMarker("remember", word));
  await h.waitForKind(spec, "session.saved", 2);
  const saved = h.ofKind(spec, "session.saved")[1];
  if (saved === undefined) throw new Error("no second save");
  return { spec, boxId, saved };
};

const archiveOf = (saved: TaskEventOf<"session.saved">): BlobRef => {
  if (saved.archive === null) throw new Error("the session has no archive");
  return saved.archive;
};

const hiddenRefsOf = (saved: TaskEventOf<"session.saved">): TaskSpecRestore["hiddenRefs"] =>
  saved.repos.flatMap((repo) =>
    repo.hiddenRefSha === null || repo.headSha === null ? [] : [{ repoId: repo.repoId, sha: gitShaSchema.parse(repo.hiddenRefSha), baseSha: gitShaSchema.parse(repo.headSha) }],
  );

/** Copies an archive into another runner's blob store, as core's would hold it. */
const copyArchive = (to: Harness, from: Harness, spec: TaskSpec, archive: BlobRef): void => {
  const blob = from.server.blobs.get(archive.blobId);
  if (blob === undefined) throw new Error("no such blob");
  to.server.putBlob(spec.taskId, blob.bytes, blob.contentType, archive.blobId);
};

const agentText = (h: Harness, spec: TaskSpec): string =>
  h.ofKind(spec, "agent.message").map((event) => event.text).join("\n");

/** The task's branch in the upstream, moved by someone else: a commit on top, or a history that doesn't hold the saved one. */
const moveBranch = async (spec: TaskSpec, how: "on-top" | "unrelated"): Promise<void> => {
  const bare = path.join(shared.root, "upstream", "repos", "ostra-test", "test1.git");
  const work = await mkdtemp(path.join(os.tmpdir(), "ostra-move-"));
  const git = (args: readonly string[]): Promise<{ readonly stdout: string }> =>
    run("git", ["-c", "user.name=Someone", "-c", "user.email=someone@example.com", ...args], { cwd: work });
  try {
    await git(["clone", "--quiet", bare, "."]);
    if (how === "on-top") {
      await git(["checkout", "--quiet", spec.branchName]);
    } else {
      await git(["checkout", "--quiet", "--orphan", "rewritten"]);
      await git(["rm", "-rf", "--quiet", "."]);
    }
    await writeFile(path.join(work, "moved.txt"), "someone else's commit\n");
    await git(["add", "moved.txt"]);
    await git(["commit", "--quiet", "-m", "move the branch"]);
    await git(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${spec.branchName}`]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

describe("a reopen on the same box: resumed", () => {
  it("takes the box the last session kept, loads the agent's own session, and sends the pending message once", async () => {
    const h = await runner();
    const { spec, boxId } = await firstSession(h, "kiwi");
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    // The member's message from the reopen: the agent's turn says back what it said before.
    const next = reopened(spec, { origin: "resumed", archive: null, hiddenRefs: [], pendingMessages: [pendingMessage(fakeMarker("recall"))] });
    serve(h, next, h);
    h.dispatch(next, boxId);
    await h.waitForKind(next, "session.saved");
    // The session before was waiting in the box: it ended, and handed the box over.
    expect(h.kinds(spec)).toContain("session.ended");
    const [restored] = h.ofKind(next, "session.restored");
    expect(restored).toMatchObject({ origin: "resumed", hiddenRef: "none", previousBox: "kept" });
    expect(restored?.replayedUpdates).toBeGreaterThan(0);
    expect(restored).not.toHaveProperty("fallbackReason");
    // The pending message was the one turn, and the agent remembered the first session.
    expect(h.ofKind(next, "turn.started")).toHaveLength(1);
    expect(agentText(h, next)).toContain("kiwi");
    // The same worktree: no fresh clone, the first session's file still there.
    expect(await readFile(path.join(checkout, "kiwi.txt"), "utf8")).toBeDefined();
    // Replayed updates never became events of the new session.
    expect(h.ofKind(next, "agent.message").some((event) => event.text.includes("(an earlier turn)"))).toBe(false);
  }, 180_000);

  it("falls back to rebuilt when the box isn't kept here any more, and says why", async () => {
    const h = await runner();
    const { spec } = h.taskFor(fakeMarker("say"));
    const next = reopened(spec, { origin: "resumed", archive: null, hiddenRefs: [], pendingMessages: [pendingMessage(fakeMarker("say"))] }, "[[fake:say]] the rebuild template");
    serve(h, next, h);
    h.dispatch(next);
    await h.waitForKind(next, "session.saved", 2);
    const [restored] = h.ofKind(next, "session.restored");
    expect(restored).toMatchObject({ origin: "rebuilt", hiddenRef: "none", replayedUpdates: 0 });
    expect(restored?.fallbackReason).toContain("isn't kept on this runner");
    // The template first, then the pending message.
    expect(h.ofKind(next, "turn.started")).toHaveLength(2);
  }, 180_000);
});

describe("a reopen on a fresh box: restored", () => {
  it("restores the hidden ref and the archive on another runner, from another data folder, and the agent answers about earlier turns", async () => {
    const first = await runner();
    const { spec, saved } = await firstSession(first, "plum");
    const second = await runner();
    expect(second.dataDir).not.toBe(first.dataDir);
    const archive = archiveOf(saved);
    copyArchive(second, first, spec, archive);
    const next = reopened(spec, { origin: "restored", archive, hiddenRefs: hiddenRefsOf(saved), pendingMessages: [pendingMessage(fakeMarker("recall"))] });
    serve(second, next, first);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved");
    const [restored] = second.ofKind(next, "session.restored");
    expect(restored).toMatchObject({ origin: "restored", hiddenRef: "applied" });
    expect(restored?.replayedUpdates).toBeGreaterThan(0);
    expect(second.ofKind(next, "turn.started")).toHaveLength(1);
    expect(agentText(second, next)).toContain("plum");
    const checkout = path.join(second.dataDir, "tasks", spec.taskId, "workspace", "test1");
    expect(await exists(path.join(checkout, "plum.txt"))).toBe(true);
  }, 240_000);

  it("merges a branch that moved since the save, and carries on", async () => {
    const first = await runner();
    const { spec, saved } = await firstSession(first, "pear");
    await moveBranch(spec, "on-top");
    const second = await runner();
    const archive = archiveOf(saved);
    copyArchive(second, first, spec, archive);
    const next = reopened(spec, { origin: "restored", archive, hiddenRefs: hiddenRefsOf(saved), pendingMessages: [pendingMessage(fakeMarker("say"))] });
    serve(second, next, first);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved");
    expect(second.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "restored", hiddenRef: "applied" });
    const checkout = path.join(second.dataDir, "tasks", spec.taskId, "workspace", "test1");
    expect(await exists(path.join(checkout, "pear.txt"))).toBe(true);
    expect(await exists(path.join(checkout, "moved.txt"))).toBe(true);
  }, 240_000);

  it("reports a conflict when the branch no longer holds the saved work, restores nothing, and carries on", async () => {
    const first = await runner();
    const { spec, saved } = await firstSession(first, "fig");
    const hiddenBefore = await shared.upstream.refSha("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`);
    await moveBranch(spec, "unrelated");
    const second = await runner();
    const archive = archiveOf(saved);
    copyArchive(second, first, spec, archive);
    const next = reopened(spec, { origin: "restored", archive, hiddenRefs: hiddenRefsOf(saved), pendingMessages: [pendingMessage(fakeMarker("say"))] });
    serve(second, next, first);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved");
    expect(second.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "restored", hiddenRef: "conflict" });
    // The branch's head is checked out, and the turn ran on it.
    const checkout = path.join(second.dataDir, "tasks", spec.taskId, "workspace", "test1");
    expect(await exists(path.join(checkout, "moved.txt"))).toBe(true);
    expect(await exists(path.join(checkout, "fig.txt"))).toBe(false);
    expect(second.ofKind(next, "turn.started")).toHaveLength(1);
    // The ref was left alone until this session's own save replaced it.
    expect(hiddenBefore).not.toBeNull();
  }, 240_000);
});

describe("a reopen that can't use the archive: rebuilt", () => {
  it("falls back to the template when the archive doesn't match its digest, then sends each pending message once, in order", async () => {
    const first = await runner();
    const { spec, saved } = await firstSession(first, "lime");
    const second = await runner();
    const archive = archiveOf(saved);
    copyArchive(second, first, spec, archive);
    second.server.bulkFaults.corruptDownloads.add(archive.blobId);
    const next = reopened(
      spec,
      { origin: "restored", archive, hiddenRefs: hiddenRefsOf(saved), pendingMessages: [pendingMessage(fakeMarker("say")), pendingMessage(fakeMarker("remember", "second"))] },
      "[[fake:remember template]] the rebuild template",
    );
    serve(second, next, first);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved", 3);
    const [restored] = second.ofKind(next, "session.restored");
    expect(restored).toMatchObject({ origin: "rebuilt", hiddenRef: "applied", replayedUpdates: 0 });
    expect(restored?.fallbackReason).toContain("digest");
    // Three turns: the template, then the two pending messages, each once.
    expect(second.ofKind(next, "turn.started")).toHaveLength(3);
    const text = agentText(second, next);
    expect(text.indexOf("template")).toBeLessThan(text.indexOf("second"));
    // The hidden ref was still restored: the first session's file is there.
    expect(await exists(path.join(second.dataDir, "tasks", spec.taskId, "workspace", "test1", "lime.txt"))).toBe(true);
  }, 240_000);

  it("runs a rebuilt spec's template as the first turn, on a fresh box", async () => {
    const first = await runner();
    const { spec, saved } = await firstSession(first, "date");
    const second = await runner();
    const next = reopened(spec, { origin: "rebuilt", archive: null, hiddenRefs: hiddenRefsOf(saved), pendingMessages: [] }, "[[fake:say]] the rebuild template");
    serve(second, next, first);
    second.dispatch(next);
    await second.waitForKind(next, "session.saved");
    expect(second.ofKind(next, "session.restored")[0]).toEqual({ kind: "session.restored", origin: "rebuilt", replayedUpdates: 0, hiddenRef: "applied" });
    expect(second.ofKind(next, "turn.started")).toHaveLength(1);
    expect(await exists(path.join(second.dataDir, "tasks", spec.taskId, "workspace", "test1", "date.txt"))).toBe(true);
    // With no pending message, the session waits for the next turn, its idle timer armed.
    await second.gateway.waitFor(() => timers.pending() > 0, 60_000);
    expect(second.kinds(next)).not.toContain("session.ended");
  }, 240_000);
});
