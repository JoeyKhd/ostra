// The pass bar of spike 2 (context/build-order.md), one criterion per bullet,
// each made of the checks the cases produced. A check that needs a real
// endpoint, account or machine that isn't here is SKIPPED with the input it
// needs; nothing stands in for it.

import type { LongSessionResult } from "../cases/long-session.ts";
import type { MoveResult } from "../cases/move.ts";
import { DOCKER_INPUT_HINT, MODEL_INPUT_HINT, type Inputs } from "./inputs.ts";
import { check, fail, pass, skip, type Check, type Criterion } from "./report.ts";
import type { Score } from "./questions.ts";

export const RESTORE_BUDGET_MS = 30_000;

export const BULLETS = {
  B1: "After export, upload, a fresh container, import and session/load, the agent answers 5 of 5 questions about earlier turns and finishes an edit it was interrupted in.",
  B2: "Uncommitted and untracked files come back from the hidden ref. GitHub accepts that ref and starts no CI for it.",
  B3: "It still works after OpenCode's patch version changes.",
  B4: "A 200-turn session restores in under 30 s (working value). The archive's size is recorded.",
  B5: "The rebuild template alone gets at least 4 of 5.",
} as const;

/** The runs `--only` selects, by group. */
export const RUN_GROUPS = ["stub", "model", "patch", "long", "container", "github"] as const;
export type RunGroup = (typeof RUN_GROUPS)[number];

export type Results = {
  readonly inputs: Inputs;
  readonly stub: MoveResult | undefined;
  /** The stub run whose interrupted turn says a sentence first. */
  readonly stubChatty: MoveResult | undefined;
  readonly model: MoveResult | undefined;
  readonly patchFar: MoveResult | undefined;
  readonly patchUp: MoveResult | undefined;
  readonly patchDown: MoveResult | undefined;
  /** The stub move with every box a fresh container. Needs Docker. */
  readonly container: MoveResult | undefined;
  readonly long: LongSessionResult | undefined;
  /** Recorded only: the long session with OpenCode's compaction on. */
  readonly longCompacted: LongSessionResult | undefined;
  readonly github: { readonly checks: readonly Check[]; readonly recorded: Readonly<Record<string, string | number | boolean>> } | undefined;
  /** Runs left out with --only. */
  readonly notSelected: ReadonlySet<RunGroup>;
};

const NOT_SELECTED = "not selected (--only); a plain `pnpm spike` runs it";

/** Why a run has no result: left out, or it never got going. */
const missingReason = (results: Results, run: RunGroup, otherwise: string): string => (results.notSelected.has(run) ? NOT_SELECTED : otherwise);

const failedRun = (result: MoveResult): string | undefined => result.error ?? result.restoreError;

const scoreText = (score: Score): string =>
  `${String(score.correct)}/${String(score.of)}: ${score.answers
    .map((a) => {
      if (a.correct) return `${a.id} right`;
      if (a.expected === undefined) return `${a.id} unscorable (the fact was never learned)`;
      if (a.toolCallsCompleted > 0) return `${a.id} wrong (a tool ran during the answer)`;
      return `${a.id} wrong`;
    })
    .join(", ")}`;

const scoreNote = (result: MoveResult): string => (result.restored === undefined ? "not restored" : scoreText(result.restored.score));

const finishNote = (result: MoveResult): string =>
  result.restored === undefined
    ? "not restored"
    : `stopReason=${result.restored.finish.stopReason}; ${Object.entries(result.restored.finish.found).map(([k, v]) => `${k}: ${v ? "yes" : "NO"}`).join("; ")}`;

/** The checks for one move: really interrupted, restored, 5 of 5, edit finished. */
const moveChecks = (result: MoveResult | undefined, what: string, missing: string): Check[] => {
  const names = [
    `${what}: the turn was really interrupted (cancelled during the slow check, its last edit not made)`,
    `${what}: export, upload, a fresh box, import and session/load replay the history`,
    `${what}: 5 of 5 questions about earlier turns`,
    `${what}: the interrupted edit is finished`,
  ];
  if (result === undefined) return names.map((name) => skip(name, missing));
  const h = result.history;
  const interrupted =
    h === undefined
      ? fail(names[0] ?? "", result.error ?? "no history")
      : check(
          names[0] ?? "",
          h.turns[5]?.stopReason === "cancelled" && h.interruptedInSlowCheck && h.leftLineAbsent,
          `turn 6 stopReason=${h.turns[5]?.stopReason ?? "none"}; the slow check was running: ${String(h.interruptedInSlowCheck)}; the last edit was not on disk: ${String(h.leftLineAbsent)}`,
        );
  const broke = failedRun(result);
  if (broke !== undefined || result.restored === undefined) return [interrupted, ...names.slice(1).map((name) => fail(name, broke ?? "not restored"))];
  const r = result.restored;
  return [
    interrupted,
    check(names[1] ?? "", r.importOk && r.sameId && r.replayed > 0 && r.replayHasTurn1, `${String(r.replayed)} updates replayed; turn 1 ${r.replayHasTurn1 ? "among them" : "MISSING"}; import kept the ID: ${String(r.sameId)}; OpenCode ${result.from} → ${result.to}`),
    check(names[2] ?? "", r.score.correct === 5, scoreNote(result)),
    check(names[3] ?? "", r.finish.finished, finishNote(result)),
  ];
};

const scopeNote = (result: MoveResult): string => {
  const parts = (["boxA", "boxB"] as const).map((k) => {
    const t = result.toolScope[k];
    return t === undefined ? `${k}: none` : `${k}: ${String(t.allowed)} allowed, ${String(t.rejected)} rejected${t.rejected > 0 ? ` (${Object.entries(t.rejectedKinds).map(([kind, n]) => `${kind} ${String(n)}`).join(", ")})` : ""}`;
  });
  return parts.join("; ");
};

const answersWithTools = (score: Score | undefined): number => score?.answers.filter((a) => a.toolCalls > 0).length ?? 0;

const b1 = (results: Results): Criterion => {
  const { stub, model, container, inputs } = results;
  const checks: Check[] = [...moveChecks(stub, "through the stub model", missingReason(results, "stub", "the stub run did not run"))];
  if (stub?.control !== undefined) {
    checks.push(check("control: a fresh box without the archive can't session/load the session", stub.control.loadFailed, stub.control.note));
  }
  checks.push(
    ...moveChecks(model, "with the model.env endpoint", inputs.model === undefined ? MODEL_INPUT_HINT : missingReason(results, "model", "the model run did not run")).filter((_, i) => i !== 1),
  );
  checks.push(
    ...moveChecks(
      container,
      "in fresh containers (each box its own container), through the stub model",
      inputs.docker ? missingReason(results, "container", "the container run did not run") : DOCKER_INPUT_HINT,
    ),
  );
  const recorded: Record<string, string | number | boolean> = {};
  if (stub?.restored !== undefined) {
    recorded["restore of the 6-turn session, ms (clone → session/load)"] = stub.restored.totalMs;
    for (const [phase, ms] of Object.entries(stub.restored.timings)) recorded[`restore phase ${phase}, ms`] = ms;
  }
  if (container?.restored !== undefined) {
    recorded["containers: restore of the 6-turn session, ms (clone, container start → session/load)"] = container.restored.totalMs;
    for (const [phase, ms] of Object.entries(container.restored.timings)) recorded[`containers: restore phase ${phase}, ms`] = ms;
  }
  if (stub?.history !== undefined) {
    recorded["6-turn archive, bytes (gzipped)"] = `${String(stub.history.archive.summary.bytes)} (${String(stub.history.archive.gzBytes)})`;
    recorded["after-turn work per turn, ms (commit, hidden ref, export, upload)"] = stub.history.turns.map((t) => t.afterTurnMs).join(", ");
  }
  if (stub?.elsewhere !== undefined) recorded["import --directory into another path, then session/load there"] = `${stub.elsewhere.loaded ? "loaded" : "FAILED"}; ${stub.elsewhere.note}`;
  for (const [label, result] of [["stub", stub], ["model.env", model], ["containers", container]] as const) {
    if (result === undefined) continue;
    recorded[`${label}: tool calls outside the workspace (the decider)`] = scopeNote(result);
    recorded[`${label}: answers during which the agent tried a tool (all rejected)`] = answersWithTools(result.restored?.score);
  }
  return { id: "B1", title: BULLETS.B1, checks, recorded };
};

const b2 = (results: Results): Criterion => {
  const { stub, github } = results;
  const checks: Check[] = [];
  const names = [
    "uncommitted changes come back: a staged new file, an unstaged edit and a staged delete (git status identical)",
    "untracked files come back",
    "the hidden ref leaves the task's branch alone (not moved, the commit on no branch)",
    "a plain clone of the remote doesn't fetch the hidden ref",
  ];
  const h = stub?.restored?.hiddenRef;
  if (stub === undefined || h === undefined) {
    for (const name of names) {
      if (stub === undefined && results.notSelected.has("stub")) checks.push(skip(name, NOT_SELECTED));
      else checks.push(fail(name, stub === undefined ? "the stub run did not run" : (failedRun(stub) ?? "not restored")));
    }
  } else {
    const expected = ["A  src/", " M notes.txt", "D  old.txt"];
    const hasAll = expected.every((prefix) => h.statusBefore.some((s) => s.startsWith(prefix)));
    const same = JSON.stringify(h.statusBefore) === JSON.stringify(h.statusAfter);
    checks.push(check(names[0] ?? "", hasAll && same, `box A: [${h.statusBefore.join(" | ")}]; box B: ${same ? "the same" : `[${h.statusAfter.join(" | ")}]`}`));
    checks.push(check(names[1] ?? "", h.untrackedBack, `${String(h.statusBefore.filter((s) => s.startsWith("??")).length)} untracked before, the same after: ${String(h.untrackedBack)}`));
    checks.push(check(names[2] ?? "", h.branchUnmoved && h.notOnBranch, `branch unmoved: ${String(h.branchUnmoved)}; on a branch: ${String(!h.notOnBranch)}`));
    checks.push(check(names[3] ?? "", h.notInPlainClone, h.notInPlainClone ? "no refs/ostra/* after git clone" : "git clone brought refs/ostra/*"));
  }
  if (github === undefined) checks.push(skip("GitHub accepts the hidden ref and starts no CI for it", missingReason(results, "github", "the GitHub run did not run")));
  else checks.push(...github.checks);
  const recorded: Record<string, string | number | boolean> = { ...(github?.recorded ?? {}) };
  if (h !== undefined) recorded["ignored files (debug.log, in .gitignore) come back"] = h.ignoredBack;
  return { id: "B2", title: BULLETS.B2, checks, recorded };
};

const b3 = (results: Results): Criterion => {
  const checks = [
    ...moveChecks(results.patchFar, "OpenCode 2.3.0 → 2.3.2 (an upgrade across two patches, five days apart)", missingReason(results, "patch", "the 2.3.0 run did not run")),
    ...moveChecks(results.patchUp, "OpenCode 2.3.1 → 2.3.2 (an upgrade, 82 minutes apart)", missingReason(results, "patch", "the upgrade run did not run")),
    ...moveChecks(results.patchDown, "OpenCode 2.3.2 → 2.3.1 (a rollback)", missingReason(results, "patch", "the rollback run did not run")),
  ];
  return { id: "B3", title: BULLETS.B3, checks };
};

const longRecorded = (long: LongSessionResult, prefix: string): Record<string, string | number | boolean> => {
  const recorded: Record<string, string | number | boolean> = {
    [`${prefix}turns`]: long.turns,
    [`${prefix}OpenCode compaction calls while building it`]: long.compactionCalls,
    [`${prefix}building the session, s`]: Math.round(long.buildMs / 1000),
  };
  if (long.error !== undefined) recorded[`${prefix}error`] = long.error;
  if (long.archive !== undefined) {
    recorded[`${prefix}archive bytes`] = long.archive.summary.bytes;
    recorded[`${prefix}archive bytes, gzipped`] = long.archive.gzBytes;
    recorded[`${prefix}archive messages by type`] = Object.entries(long.archive.summary.types).map(([k, v]) => `${k} ${String(v)}`).join(", ");
    recorded[`${prefix}export, ms`] = long.archive.exportMs;
  }
  if (long.totalMs !== undefined) recorded[`${prefix}restore, ms (fresh box → session/load)`] = long.totalMs;
  if (long.replayed !== undefined) recorded[`${prefix}updates replayed by session/load`] = long.replayed;
  recorded[`${prefix}turn 1's fact answered after the restore`] = long.recalled;
  for (const [phase, ms] of Object.entries(long.timings ?? {})) recorded[`${prefix}restore phase ${phase}, ms`] = ms;
  return recorded;
};

const b4 = (results: Results): Criterion => {
  const { long, longCompacted } = results;
  const compactedRecorded = longCompacted === undefined ? {} : longRecorded(longCompacted, "with compaction on (recorded only): ");
  if (long === undefined) {
    const name = "the 200-turn run";
    return { id: "B4", title: BULLETS.B4, checks: [results.notSelected.has("long") ? skip(name, NOT_SELECTED) : fail(name, "did not run")], recorded: compactedRecorded };
  }
  if (long.error !== undefined || long.totalMs === undefined || long.archive === undefined) {
    return { id: "B4", title: BULLETS.B4, checks: [fail(`the ${String(long.turns)}-turn run`, long.error ?? "no restore")], recorded: compactedRecorded };
  }
  const checks: Check[] = [
    check(
      `a ${String(long.turns)}-turn session restores in under 30 s (compaction off; fresh box: clone, hidden ref, download, import, start, session/load)`,
      long.totalMs < RESTORE_BUDGET_MS,
      `${String(long.totalMs)} ms (the session's share: ${String(long.sessionMs ?? 0)} ms)`,
    ),
    check("the restored session still holds turn 1 (the codename)", long.recalled, long.recalled ? `answered from ${String(long.turns - 1)} turns back` : "turn 1's fact was not in the context"),
    pass("the archive's size is recorded", `${String(long.archive.summary.bytes)} bytes, ${String(long.archive.gzBytes)} gzipped, ${String(long.archive.summary.messages)} messages`),
  ];
  return { id: "B4", title: BULLETS.B4, checks, recorded: { ...longRecorded(long, ""), ...compactedRecorded } };
};

const templateCheck = (result: MoveResult | undefined, what: string, missing: string): Check => {
  const name = `${what}: the rebuild template alone (ADR 0039: the agent's last message) gets at least 4 of 5`;
  if (result === undefined) return skip(name, missing);
  if (result.error !== undefined) return fail(name, result.error);
  if (result.template === undefined) return fail(name, result.templateError ?? "the template run did not run");
  return check(name, result.template.score.correct >= 4, scoreText(result.template.score));
};

const everyMessageCheck = (result: MoveResult | undefined, what: string, missing: string): Check => {
  const name = `${what}: the proposed template (every agent message, not only the last) gets at least 4 of 5`;
  if (result === undefined) return skip(name, missing);
  if (result.error !== undefined) return fail(name, result.error);
  const all = result.templateEveryAgentMessage;
  if (all === undefined) return fail(name, result.templateError ?? "the variant did not run");
  return check(name, all.correct >= 4, scoreText(all));
};

const b5 = (results: Results): Criterion => {
  const modelMissing = results.inputs.model === undefined ? MODEL_INPUT_HINT : missingReason(results, "model", "the model run did not run");
  const runs = [
    [results.stub, "through the stub model, quiet interrupted turn", missingReason(results, "stub", "the stub run did not run")],
    [results.stubChatty, "through the stub model, chatty interrupted turn", missingReason(results, "stub", "the chatty run did not run")],
    [results.model, "with the model.env endpoint", modelMissing],
  ] as const;
  const checks = [...runs.map(([result, what, missing]) => templateCheck(result, what, missing)), ...runs.map(([result, what, missing]) => everyMessageCheck(result, what, missing))];
  const recorded: Record<string, string | number | boolean> = {};
  for (const [result, label] of runs) {
    if (result?.template === undefined) continue;
    recorded[`${label}: template prompt, chars`] = result.template.promptChars;
    recorded[`${label}: the template's session finishes the interrupted edit`] = result.template.finish.finished;
  }
  return { id: "B5", title: BULLETS.B5, checks, recorded };
};

export const passBar = (results: Results): Criterion[] => [b1(results), b2(results), b3(results), b4(results), b5(results)];
