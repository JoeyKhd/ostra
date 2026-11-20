import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, ManualTimers, Shared } from "../testing/task-host-harness.ts";
import { agentLeftoverPaths } from "./leftovers.ts";

// Ticket 23's "done when", with a fake clock for the idle timer: the session ends after the idle
// time and not before; a steer resets the timer; a waiting turn is cancelled, saved, then ended;
// `release` removes everything and is idempotent; nothing of the task is left in the temp folder.

const MINUTE = 60_000;

let shared: Shared;
let harness: Harness | undefined;
let timers: ManualTimers;
let tempDir = "";

beforeAll(async () => {
  shared = await startShared("idle-and-release");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await rm(tempDir, { recursive: true, force: true });
}, 60_000);

const start = async (): Promise<Harness> => {
  timers = manualTimers();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ostra-idle-temp-"));
  harness = await startHarness(shared, { host: { timers, tempDir } });
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

/** Waits until the session waits between turns: its idle timer is armed. */
const waitingForTurn = async (h: Harness): Promise<void> => {
  await h.gateway.waitFor(() => timers.pending() > 0, 60_000);
};

describe("the idle timer (F-096)", () => {
  it("ends the session after the idle time and not before, stops the agent, and keeps the box", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("write", "idle.txt"), { limits: { turnMaxMinutes: 30, idleMinutes: 15 } });
    const boxId = h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    await waitingForTurn(h);
    timers.advance(14 * MINUTE);
    // Give a fired timer the chance to show: nothing ends a minute early.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.kinds(spec)).not.toContain("session.ended");
    expect(h.host.running()).toHaveLength(1);
    timers.advance(MINUTE);
    await h.waitForKind(spec, "session.ended");
    await h.idle();
    expect(h.ofKind(spec, "session.ended")[0]).toEqual({ kind: "session.ended", outcome: "with-changes", repos: [{ repoId: spec.repos[0]?.repoId, ahead: true }] });
    // The agent is stopped, the box kept: its worktree stays until a release.
    expect(await h.executor.state({ taskId: spec.taskId, boxId })).toEqual({ ok: true, value: "stopped" });
    expect(await exists(path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1", "idle.txt"))).toBe(true);
    expect(h.host.kept().map((kept) => kept.box.boxId)).toEqual([boxId]);
  }, 120_000);

  it("starts the timer again after a steer's turn", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("say"), { limits: { turnMaxMinutes: 30, idleMinutes: 15 } });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    await waitingForTurn(h);
    timers.advance(10 * MINUTE);
    h.steer(spec, fakeMarker("say"));
    await h.waitForKind(spec, "session.saved", 2);
    await waitingForTurn(h);
    // Ten more minutes: twenty since the first turn, ten since the second.
    timers.advance(10 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.kinds(spec)).not.toContain("session.ended");
    timers.advance(5 * MINUTE);
    await h.waitForKind(spec, "session.ended");
    expect(h.ofKind(spec, "session.ended")[0]).toMatchObject({ outcome: "without-changes" });
  }, 120_000);

  it("cancels a turn that waits on a person, saves its work, then ends the session", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("elicit"), { limits: { turnMaxMinutes: 600, idleMinutes: 15 } });
    h.dispatch(spec);
    await h.waitForKind(spec, "question.asked");
    await waitingForTurn(h);
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    await writeFile(path.join(checkout, "half-done.txt"), "waiting on a person\n");
    timers.advance(15 * MINUTE);
    await h.waitForKind(spec, "session.ended");
    const order = h.kinds(spec);
    expect(order.indexOf("question.closed")).toBeGreaterThan(order.indexOf("question.asked"));
    expect(order.indexOf("turn.ended")).toBeLessThan(order.indexOf("session.saved"));
    expect(order.indexOf("session.saved")).toBeLessThan(order.indexOf("session.ended"));
    // The hidden ref holds the half-done work.
    expect(await shared.upstream.treeFiles("ostra-test/test1", `refs/ostra/wip/${spec.taskId}`)).toContain("half-done.txt");
  }, 120_000);
});

describe("release (F-079)", () => {
  it("F-110: removes the box, its workspace, the agent's folder and its temp files, and a second release still acks done", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("say"), { limits: { turnMaxMinutes: 30, idleMinutes: 15 } });
    const boxId = h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    await waitingForTurn(h);
    timers.advance(15 * MINUTE);
    await h.waitForKind(spec, "session.ended");
    await h.idle();
    // What OpenCode leaves in the system temp folder on `host` (Q134), by the task's ID.
    const [leftover] = agentLeftoverPaths(tempDir, [spec.taskId]);
    if (leftover === undefined) throw new Error("no leftover path");
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, "tool-output.txt"), "a large tool output\n");

    const first = h.command("release", { taskId: spec.taskId, boxId, reason: "requested" });
    expect(await h.waitForAck(first)).toMatchObject({ result: "done" });
    expect(await exists(path.join(h.dataDir, "tasks", spec.taskId))).toBe(false);
    expect(await h.executor.state({ taskId: spec.taskId, boxId })).toEqual({ ok: true, value: "released" });
    expect(await exists(leftover)).toBe(false);
    expect(await readdir(path.join(tempDir, "opencode", "tool-outputs"))).toEqual([]);
    expect(h.host.kept()).toEqual([]);

    const second = h.command("release", { taskId: spec.taskId, boxId, reason: "requested" });
    expect(await h.waitForAck(second)).toMatchObject({ result: "done" });
  }, 120_000);

  it("ends a session waiting between turns before it releases, and refuses while a turn runs", async () => {
    const h = await start();
    const busy = h.taskFor(fakeMarker("silent"));
    const busyBox = h.dispatch(busy.spec);
    await h.waitForKind(busy.spec, "turn.started");
    const refused = h.command("release", { taskId: busy.spec.taskId, boxId: busyBox, reason: "requested" });
    expect(await h.waitForAck(refused)).toMatchObject({ result: "rejected", reason: "box-busy" });

    const idle = h.taskFor(fakeMarker("say"));
    const idleBox = h.dispatch(idle.spec);
    await h.waitForKind(idle.spec, "session.saved");
    const released = h.command("release", { taskId: idle.spec.taskId, boxId: idleBox, reason: "prs-closed" });
    expect(await h.waitForAck(released)).toMatchObject({ result: "done" });
    expect(h.kinds(idle.spec)).toContain("session.ended");
    expect(await exists(path.join(h.dataDir, "tasks", idle.spec.taskId))).toBe(false);
  }, 120_000);

  it("removes a kept box's folder after the runner restarted and forgot it", async () => {
    const h = await start();
    const left = path.join(h.dataDir, "tasks", "0196f1a0-left-behind");
    await mkdir(path.join(left, "workspace", "test1"), { recursive: true });
    const id = h.command("release", { taskId: "0196f1a0-left-behind", boxId: "box-left-behind", reason: "idle-expired" });
    expect(await h.waitForAck(id)).toMatchObject({ result: "done" });
    expect(await exists(left)).toBe(false);
  }, 60_000);

  it("names only plain folder names as leftovers", () => {
    expect(agentLeftoverPaths("/tmp", ["task-1", "..", "../x", "a/b", "", null, undefined, "ses_ABC.1"]).map((item) => path.basename(item))).toEqual(["task-1", "ses_ABC.1"]);
  });
});
