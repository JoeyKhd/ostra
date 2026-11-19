import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { taskDirs } from "@ostra/adapter-opencode";
import { z } from "zod";

// OpenCode's own count of the tokens it used, read from its per-task database while the task runs
// (ADR 0042 compares the key proxy's count with the agent's: they must agree within 2%). The
// proxy meters every call; the agent's figure is independent of it, so the two can disagree.

export type TokenTotals = { readonly input: number; readonly output: number };

/** ADR 0042's bar. */
export const TOKEN_TOLERANCE = 0.02;

/** Where OpenCode keeps its database for a task whose agent folder is `agentDir`. */
export const agentDatabasePath = (agentDir: string): string => path.join(taskDirs(agentDir).xdgData, "opencode", "opencode.db");

/** Whether two counts agree within the tolerance, taken of the larger. */
export const withinTolerance = (a: number, b: number, tolerance: number = TOKEN_TOLERANCE): boolean => Math.abs(a - b) <= tolerance * Math.max(a, b);

const totalsRow = z.object({ input: z.coerce.number(), output: z.coerce.number() });
const tableRow = z.object({ name: z.string() });

/**
 * The ways OpenCode has stored its counts: a per-session total, or a total in each assistant
 * message. OpenCode keeps reasoning tokens apart from its output; a model endpoint bills them as
 * output (OpenAI's `completion_tokens` holds them), and the key proxy counts them so. So the
 * agent's output is its output plus its reasoning, where it records reasoning (2.3.2's `session_v2`).
 */
const STRATEGIES = [
  {
    table: "session_v2",
    columns: ["tokens_input", "tokens_output", "tokens_reasoning"],
    sql: "SELECT coalesce(sum(tokens_input), 0) AS input, coalesce(sum(tokens_output + tokens_reasoning), 0) AS output FROM session_v2",
  },
  { table: "session_v2", columns: ["tokens_input", "tokens_output"], sql: "SELECT coalesce(sum(tokens_input), 0) AS input, coalesce(sum(tokens_output), 0) AS output FROM session_v2" },
  { table: "session", columns: ["tokens_input", "tokens_output"], sql: "SELECT coalesce(sum(tokens_input), 0) AS input, coalesce(sum(tokens_output), 0) AS output FROM session" },
  {
    table: "message",
    columns: ["data"],
    sql: "SELECT coalesce(sum(json_extract(data, '$.tokens.input')), 0) AS input, coalesce(sum(json_extract(data, '$.tokens.output')), 0) AS output FROM message WHERE json_extract(data, '$.role') = 'assistant'",
  },
] as const;

/** The agent's own totals for the task, or `null` when the database or its counts can't be found. */
export const readAgentTotals = async (databaseFile: string): Promise<TokenTotals | null> => {
  if ((await stat(databaseFile).catch(() => null)) === null) return null;
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    for (const strategy of STRATEGIES) {
      const columns = database.prepare(`SELECT name FROM pragma_table_info('${strategy.table}')`).all().map((row) => tableRow.parse(row).name);
      if (strategy.columns.every((column) => columns.includes(column))) {
        return totalsRow.parse(database.prepare(strategy.sql).get());
      }
    }
    return null;
  } finally {
    database.close();
  }
};
