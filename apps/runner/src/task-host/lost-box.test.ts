import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { clientMessageIdSchema, gitShaSchema, leaseEpochSchema, sessionIdSchema } from "@ostra/protocol";
import type { TaskEventOf, TaskSpec, TaskSpecRestore } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";

// F-047, F-045 (ADR 0039, Q150): a box lost with its runner, on `host` with the fake agent. The
// runner stops in the middle of a turn that answers a member's message, and its worktree is deleted
// while it's down. Started again on its data folder, as `ostra runner` is, it reports the session
// crashed; the branch and the hidden ref stay upstream; the reopen core then sends makes a fresh box
// from the last finished turn's archive and the hidden ref, and the agent answers the message the
// lost turn was answering, once.

let shared: Shared;
const harnesses: Harness[] = [];

beforeAll(async () => {
  shared = await startShared("lost-box");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  // The restarted runner first: the server and gateway are its first life's.
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }
}, 120_000);

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const agentText = (h: Harness, spec: TaskSpec): string =>
  h.ofKind(spec, "agent.message").map((event) => event.text).join("\n");

describe("a box lost with its runner (F-047)", () => {
  it("F-047/c1,c2, F-045/c3: the restarted runner reports the session crashed, keeps the branch and the hidden ref, and the reopen restores a fresh box and replays the lost turn's message once", async () => {
    const first = await startHarness(shared, { host: { timers: manualTimers() } });
    harnesses.push(first);
    // Two finished turns: a file written, then a word remembered. The second's save is the last one.
    const { spec } = first.taskFor(fakeMarker("write", "kiwi.txt"));
    first.dispatch(spec);
    await first.waitForKind(spec, "session.saved");
    first.steer(spec, fakeMarker("remember", "kiwi"));
    await first.waitForKind(spec, "session.saved", 2);
    const saved: TaskEventOf<"session.saved"> | undefined = first.ofKind(spec, "session.saved")[1];
    const [repo] = saved?.repos ?? [];
    if (saved?.archive === null || saved === undefined || repo?.hiddenRefSha === null || repo?.headSha === null || repo === undefined) {
      throw new Error("the second turn saved no archive or hidden ref");
    }

    // The member's next message starts a turn, and the runner's process goes in the middle of it.
    const lostMessage = fakeMarker("long", "3");
    first.steer(spec, lostMessage);
    await first.waitForKind(spec, "turn.started", 3);
    await first.killRunner();
    expect(first.kinds(spec)).not.toContain("session.crashed");
    // Its box goes while it's down: the task's worktree is deleted.
    const taskFolder = path.join(first.dataDir, "tasks", spec.taskId);
    await rm(taskFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

    // Started again on the same data folder: it reports the session it held as crashed.
    const again = await startHarness(shared, { restartOf: first, host: { timers: manualTimers() } });
    harnesses.push(again);
    await again.waitForKind(spec, "session.crashed");
    expect(again.ofKind(spec, "session.crashed")).toEqual([expect.objectContaining({ error: "the runner restarted while the session was running" })]);
    expect(again.everyEventOnce()).toBe(true);
    // The branch and the hidden ref stay as the last save left them.
    expect(await shared.upstream.refSha("ostra-test/test1", `refs/heads/${spec.branchName}`)).toBe(repo.headSha);
    expect(await shared.upstream.refSha("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toBe(repo.hiddenRefSha);

    // One reopen, as core writes it for a crashed task whose box is gone: a new session and lease on
    // a fresh box, from the last finished turn's archive and the hidden ref, with the message the
    // lost turn was answering, from the event log.
    const restore: TaskSpecRestore = {
      origin: "restored",
      archive: saved.archive,
      hiddenRefs: [{ repoId: repo.repoId, sha: gitShaSchema.parse(repo.hiddenRefSha), baseSha: gitShaSchema.parse(repo.headSha) }],
      pendingMessages: [{ clientMessageId: clientMessageIdSchema.parse("lost-turn-message"), text: lostMessage }],
    };
    const next: TaskSpec = { ...spec, sessionId: sessionIdSchema.parse(`${spec.sessionId}-reopened`), leaseEpoch: leaseEpochSchema.parse(spec.leaseEpoch + 1), restore };
    const task = again.server.tasks.get(spec.taskId);
    if (task === undefined) throw new Error("no such task");
    again.server.tasks.set(spec.taskId, { spec: next, credentials: { ...task.credentials, leaseEpoch: next.leaseEpoch } });
    again.dispatch(next);
    await again.waitForKind(next, "session.saved");
    expect(again.ofKind(next, "session.restored")[0]).toMatchObject({ origin: "restored", hiddenRef: "applied" });
    // The fresh worktree holds the first turn's file; the agent's own session came back from the archive.
    expect(await exists(path.join(taskFolder, "workspace", "test1", "kiwi.txt"))).toBe(true);
    expect(again.ofKind(next, "session.restored")[0]?.replayedUpdates).toBeGreaterThan(0);
    // The lost turn's message is answered once: one turn, which finishes the long step.
    expect(again.ofKind(next, "turn.started")).toHaveLength(1);
    expect(agentText(again, next)).toContain("The long step is done.");
    expect(again.everyEventOnce()).toBe(true);
  }, 240_000);
});
