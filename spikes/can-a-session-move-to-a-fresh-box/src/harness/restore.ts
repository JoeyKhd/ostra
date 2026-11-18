// Reopening on a fresh box (ADR 0039, step 2, the normal path): the box
// clones the task's branch, restores the hidden ref, downloads the archive
// through the "server", imports it, starts OpenCode and calls session/load.
// Each phase is timed.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { AcpDriver } from "../lib/acp-driver.ts";
import { downloadBlob } from "../lib/blob-store.ts";
import { gitOut } from "../lib/git.ts";
import { restoreWorkInProgress, type RestoredWork } from "../lib/hidden-ref.ts";
import type { BlobKey, SessionId } from "../lib/ids.ts";
import { importSession } from "../lib/session-archive.ts";
import { createBox, withTimeout, type Box, type BoxOptions, type RunContext } from "./fixture.ts";

const gunzipAsync = promisify(gunzip);

export type Timings = Record<string, number>;

export type FreshBox = {
  readonly box: Box;
  readonly work: RestoredWork | undefined;
  /** `refs/ostra/*` in the plain clone, before the hidden ref was fetched: should be none. */
  readonly plainCloneOstraRefs: number;
  readonly timings: Timings;
};

/** A fresh box with the task's branch and its hidden ref. */
export const freshBoxWithWork = async (ctx: RunContext, options: BoxOptions): Promise<FreshBox> => {
  const timings: Timings = {};
  const box = await createBox(ctx, options);
  // The clone, and for a container box the container's start.
  Object.assign(timings, box.setup);
  try {
    const plain = await gitOut(["for-each-ref", "--format=%(refname)", "refs/ostra"], { cwd: box.dirs.workspace });
    const t = Date.now();
    const work = await restoreWorkInProgress({ workspace: box.dirs.workspace, remote: "origin", task: box.taskId });
    timings["hiddenRef"] = Date.now() - t;
    return { box, work, plainCloneOstraRefs: plain === "" ? 0 : plain.split(/\r?\n/).length, timings };
  } catch (error) {
    await box.destroy();
    throw error;
  }
};

export type Loaded = {
  readonly driver: AcpDriver;
  readonly importedId: SessionId;
  /** session_update notifications replayed by session/load. */
  readonly replayed: number;
  readonly replayedText: string;
  readonly timings: Timings;
};

/** Download, import, start, session/load. `directory` (a host path in the box) imports into another path than the box's workspace. */
export const importAndLoad = async (ctx: RunContext, box: Box, key: BlobKey, sessionId: SessionId, directory?: string): Promise<Loaded> => {
  const timings: Timings = {};
  let t = Date.now();
  const archive = await gunzipAsync(await downloadBlob(ctx.blobs, key));
  const file = path.join(box.dirs.tmp, "session-archive.json");
  await writeFile(file, archive);
  timings["download"] = Date.now() - t;
  t = Date.now();
  const agentDirectory = directory === undefined ? undefined : box.agentPath(directory);
  const imported = await importSession(box.cli, box.agentPath(file), agentDirectory);
  timings["import"] = Date.now() - t;
  t = Date.now();
  const driver = await box.start();
  timings["spawnAndInitialize"] = Date.now() - t;
  t = Date.now();
  const before = driver.events.at(-1)?.seq ?? 0;
  await withTimeout(driver.loadSession({ sessionId, cwd: agentDirectory ?? box.agentWorkspace, mcpServers: [] }), 120_000, "session/load");
  timings["sessionLoad"] = Date.now() - t;
  const replayed = driver.events.filter((e) => e.seq > before && e.kind === "session_update" && e.sessionId === sessionId);
  return { driver, importedId: imported.sessionId, replayed: replayed.length, replayedText: JSON.stringify(replayed), timings };
};

export const sumTimings = (...all: readonly Timings[]): number => all.reduce((total, t) => total + Object.values(t).reduce((a, b) => a + b, 0), 0);
