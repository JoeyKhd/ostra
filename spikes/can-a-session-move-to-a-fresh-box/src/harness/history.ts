// The session that moves: six turns on box A, each leaving a different kind
// of trace, then the after-turn work of ADR 0039.
//
//   1. a fact the member states        (the codename)
//   2. a file the agent creates        (docs/<slug>.md)
//   3. a tool output only the shell saw (RESULT-<n>, from the clock)
//   4. an edit the member asks for     (README.md: hello → <word>)
//   5. a decision the agent states     (the dev server's port)
//   6. several steps, interrupted during a slow check: a staged new file, an
//      unstaged edit, a staged delete, an untracked file and an ignored one
//      are on disk; the last edit never happened.
//
// After every turn: a finished turn's changes are committed and the branch is
// pushed; the working tree goes to the hidden ref; the session is exported,
// gzipped and uploaded through the "server" to the blob store.
//
// Random facts per run, so nothing can be guessed or remembered from a run
// before. Answers and agent text go to the run folder, never to the console.

import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { agentText, textPrompt, type AcpDriver } from "../lib/acp-driver.ts";
import { uploadBlob } from "../lib/blob-store.ts";
import { git, gitOut, statusEntries } from "../lib/git.ts";
import { saveWorkInProgress, type SavedWork } from "../lib/hidden-ref.ts";
import { blobKey, type BlobKey, type SessionId } from "../lib/ids.ts";
import { exportSession, type ArchiveSummary } from "../lib/session-archive.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { randomWord, sleep, withTimeout, type Box, type RunContext } from "./fixture.ts";
import { finishedOnDisk, LEFT_LINE } from "./questions.ts";
import { RESULT_COMMAND, RESULT_PATTERN, slowCheckCommand } from "./scenarios.ts";

const gzipAsync = promisify(gzip);

export type Facts = {
  readonly codename: string;
  readonly docSlug: string;
  readonly readmeWord: string;
  readonly module: string;
  readonly constName: string;
  /** Learned from the turn: what the command printed. */
  printed: string | undefined;
  /** Learned from the turn: the port the agent chose. */
  port: string | undefined;
};

export const newFacts = (): Facts => ({
  codename: randomWord("osprey"),
  docSlug: randomWord("guide-"),
  readmeWord: randomWord("howdy"),
  module: randomWord("widget"),
  constName: `count${randomWord("x")}`,
  printed: undefined,
  port: undefined,
});

export type ArchiveUpload = {
  readonly key: BlobKey;
  readonly summary: ArchiveSummary;
  readonly gzBytes: number;
  readonly exportMs: number;
  readonly uploadMs: number;
};

export type TurnLog = {
  readonly n: number;
  readonly stopReason: string;
  readonly ms: number;
  readonly afterTurnMs: number;
  readonly committed: boolean;
  readonly archiveBytes: number;
};

export type History = {
  readonly sessionId: SessionId;
  readonly facts: Facts;
  readonly memberMessages: readonly { readonly author: string; readonly text: string }[];
  /** Agent text per turn, from the driver's events (ostra's event log). */
  readonly agentTexts: readonly string[];
  readonly turns: readonly TurnLog[];
  /** The hidden ref after the interrupted turn. */
  readonly wip: SavedWork;
  readonly archive: ArchiveUpload;
  /** The branch's head on the remote after the last finished turn. */
  readonly branchHead: string;
  /** Whether the slow check was running when the cancel went out. */
  readonly interruptedInSlowCheck: boolean;
  /** After the cancel, on disk: the last edit (step 7) had not happened, so "finish the edit" has something left to do. */
  readonly leftLineAbsent: boolean;
};

export const archiveKey = (box: Box): BlobKey => blobKey(`${box.taskId}/session-archive.json.gz`);

export const uploadArchive = async (ctx: RunContext, box: Box, sessionId: SessionId): Promise<ArchiveUpload> => {
  const exported = await exportSession(box.cli, sessionId);
  const zipped = await gzipAsync(Buffer.from(exported.text, "utf8"));
  const started = Date.now();
  const key = archiveKey(box);
  await uploadBlob(ctx.blobs, key, zipped);
  return { key, summary: exported.summary, gzBytes: zipped.byteLength, exportMs: exported.ms, uploadMs: Date.now() - started };
};

/** Commits what a finished turn left and pushes the branch (step 1). */
export const commitAndPush = async (box: Box, n: number): Promise<boolean> => {
  const cwd = box.dirs.workspace;
  if ((await statusEntries(cwd)).length === 0) return false;
  await git(["add", "-A"], { cwd });
  await git(["commit", "-q", "-m", `ostra: changes from turn ${String(n)}`], { cwd });
  await git(["push", "-q", "origin", `HEAD:refs/heads/${box.branch}`], { cwd });
  return true;
};

const PROMPTS = (facts: Facts, marker: string, chatty: boolean): readonly { readonly stub: string; readonly text: string }[] => [
  { stub: stubMarker("codename", facts.codename), text: `The codename for this task is ${facts.codename}. Just reply OK.` },
  { stub: stubMarker("create-doc", facts.docSlug), text: `Create the file docs/${facts.docSlug}.md with a one-line summary of this repo. Then say which file you created.` },
  { stub: stubMarker("print-result"), text: `Run this exact shell command and tell me what it printed: ${RESULT_COMMAND}` },
  { stub: stubMarker("replace-readme", facts.readmeWord), text: `In README.md, replace the word hello with ${facts.readmeWord}.` },
  {
    stub: stubMarker("pick-port"),
    text: "We need a port for the dev server. Pick one between 4000 and 4999 and tell me in one sentence, in the form 'I will use port N because ...'. Don't change any files.",
  },
  {
    stub: stubMarker("multi-step", `${facts.module} ${facts.constName} ${marker} ${chatty ? "chatty" : "quiet"}`),
    text: [
      "Do these steps in order, one tool call each:",
      `1) Create src/${facts.module}.ts containing exactly one line: export const ${facts.constName} = 1;`,
      `2) Run: git add src/${facts.module}.ts`,
      "3) In notes.txt, replace the word notes with draft.",
      "4) Run: git rm -q old.txt",
      `5) Write your plan for the rest of the work to scratch/${facts.module}-plan.md, and write the word debug to debug.log.`,
      `6) Run the slow check, with a timeout of 600000 ms: ${slowCheckCommand(marker)}`,
      `7) After the check, add a second line to src/${facts.module}.ts: export const ${facts.constName}Done = true;`,
    ].join("\n"),
  },
];

export const promptFor = (stub: boolean, prompt: { readonly stub: string; readonly text: string }): string => (stub ? `${prompt.stub} ${prompt.text}` : prompt.text);

const isSlowCheckRunning = (driver: AcpDriver, sinceSeq: number, marker: string): boolean =>
  driver.events.some(
    (event) =>
      event.seq > sinceSeq &&
      event.kind === "session_update" &&
      (event.update.sessionUpdate === "tool_call" || event.update.sessionUpdate === "tool_call_update") &&
      JSON.stringify(event.update).includes(marker),
  );

/**
 * Runs the six turns on box A and the after-turn work after each. `chatty`
 * (stub only) makes the stub say a sentence before the interrupted turn's
 * first step.
 */
export const buildHistory = async (ctx: RunContext, box: Box, stub: boolean, chatty = false): Promise<History> => {
  const driver = await box.start();
  const { sessionId } = await driver.newSession({ cwd: box.agentWorkspace, mcpServers: [] });
  const facts = newFacts();
  const prompts = PROMPTS(facts, ctx.marker, chatty);
  const turnTimeout = stub ? 120_000 : 600_000;
  const memberMessages: { author: string; text: string }[] = [];
  const agentTexts: string[] = [];
  const turns: TurnLog[] = [];
  let wip: SavedWork | undefined;
  let archive: ArchiveUpload | undefined;
  let interruptedInSlowCheck = false;
  let leftLineAbsent = false;

  for (const [index, prompt] of prompts.entries()) {
    const n = index + 1;
    const text = promptFor(stub, prompt);
    memberMessages.push({ author: "member", text });
    const sinceSeq = driver.events.at(-1)?.seq ?? 0;
    const started = Date.now();
    const interrupted = n === prompts.length;
    const running = driver.prompt(sessionId, textPrompt(text));
    let stopReason: string;
    if (interrupted) {
      // Cancel once the slow check runs (a real model gets five minutes to get there).
      const deadline = Date.now() + (stub ? 60_000 : 300_000);
      const turn = { over: false };
      const markOver = (): void => {
        turn.over = true;
      };
      void running.then(markOver, markOver);
      while (!isSlowCheckRunning(driver, sinceSeq, ctx.marker) && Date.now() < deadline && !turn.over) await sleep(200);
      interruptedInSlowCheck = isSlowCheckRunning(driver, sinceSeq, ctx.marker);
      if (interruptedInSlowCheck) await sleep(1500);
      await driver.cancel(sessionId);
      stopReason = (await withTimeout(running, 60_000, `turn ${String(n)} after cancel`)).stopReason;
    } else {
      stopReason = (await withTimeout(running, turnTimeout, `turn ${String(n)}`)).stopReason;
    }
    const ms = Date.now() - started;
    const said = agentText(driver.events, sessionId, sinceSeq);
    agentTexts.push(said);
    if (n === 3) {
      // What the command printed, from the tool's output in the event log.
      const raw = driver.events.filter((e) => e.seq > sinceSeq && e.kind === "session_update").map((e) => JSON.stringify(e)).join("\n");
      facts.printed = RESULT_PATTERN.exec(raw)?.[1];
    }
    if (n === 5) facts.port = /\bport (4\d{3})\b/i.exec(said)?.[1] ?? /\b(4\d{3})\b/.exec(said)?.[1];
    // The interrupted turn's last edit must not have happened, or finishing it proves nothing.
    if (interrupted) leftLineAbsent = (await finishedOnDisk(box.dirs.workspace, facts))[LEFT_LINE(facts)] === false;

    const afterStarted = Date.now();
    const committed = !interrupted && stopReason === "end_turn" ? await commitAndPush(box, n) : false;
    wip = await saveWorkInProgress({ workspace: box.dirs.workspace, remote: "origin", task: box.taskId, turn: n });
    archive = await uploadArchive(ctx, box, sessionId);
    turns.push({ n, stopReason, ms, afterTurnMs: Date.now() - afterStarted, committed, archiveBytes: archive.summary.bytes });
  }
  if (wip === undefined || archive === undefined) throw new Error("no turns ran");
  const branchHead = (await gitOut(["ls-remote", "origin", `refs/heads/${box.branch}`], { cwd: box.dirs.workspace })).split(/\s+/)[0] ?? "";
  return { sessionId, facts, memberMessages, agentTexts, turns, wip, archive, branchHead, interruptedInSlowCheck, leftLineAbsent };
};

/** The agent's last message, as ostra's event log has it: the last turn with any text. */
export const lastAgentMessage = (history: History): string | undefined => [...history.agentTexts].reverse().find((text) => text.trim() !== "");
