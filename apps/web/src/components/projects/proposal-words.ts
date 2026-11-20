import type { EnvironmentProposal } from "@ostra/protocol";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The environment proposal's pure parts (app-targets/m6/environment-proposal.md; F-113, ticket
// 36): a line diff of two setup scripts, the task line's state, and the proposal an admin edits
// before accepting it.

export type ProposalView = NonNullable<RouterOutputs["environments"]["proposal"]>;
export type Onboarding = RouterOutputs["environments"]["onboarding"];

export type DiffRow = { readonly sign: "+" | "-" | " "; readonly text: string } | { readonly sign: "fold"; readonly lines: number };

/**
 * The lines of `before` and `after` as a unified diff (a longest common subsequence of lines), with
 * runs of more than 3 unchanged lines between changes folded into one row.
 */
export const lineDiff = (before: string | null, after: string | null): readonly DiffRow[] => {
  const a = before === null || before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after === null || after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i];
      if (row === undefined) continue;
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const rows: { sign: "+" | "-" | " "; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      rows.push({ sign: " ", text: left });
      i += 1;
      j += 1;
    } else if (left !== undefined && (right === undefined || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      // A removed line before the line that replaces it, as a unified diff reads.
      rows.push({ sign: "-", text: left });
      i += 1;
    } else if (right !== undefined) {
      rows.push({ sign: "+", text: right });
      j += 1;
    }
  }
  // Fold the unchanged runs longer than 3 lines between (or around) the changes.
  const out: DiffRow[] = [];
  let run: { sign: " "; text: string }[] = [];
  const flush = (atEdge: boolean) => {
    if (run.length > 3 && !atEdge) out.push(...run.slice(0, 1), { sign: "fold", lines: run.length - 2 }, ...run.slice(-1));
    else if (run.length > 3) out.push({ sign: "fold", lines: run.length });
    else out.push(...run);
    run = [];
  };
  rows.forEach((row) => {
    if (row.sign === " ") {
      run.push({ sign: " ", text: row.text });
      return;
    }
    flush(out.length === 0);
    out.push(row);
  });
  flush(true);
  return out.filter((row, index, all) => !(row.sign === "fold" && all.length === 1));
};

/** The onboarding task's state, as its line says it. */
export const taskStateWords = (task: NonNullable<Onboarding["task"]>, age: string): string => {
  if (task.open && task.state === "needs_you") return t("proposal.task.waiting");
  if (task.open) return t("proposal.task.running", { age });
  if (task.state === "stopped") return t("proposal.task.stopped");
  return t("proposal.task.done", { age });
};

/** How many parts of a repo's block change: its script, each check and each variable name to set. */
export const changesOf = (repo: ProposalView["repos"][number]): number =>
  (repo.setupScript.changed ? 1 : 0) + repo.checks.added.length + repo.checks.changed.length + repo.variableNames.missing.length;

/** The proposal with one repo's setup script and checks' commands replaced: what "Edit and accept" sends. */
export const editedProposal = (
  body: EnvironmentProposal,
  edits: ReadonlyMap<string, { readonly setupScript: string; readonly commands: ReadonlyMap<string, string> }>,
): EnvironmentProposal => ({
  ...body,
  repos: body.repos.map((repo) => {
    const edit = edits.get(repo.repoId);
    if (edit === undefined) return repo;
    return {
      ...repo,
      setupScript: edit.setupScript.trim() === "" ? null : edit.setupScript,
      checks: repo.checks.map((check) => ({ ...check, command: edit.commands.get(check.name) ?? check.command })),
    };
  }),
});

/** What a project admin decided on a proposal, as the tab says it. */
export type Decided = { readonly kind: "accepted"; readonly version: number | null } | { readonly kind: "rejected" };

/**
 * The decision the tab shows: the one just made on this page, else the one the server keeps for the
 * onboarding task's last proposal, so a reload still says "Accepted as version N" rather than that
 * the task ended without a proposal.
 */
export const decidedOf = (justDecided: Decided | null, kept: Onboarding["decision"] | null): Decided | null =>
  justDecided ?? (kept === null ? null : kept.kind === "accepted" ? { kind: "accepted", version: kept.version } : { kind: "rejected" });
