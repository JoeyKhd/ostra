// 200 turns through the stub, exported once, then restored on a fresh box at
// the same path: how long the restore takes, phase by phase, and how big the
// archive is. Turn 1 states the codename, and the restored session is asked
// for it, so a fast restore that lost the history can't pass.
//
// Two forms. The gating run (B4) has auto-compaction off and a 10M-token
// context, so turn 1 stays in the context verbatim. The recorded run keeps
// OpenCode's defaults (a 128K context, auto-compaction on), as a real long
// session would; the stub answers OpenCode's compaction calls in the format
// their prompt asks for (scenarios.ts), and the run records how often it
// compacted, the archive, the restore and whether turn 1's fact survived.

import path from "node:path";
import { textPrompt } from "../lib/acp-driver.ts";
import { saveWorkInProgress } from "../lib/hidden-ref.ts";
import { taskId as toTaskId, type SessionId } from "../lib/ids.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { createBox, createLocalRemote, createTaskBranch, errorMessage, randomWord, withTimeout, type RunContext } from "../harness/fixture.ts";
import { uploadArchive, type ArchiveUpload } from "../harness/history.ts";
import { askQuestions } from "../harness/questions.ts";
import { freshBoxWithWork, importAndLoad, type Timings } from "../harness/restore.ts";
import { newFacts } from "../harness/history.ts";

export const LONG_TURNS = 200;

export type LongSessionResult = {
  readonly turns: number;
  /** OpenCode's auto-compaction on (its defaults), or off with a huge context (the gating run). */
  readonly compaction: boolean;
  /** Compaction calls the stub answered while the session was built. */
  readonly compactionCalls: number;
  readonly buildMs: number;
  readonly archive: ArchiveUpload | undefined;
  readonly timings: Timings | undefined;
  readonly totalMs: number | undefined;
  /** Download, import, spawn and session/load only: the session's own share. */
  readonly sessionMs: number | undefined;
  readonly replayed: number | undefined;
  readonly recalled: boolean;
  readonly error: string | undefined;
};

export const runLongSession = async (ctx: RunContext, turns = LONG_TURNS, compaction = false): Promise<LongSessionResult> => {
  const id = toTaskId(`${compaction ? "longc" : "long"}-${randomWord("t")}`);
  const remote = await createLocalRemote(ctx, `${id}-remote`);
  const branch = `ostra/${id}`;
  await createTaskBranch(remote, branch);
  const root = path.join(ctx.runRoot, id, "box");
  const options = { name: `${id}-A`, root, taskId: id, version: "2.3.2", upstream: { kind: "stub" }, remote, branch, noCompaction: !compaction } as const;
  const facts = newFacts();
  const box = await createBox(ctx, options);
  const started = Date.now();
  const compactionsBefore = ctx.compactions.count;
  const compactionCalls = (): number => ctx.compactions.count - compactionsBefore;
  let archive: ArchiveUpload | undefined;
  let sessionIdText: SessionId | undefined;
  try {
    const driver = await box.start();
    const { sessionId } = await driver.newSession({ cwd: box.agentWorkspace, mcpServers: [] });
    sessionIdText = sessionId;
    await withTimeout(driver.prompt(sessionId, textPrompt(`${stubMarker("codename", facts.codename)} The codename for this task is ${facts.codename}. Just reply OK.`)), 60_000, "turn 1");
    for (let n = 2; n <= turns; n += 1) {
      await withTimeout(driver.prompt(sessionId, textPrompt(`${stubMarker("tick", String(n))} Turn ${String(n)}: check the workspace and report.`)), 60_000, `turn ${String(n)}`);
    }
    await saveWorkInProgress({ workspace: box.dirs.workspace, remote: "origin", task: id, turn: turns });
    archive = await uploadArchive(ctx, box, sessionId);
  } catch (error) {
    await box.destroy();
    return { turns, compaction, compactionCalls: compactionCalls(), buildMs: Date.now() - started, archive, timings: undefined, totalMs: undefined, sessionMs: undefined, replayed: undefined, recalled: false, error: `building: ${errorMessage(error)}` };
  }
  await box.destroy();
  const buildMs = Date.now() - started;
  const calls = compactionCalls();

  try {
    const restoreStarted = Date.now();
    const fresh = await freshBoxWithWork(ctx, { ...options, name: `${id}-B` });
    try {
      const loaded = await importAndLoad(ctx, fresh.box, archive.key, archive.summary.sessionId);
      const totalMs = Date.now() - restoreStarted;
      const sessionMs = (loaded.timings["download"] ?? 0) + (loaded.timings["import"] ?? 0) + (loaded.timings["spawnAndInitialize"] ?? 0) + (loaded.timings["sessionLoad"] ?? 0);
      // Only the first question: the codename from turn 1, 199 turns back.
      const score = await askQuestions(fresh.box, loaded.driver, archive.summary.sessionId, facts, true);
      return {
        turns,
        compaction,
        compactionCalls: calls,
        buildMs,
        archive,
        timings: { ...fresh.timings, ...loaded.timings },
        totalMs,
        sessionMs,
        replayed: loaded.replayed,
        recalled: score.answers.find((a) => a.id === "q1")?.correct === true,
        error: sessionIdText === archive.summary.sessionId ? undefined : "the archive holds another session",
      };
    } finally {
      await fresh.box.destroy();
    }
  } catch (error) {
    return { turns, compaction, compactionCalls: calls, buildMs, archive, timings: undefined, totalMs: undefined, sessionMs: undefined, replayed: undefined, recalled: false, error: `restoring: ${errorMessage(error)}` };
  }
};
