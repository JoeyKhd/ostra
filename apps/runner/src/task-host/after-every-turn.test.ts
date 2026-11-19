import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { sha256Of } from "../server/bulk.ts";
import { unpackArchive } from "./session-archive.ts";

// Ticket 22's "done when", on `host` with the fake agent and the git upstream stub: after each
// turn the branch, the hidden ref and the archive are there; a dropped upload resumes; a failed
// export still sends `session.saved`; staged, unstaged, deleted and untracked files are all in the
// hidden ref, and an ignored one isn't. A minor-0 spec keeps milestone 1's one turn.

const run = promisify(execFile);

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("after-every-turn");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared);
  return harness;
};

describe("after every turn (F-096)", () => {
  it("saves the branch, the hidden ref and the archive after each of three turns, and the session stays open", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("write", "one.txt"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1);
    h.steer(spec, fakeMarker("write", "two.txt"));
    await h.waitForKind(spec, "session.saved", 2);
    h.steer(spec, fakeMarker("remember", "kiwi"));
    await h.waitForKind(spec, "session.saved", 3);

    const saves = h.ofKind(spec, "session.saved");
    expect(saves.map((save) => save.turnOrdinal)).toEqual([1, 2, 3]);
    const branch = `refs/heads/${spec.branchName}`;
    const hiddenRef = `refs/ostra/wip/${spec.taskId}`;
    for (const save of saves) {
      const [repo] = save.repos;
      expect(repo).toMatchObject({ repoId: spec.repos[0]?.repoId, ahead: true });
      expect(repo?.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(repo?.hiddenRefSha).toMatch(/^[0-9a-f]{40}$/);
      // Each archive is in the blob store, with the digest the event names.
      const archive = save.archive;
      if (archive === null) throw new Error("no archive");
      const stored = h.server.blobs.get(archive.blobId);
      expect(stored?.sha256).toBe(archive.sha256);
      expect(stored?.bytes.length).toBe(archive.size);
      expect(stored?.contentType).toBe("application/gzip");
      expect(stored?.purpose).toBe("session-archive");
    }
    // The last save is what's upstream now.
    const last = saves.at(-1)?.repos[0];
    expect(await shared.upstream.refSha("ostra-test/test1", branch)).toBe(last?.headSha);
    expect(await shared.upstream.refSha("ostra-test/test1", hiddenRef)).toBe(last?.hiddenRefSha);
    expect(await shared.upstream.treeFiles("ostra-test/test1", branch)).toEqual(expect.arrayContaining(["one.txt", "two.txt"]));
    // The third archive holds the session the agent can load again: its history says "kiwi".
    const third = saves[2]?.archive;
    const bytes = third === null || third === undefined ? undefined : h.server.blobs.get(third.blobId)?.bytes;
    if (bytes === undefined) throw new Error("no third archive");
    const unpacked = await unpackArchive(bytes);
    if (!unpacked.ok) throw new Error(unpacked.reason);
    expect(unpacked.header.agent).toBe("fake-acp-agent-rich");
    expect(unpacked.exported.toString("utf8")).toContain("kiwi");
    // The session is still open: no session.ended, the run is still there, the box is ready.
    expect(h.kinds(spec)).not.toContain("session.ended");
    expect(h.host.running()).toHaveLength(1);
    // Each turn's figures, on one log line each, numbers only.
    const figures = h.logs.filter((record) => record.message === "work saved after the turn");
    expect(figures).toHaveLength(3);
    for (const record of figures) {
      for (const field of ["turnOrdinal", "afterTurnMs", "archiveBytes"]) {
        expect(typeof record.fields[field]).toBe("number");
      }
    }
    expect(h.everyEventOnce()).toBe(true);
  }, 180_000);

  it("resumes an upload that dropped mid-chunk, and seals one blob", async () => {
    const h = await start();
    h.server.bulkFaults.dropChunks = 1;
    const { spec } = h.taskFor(fakeMarker("remember", "fig"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    const [save] = h.ofKind(spec, "session.saved");
    const archive = save?.archive ?? null;
    if (archive === null) throw new Error("the archive wasn't saved");
    expect(h.server.bulkFaults.dropChunks).toBe(0);
    // Two starts: the first, and the resume that asked how much was held.
    expect(h.server.bulkCalls.filter((call) => call === "start")).toHaveLength(2);
    expect(h.server.bulkCalls.filter((call) => call === "finish")).toHaveLength(1);
    expect(sha256Of(h.server.blobs.get(archive.blobId)?.bytes ?? Buffer.alloc(0))).toBe(archive.sha256);
  }, 120_000);

  it("a failed export, or a failed upload, still sends session.saved with no archive, and the turn's work is pushed", async () => {
    const h = await start();
    const failing = h.taskFor(fakeMarker("write", "kept.txt"), {
      agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-noexport", apiFormat: "anthropic-messages" },
    });
    h.dispatch(failing.spec);
    await h.waitForKind(failing.spec, "session.saved");
    const [saved] = h.ofKind(failing.spec, "session.saved");
    expect(saved?.archive).toBeNull();
    expect(saved?.repos[0]).toMatchObject({ ahead: true });
    expect(saved?.repos[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(h.logs.some((record) => record.message === "the session archive wasn't saved" && String(record.fields["reason"]).includes("export failed"))).toBe(true);
    expect(await shared.upstream.treeFiles("ostra-test/test1", `refs/heads/${failing.spec.branchName}`)).toContain("kept.txt");

    h.server.bulkFaults.refuseUploads = true;
    const refused = h.taskFor(fakeMarker("say"));
    h.dispatch(refused.spec);
    await h.waitForKind(refused.spec, "session.saved", 1, 120_000);
    expect(h.ofKind(refused.spec, "session.saved")[0]?.archive).toBeNull();
    expect(h.kinds(refused.spec)).not.toContain("session.crashed");
  }, 240_000);

  it("puts staged, unstaged, deleted and untracked work in the hidden ref, and leaves an ignored file out", async () => {
    const h = await start();
    // A silent turn: the test plays the agent's edits, then a stop cancels it.
    const { spec } = h.taskFor(fakeMarker("silent"));
    h.dispatch(spec);
    await h.waitForKind(spec, "turn.started");
    const checkout = path.join(h.dataDir, "tasks", spec.taskId, "workspace", "test1");
    const git = (args: readonly string[]): Promise<{ readonly stdout: string }> => run("git", [...args], { cwd: checkout });
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(path.join(checkout, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(checkout, "ignored.log"), "not saved\n");
    await writeFile(path.join(checkout, "untracked.txt"), "untracked\n");
    await writeFile(path.join(checkout, "staged.txt"), "staged\n");
    await git(["add", "staged.txt"]);
    await writeFile(path.join(checkout, "README.md"), "# changed, not staged\n");
    await rm(path.join(checkout, "notes.txt"));
    const stopId = h.stop(spec);
    expect(await h.waitForAck(stopId, 120_000)).toMatchObject({ result: "done" });
    const hiddenRef = `refs/ostra/wip/${spec.taskId}`;
    const files = await shared.upstream.treeFiles("ostra-test/test1", hiddenRef);
    expect(files).toEqual(expect.arrayContaining([".gitignore", "untracked.txt", "staged.txt", "README.md"]));
    expect(files).not.toContain("ignored.log");
    expect(files).not.toContain("notes.txt");
    const saved = h.ofKind(spec, "session.saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.repos[0]?.hiddenRefSha).toBe(await shared.upstream.refSha("ostra-test/test1", hiddenRef));
    // A stop ends the session without session.ended, and the box stays for a reopen.
    await h.idle();
    expect(h.kinds(spec)).not.toContain("session.ended");
    expect(await readFile(path.join(checkout, "untracked.txt"), "utf8")).toBe("untracked\n");
  }, 180_000);

  it("keeps milestone 1's one turn and session.ended for a minor-0 spec", async () => {
    const h = await start();
    const { spec } = h.taskFor(fakeMarker("write", "m1.txt"), { limits: { turnMaxMinutes: 30 } });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.ended");
    await h.idle();
    expect(h.kinds(spec)).not.toContain("session.saved");
    expect(h.ofKind(spec, "session.ended")[0]).toMatchObject({ outcome: "with-changes" });
    expect(h.server.bulkCalls).toEqual([]);
  }, 120_000);
});
