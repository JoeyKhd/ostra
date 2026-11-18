// The oracle: proves the ticket set and its checkers without any agent.
//   - on the pristine sample, every ticket's acceptance check fails (the work is
//     really undone), and the sample's own CI is green;
//   - with a ticket's reference solution applied as plain edits, its acceptance
//     check passes, and the CI is green (so the tickets are solvable, and the
//     checks are right);
//   - each failure variant (nothing done, half done, broken, a thin test suite)
//     is judged the way the dry-run expects.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { applySteps } from "../tickets/apply.ts";
import { buildSolution, EXPECTATIONS } from "../tickets/solutions.ts";
import { VariantSchema, type Ticket, type Variant } from "../tickets/schema.ts";
import { TICKETS } from "../tickets/tickets.ts";
import { checkResult, type AcceptanceResult, type CiResult } from "../runner/checks.ts";
import { collectDiff, initWorkspace, removeDir } from "../runner/workspace.ts";

export type OracleOutcome = {
  readonly ticket: Ticket;
  /** `base` is the pristine sample, with nothing applied. */
  readonly variant: Variant | "base";
  readonly ci: CiResult;
  readonly acceptance: AcceptanceResult;
  readonly log: string;
};

export const judge = async (ticket: Ticket, variant: Variant | "base", root: string): Promise<OracleOutcome | undefined> => {
  const dir = path.join(root, `${ticket.id}-${variant}`);
  await mkdir(dir, { recursive: true });
  const workspace = path.join(dir, "workspace");
  await initWorkspace(workspace, `oracle/${ticket.id}`);
  if (variant !== "base") {
    const solution = await buildSolution(ticket.id, variant);
    if (solution === undefined) return undefined;
    await applySteps(workspace, solution.steps);
  }
  const verifyRoot = path.join(dir, "verify");
  await collectDiff(workspace, verifyRoot);
  const checked = await checkResult(ticket, workspace, verifyRoot);
  await removeDir(dir);
  return { ticket, variant, ci: checked.ci, acceptance: checked.acceptance, log: checked.log };
};

export type OracleReport = { readonly outcomes: readonly OracleOutcome[] };

/** Runs the oracle over every ticket. `onlyTickets` narrows it for quick runs. */
export const runOracle = async (root: string, onlyTickets?: readonly string[]): Promise<OracleReport> => {
  const outcomes: OracleOutcome[] = [];
  const tickets = TICKETS.filter((t) => onlyTickets === undefined || onlyTickets.includes(t.id));
  const variants = ["base", ...VariantSchema.options] as const;
  for (const ticket of tickets) {
    for (const variant of variants) {
      const outcome = await judge(ticket, variant, root);
      if (outcome !== undefined) outcomes.push(outcome);
    }
  }
  return { outcomes };
};

/** What the oracle expects of an outcome: the base fails, a variant is judged as its expectation says. */
export const expectedAcceptance = (variant: Variant | "base"): "pass" | "fail" => (variant === "base" ? "fail" : EXPECTATIONS[variant].acceptance);
export const expectedCi = (variant: Variant | "base"): "green" | "red" => (variant === "base" ? "green" : EXPECTATIONS[variant].ci);
