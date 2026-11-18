// The move itself. Box A runs the six turns (history.ts) and is destroyed:
// its agent stopped, its workspace and its OpenCode data deleted. Then:
//
//   control   a fresh box, no import: session/load must fail, which shows the
//             archive (not something left on disk) carries the session
//   B         a fresh box at A's path (what a fresh container gives): hidden
//             ref, download, import, session/load, the five questions, and
//             the interrupted edit finished
//   template  a fresh box, no import: a new session from the rebuild
//             template alone, the same five questions (and the edit, recorded);
//             then, recorded, two other forms of it, each on its own fresh box
//   elsewhere a fresh box at another path, imported with --directory: does
//             session/load work there (recorded)
//
// Box A and box B may run different OpenCode versions: the patch-version check.
// Every box is a directory tree or, with Docker, a fresh container (fixture.ts).

import path from "node:path";
import { stat } from "node:fs/promises";
import { textPrompt } from "../lib/acp-driver.ts";
import { gitOut } from "../lib/git.ts";
import { taskId as toTaskId, type TaskId } from "../lib/ids.ts";
import type { OpenCodeVersion } from "../lib/opencode.ts";
import { buildRebuildPrompt, type RebuildInput } from "../lib/rebuild-template.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { createBox, createLocalRemote, createTaskBranch, errorMessage, randomWord, withTimeout, type Box, type BoxOptions, type Executor, type Remote, type RunContext, type Upstream } from "../harness/fixture.ts";
import type { ScopeTally } from "../lib/deciders.ts";
import { buildHistory, interruptedTurn, lastFinishedReply, lastTextOfAnyTurn, type History } from "../harness/history.ts";
import { askQuestions, finishEdit, type Finish, type Score } from "../harness/questions.ts";
import { freshBoxWithWork, importAndLoad, sumTimings, type Timings } from "../harness/restore.ts";

export type MoveOptions = {
  readonly label: string;
  readonly from: OpenCodeVersion;
  readonly to: OpenCodeVersion;
  readonly upstream: Upstream;
  readonly control: boolean;
  readonly template: boolean;
  readonly elsewhere: boolean;
  /** The interrupted turn says a sentence before its first step (the stub's script does; a real model is asked to). */
  readonly chatty?: boolean;
  /** Default `directory`. */
  readonly executor?: Executor;
};

export type HiddenRefFindings = {
  /** `git status` in box A after the interrupted turn, and in box B after the restore. */
  readonly statusBefore: readonly string[];
  readonly statusAfter: readonly string[];
  readonly untrackedBack: boolean;
  readonly ignoredBack: boolean;
  readonly branchUnmoved: boolean;
  readonly notOnBranch: boolean;
  readonly notInPlainClone: boolean;
};

export type MoveResult = {
  readonly label: string;
  readonly executor: Executor;
  readonly from: OpenCodeVersion;
  readonly to: OpenCodeVersion;
  readonly stub: boolean;
  readonly history: History | undefined;
  readonly error: string | undefined;
  readonly control: { readonly loadFailed: boolean; readonly note: string } | undefined;
  readonly restored:
    | {
        readonly importOk: boolean;
        readonly sameId: boolean;
        readonly replayed: number;
        readonly replayHasTurn1: boolean;
        readonly timings: Timings;
        readonly totalMs: number;
        readonly score: Score;
        readonly finish: Finish;
        readonly hiddenRef: HiddenRefFindings;
      }
    | undefined;
  readonly restoreError: string | undefined;
  readonly template: { readonly score: Score; readonly finish: Finish; readonly promptChars: number } | undefined;
  readonly templateError: string | undefined;
  /** Recorded only: ADR 0039's wording read literally, the last turn with any text as the last message (the spike's first form). */
  readonly templateLiteral: Score | undefined;
  /** The template with every agent message, not only the last. */
  readonly templateEveryAgentMessage: Score | undefined;
  readonly elsewhere: { readonly loaded: boolean; readonly recalled: boolean; readonly note: string } | undefined;
  /** What the workspace-bound decider approved and rejected, on box A and box B. */
  readonly toolScope: { readonly boxA: ScopeTally | undefined; readonly boxB: ScopeTally | undefined };
};

const exists = async (file: string): Promise<boolean> => (await stat(file).catch(() => undefined)) !== undefined;

const boxOptions = (ctx: RunContext, name: string, root: string, id: TaskId, version: OpenCodeVersion, options: MoveOptions, remote: Remote, branch: string): BoxOptions => ({
  name,
  root,
  taskId: id,
  version,
  upstream: options.upstream,
  remote,
  branch,
  ...(options.executor === undefined ? {} : { executor: options.executor }),
});

const hiddenRefFindings = async (box: Box, history: History, statusAfter: readonly string[]): Promise<HiddenRefFindings> => {
  const cwd = box.dirs.workspace;
  const before = [...history.wip.status].sort();
  const after = [...statusAfter].sort();
  const branchNow = (await gitOut(["ls-remote", "origin", `refs/heads/${box.branch}`], { cwd })).split(/\s+/)[0] ?? "";
  // No fallback: a git failure must surface (as the restore's error), not read as "on no branch".
  const onBranch = await gitOut(["branch", "-r", "--contains", history.wip.commit], { cwd });
  return {
    statusBefore: before,
    statusAfter: after,
    untrackedBack: before.some((s) => s.startsWith("??")) && JSON.stringify(before.filter((s) => s.startsWith("??"))) === JSON.stringify(after.filter((s) => s.startsWith("??"))),
    ignoredBack: await exists(path.join(cwd, "debug.log")),
    branchUnmoved: branchNow === history.branchHead && branchNow !== history.wip.commit,
    notOnBranch: onBranch.trim() === "",
    notInPlainClone: true,
  };
};

/**
 * Which form of the template a run builds:
 *   fixed      ADR 0039's parts; the last message is the last finished turn's
 *              reply, and an interrupted turn's fragment has its own section
 *   literal    ADR 0039's parts, the last message being the last turn with
 *              any text (the spike's first form, before finding 7's fix)
 *   every      every agent message, oldest first (the proposed variant)
 */
export type TemplateForm = "fixed" | "literal" | "every";

type TemplateInput = { readonly id: TaskId; readonly remote: Remote; readonly branch: string; readonly history: History; readonly form: TemplateForm };

const templateParts = (history: History, form: TemplateForm): Pick<RebuildInput, "lastAgentMessage" | "interruptedTurn" | "earlierAgentMessages"> => {
  switch (form) {
    case "fixed":
      return { lastAgentMessage: lastFinishedReply(history), interruptedTurn: interruptedTurn(history) };
    case "literal":
      return { lastAgentMessage: lastTextOfAnyTurn(history), interruptedTurn: undefined };
    case "every":
      // Unchanged from the runs before the fix, so its scores compare.
      return { lastAgentMessage: lastTextOfAnyTurn(history), interruptedTurn: undefined, earlierAgentMessages: history.agentTexts.slice(0, -1) };
    default:
      return form satisfies never;
  }
};

const runTemplate = async (ctx: RunContext, options: MoveOptions, input: TemplateInput): Promise<{ score: Score; finish: Finish; promptChars: number }> => {
  const { id, remote, branch, history } = input;
  const stub = options.upstream.kind === "stub";
  const name = `template-${input.form}`;
  const fresh = await freshBoxWithWork(ctx, boxOptions(ctx, `${id}-${name}`, path.join(ctx.runRoot, id, name), id, options.to, options, remote, branch));
  try {
    const branchLog = await gitOut(["log", "--stat", "--format=%h %s", `origin/${remote.defaultBranch}..HEAD`], { cwd: fresh.box.dirs.workspace });
    const template = buildRebuildPrompt({
      ticket: { key: "TEST-2", title: "Small changes across the repo", body: "Make the small changes the team asks for in the task thread." },
      pullRequest: { title: "Small changes across the repo", body: "Work in progress: changes asked for in the task thread." },
      memberMessages: history.memberMessages,
      ...templateParts(history, input.form),
      branchLog,
      restoredWork: fresh.work !== undefined && fresh.work.status.length > 0,
    });
    const driver = await fresh.box.start();
    const { sessionId } = await driver.newSession({ cwd: fresh.box.agentWorkspace, mcpServers: [] });
    const first = `${stub ? `${stubMarker("template-ack")} ` : ""}${template}\n\nReply OK once you have read this. Don't change anything yet.`;
    await withTimeout(driver.prompt(sessionId, textPrompt(first)), stub ? 60_000 : 300_000, "template prompt");
    const score = await askQuestions(fresh.box, driver, sessionId, history.facts, stub);
    const finish = await finishEdit(driver, sessionId, fresh.box.dirs.workspace, history.facts, stub);
    return { score, finish, promptChars: template.length };
  } finally {
    await fresh.box.destroy();
  }
};

export const runMove = async (ctx: RunContext, options: MoveOptions): Promise<MoveResult> => {
  const stub = options.upstream.kind === "stub";
  const id = toTaskId(`${options.label}-${randomWord("t")}`);
  const remote = await createLocalRemote(ctx, `${id}-remote`);
  const branch = `ostra/${id}`;
  await createTaskBranch(remote, branch);
  const rootA = path.join(ctx.runRoot, id, "box");
  const result: { -readonly [K in keyof MoveResult]: MoveResult[K] } = {
    label: options.label,
    executor: options.executor ?? "directory",
    from: options.from,
    to: options.to,
    stub,
    history: undefined,
    error: undefined,
    control: undefined,
    restored: undefined,
    restoreError: undefined,
    template: undefined,
    templateError: undefined,
    templateLiteral: undefined,
    templateEveryAgentMessage: undefined,
    elsewhere: undefined,
    toolScope: { boxA: undefined, boxB: undefined },
  };

  // Box A: the session, then gone.
  const boxA = await createBox(ctx, boxOptions(ctx, `${id}-A`, rootA, id, options.from, options, remote, branch));
  try {
    result.history = await buildHistory(ctx, boxA, stub, options.chatty === true);
  } catch (error) {
    result.error = `box A: ${errorMessage(error)}`;
  } finally {
    result.toolScope = { ...result.toolScope, boxA: boxA.tally };
    await boxA.destroy();
  }
  const history = result.history;
  if (history === undefined) return result;
  const goneA = !(await exists(rootA));

  // The control: a fresh box with no archive can't load the session.
  if (options.control) {
    const fresh = await freshBoxWithWork(ctx, boxOptions(ctx, `${id}-control`, path.join(ctx.runRoot, id, "control"), id, options.to, options, remote, branch));
    try {
      const driver = await fresh.box.start();
      try {
        await withTimeout(driver.loadSession({ sessionId: history.sessionId, cwd: fresh.box.agentWorkspace, mcpServers: [] }), 60_000, "session/load");
        result.control = { loadFailed: false, note: "session/load succeeded without an archive" };
      } catch (error) {
        result.control = { loadFailed: true, note: `session/load failed: ${errorMessage(error).slice(0, 120)}` };
      }
    } finally {
      await fresh.box.destroy();
    }
  }

  // Box B: a fresh box at A's path, restored from the hidden ref and the archive.
  try {
    if (!goneA) throw new Error("box A's directory is still there");
    const started = Date.now();
    const fresh = await freshBoxWithWork(ctx, boxOptions(ctx, `${id}-B`, rootA, id, options.to, options, remote, branch));
    try {
      if (fresh.work === undefined) throw new Error("the remote has no hidden ref");
      const statusAfter = fresh.work.status;
      const loaded = await importAndLoad(ctx, fresh.box, history.archive.key, history.sessionId);
      const totalMs = Date.now() - started;
      const score = await askQuestions(fresh.box, loaded.driver, history.sessionId, history.facts, stub);
      const finish = await finishEdit(loaded.driver, history.sessionId, fresh.box.dirs.workspace, history.facts, stub);
      const findings = await hiddenRefFindings(fresh.box, history, statusAfter);
      result.restored = {
        importOk: true,
        sameId: loaded.importedId === history.sessionId,
        replayed: loaded.replayed,
        replayHasTurn1: loaded.replayedText.includes(history.facts.codename),
        timings: { ...fresh.timings, ...loaded.timings },
        totalMs,
        score,
        finish,
        hiddenRef: { ...findings, notInPlainClone: fresh.plainCloneOstraRefs === 0 },
      };
    } finally {
      result.toolScope = { ...result.toolScope, boxB: fresh.box.tally };
      await fresh.box.destroy();
    }
  } catch (error) {
    result.restoreError = errorMessage(error);
  }

  // The rebuild template alone, in a new session on a fresh box; then its
  // other two forms, each in a new session on a fresh box of its own.
  if (options.template) {
    try {
      result.template = await runTemplate(ctx, options, { id, remote, branch, history, form: "fixed" });
    } catch (error) {
      result.templateError = errorMessage(error);
    }
    for (const form of ["literal", "every"] as const) {
      try {
        const variant = await runTemplate(ctx, options, { id, remote, branch, history, form });
        if (form === "literal") result.templateLiteral = variant.score;
        else result.templateEveryAgentMessage = variant.score;
      } catch (error) {
        result.templateError = `${result.templateError ?? ""} (${form}: ${errorMessage(error)})`;
      }
    }
  }

  // Another path: import with --directory, then session/load there.
  if (options.elsewhere) {
    try {
      const fresh = await freshBoxWithWork(ctx, boxOptions(ctx, `${id}-elsewhere`, path.join(ctx.runRoot, id, "elsewhere"), id, options.to, options, remote, branch));
      try {
        const loaded = await importAndLoad(ctx, fresh.box, history.archive.key, history.sessionId, fresh.box.dirs.workspace);
        const score = await askQuestions(fresh.box, loaded.driver, history.sessionId, history.facts, stub);
        const q1 = score.answers.find((a) => a.id === "q1");
        result.elsewhere = { loaded: true, recalled: q1?.correct === true, note: `${String(loaded.replayed)} updates replayed; ${String(score.correct)}/5 answered` };
      } finally {
        await fresh.box.destroy();
      }
    } catch (error) {
      result.elsewhere = { loaded: false, recalled: false, note: errorMessage(error).slice(0, 160) };
    }
  }
  return result;
};

export const totalRestoreMs = (result: MoveResult): number | undefined => (result.restored === undefined ? undefined : sumTimings(result.restored.timings));
