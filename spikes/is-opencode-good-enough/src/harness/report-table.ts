// What was recorded per run, as a table: spend from the proxy, time, turns,
// approvals and events, with the checks beside them. `pnpm report` prints it
// for a set; `pnpm spike` prints it for the dry-run.

import type { RunRecord } from "../runner/schemas.ts";

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const usd = (record: RunRecord): string => (record.spend.usd === null ? "n/a" : `$${record.spend.usd.toFixed(4)}`);

const cell = (text: string, width: number): string => text.padStart(width);

const HEADER = ["run", "outcome", "time s", "calls", "tools", "appr", "events", "ev/min", "tokens", "spend", "CI", "accept"] as const;
const WIDTHS = [10, 13, 7, 6, 6, 5, 7, 7, 9, 9, 6, 7] as const;

const row = (cells: readonly string[]): string => cells.map((text, i) => cell(text, WIDTHS[i] ?? 8)).join(" ");

export const runRow = (r: RunRecord): string =>
  row([
    r.runId,
    r.outcome,
    seconds(r.time.wallMs),
    String(r.turns.modelCalls),
    String(r.turns.toolCalls),
    String(r.approvals.requested),
    String(r.events.total),
    String(r.events.perMinute),
    String(r.spend.totalTokens),
    usd(r),
    r.checks.ci.green ? "green" : "RED",
    r.checks.acceptance.passed ? "pass" : "fail",
  ]);

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export type TicketAggregate = {
  readonly ticketId: string;
  readonly runs: number;
  readonly wallS: number;
  readonly modelCalls: number;
  readonly approvals: number;
  readonly events: number;
  readonly tokens: number;
  readonly usd: number | null;
  readonly acceptancePassed: number;
  readonly ciGreen: number;
};

export const aggregateByTicket = (records: readonly RunRecord[]): TicketAggregate[] => {
  const ids = [...new Set(records.map((r) => r.ticketId))].sort((a, b) => Number(a.replace(/^\D+/, "")) - Number(b.replace(/^\D+/, "")));
  return ids.map((ticketId) => {
    const runs = records.filter((r) => r.ticketId === ticketId);
    const priced = runs.every((r) => r.spend.usd !== null);
    return {
      ticketId,
      runs: runs.length,
      wallS: mean(runs.map((r) => r.time.wallMs / 1000)),
      modelCalls: mean(runs.map((r) => r.turns.modelCalls)),
      approvals: mean(runs.map((r) => r.approvals.requested)),
      events: mean(runs.map((r) => r.events.total)),
      tokens: mean(runs.map((r) => r.spend.totalTokens)),
      usd: priced ? mean(runs.map((r) => r.spend.usd ?? 0)) : null,
      acceptancePassed: runs.filter((r) => r.checks.acceptance.passed).length,
      ciGreen: runs.filter((r) => r.checks.ci.green).length,
    };
  });
};

export const formatRunTable = (records: readonly RunRecord[]): string => {
  const sorted = [...records].sort((a, b) => Number(a.ticketId.replace(/^\D+/, "")) - Number(b.ticketId.replace(/^\D+/, "")) || a.index - b.index);
  const lines = [row(HEADER), ...sorted.map(runRow)];
  const priced = records.every((r) => r.spend.usd !== null);
  const totalTokens = records.reduce((sum, r) => sum + r.spend.totalTokens, 0);
  const totalUsd = records.reduce((sum, r) => sum + (r.spend.usd ?? 0), 0);
  const stub = records.some((r) => r.spend.pricing === "stub");
  lines.push(
    "",
    `per ticket (means over its runs)`,
    row(["ticket", "runs", "time s", "calls", "-", "appr", "events", "-", "tokens", "spend", "CI ok", "accept"]),
    ...aggregateByTicket(records).map((a) =>
      row([a.ticketId, String(a.runs), a.wallS.toFixed(1), a.modelCalls.toFixed(1), "-", a.approvals.toFixed(1), a.events.toFixed(0), "-", a.tokens.toFixed(0), a.usd === null ? "n/a" : `$${a.usd.toFixed(4)}`, `${String(a.ciGreen)}/${String(a.runs)}`, `${String(a.acceptancePassed)}/${String(a.runs)}`]),
    ),
    "",
    `total: ${String(records.length)} runs, ${String(totalTokens)} tokens, ${priced ? `$${totalUsd.toFixed(4)}${stub ? " at the stub's made-up prices" : ""}` : "spend not priced (set OSTRA_SPIKE_PRICE_INPUT and _OUTPUT)"}`,
  );
  return lines.join("\n");
};
