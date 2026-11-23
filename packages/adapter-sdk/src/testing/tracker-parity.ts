import type { BoardRef, TrackerAdapter } from "../tracker/base.ts";
import type { TrackerRichText } from "../tracker/capabilities.ts";

// Adapter parity for trackers (milestone 11, spec section 6; AGENTS.md, "Adapter parity"): the
// rows milestone 11 adds, and for each tracker adapter and fake what it declares on each and how
// `readWorkflow` answers. The panel reads these from the connection's adapter, never from its
// kind, so a tracker that declares one differently from this table, or whose workflow read answers
// otherwise, fails its package's parity test. A new tracker adds its entry here.

export const trackerParityRows = ["F-008 The magic word", "F-008 Rich text", "F-008 The JQL filter", "F-008 The workflow read"] as const;
export type TrackerParityRow = (typeof trackerParityRows)[number];

/** One tracker's answers to the rows: three it declares, and how its `readWorkflow` answers. */
export type TrackerParityEntry = {
  readonly magicWords: boolean;
  readonly richText: TrackerRichText;
  readonly jqlFilter: boolean;
  /** `reads`: the board's workflow (needs `statusGraph`); `unsupported`: no workflow read. */
  readonly readWorkflow: "reads" | "unsupported";
};

/** Spec section 6's parity table, milestone 11's rows, by adapter name. */
export const trackerParityTable: Readonly<Record<string, TrackerParityEntry>> = {
  linear: { magicWords: true, richText: "markdown", jqlFilter: false, readWorkflow: "unsupported" },
  jira: { magicWords: false, richText: "adf", jqlFilter: true, readWorkflow: "reads" },
  "jira-fake": { magicWords: false, richText: "adf", jqlFilter: true, readWorkflow: "reads" },
  "tiny-tracker": { magicWords: false, richText: "markdown", jqlFilter: false, readWorkflow: "unsupported" },
};

/** What doesn't hold of an adapter against the table: empty when it declares and answers as its entry says. */
export const checkTrackerParity = async (
  adapter: TrackerAdapter,
  board: BoardRef,
  table: Readonly<Record<string, TrackerParityEntry>> = trackerParityTable,
): Promise<readonly string[]> => {
  const entry = table[adapter.name];
  if (entry === undefined) {
    return [`${adapter.name}: no entry in the tracker parity table`];
  }
  const problems: string[] = [];
  const { capabilities } = adapter;
  if (capabilities.magicWords !== entry.magicWords) problems.push(`${adapter.name}: F-008 The magic word: declares ${String(capabilities.magicWords)}, the table says ${String(entry.magicWords)}`);
  if (capabilities.richText !== entry.richText) problems.push(`${adapter.name}: F-008 Rich text: declares ${capabilities.richText}, the table says ${entry.richText}`);
  if (capabilities.jqlFilter !== entry.jqlFilter) problems.push(`${adapter.name}: F-008 The JQL filter: declares ${String(capabilities.jqlFilter)}, the table says ${String(entry.jqlFilter)}`);
  const read = await adapter.readWorkflow(board);
  const answered = read.ok ? "reads" : read.error.code === "unsupported" ? "unsupported" : `fails (${read.error.code})`;
  if (answered !== entry.readWorkflow) problems.push(`${adapter.name}: F-008 The workflow read: answers ${answered}, the table says ${entry.readWorkflow}`);
  if (entry.readWorkflow === "reads" && !capabilities.statusGraph) problems.push(`${adapter.name}: F-008 The workflow read: reads a workflow without declaring statusGraph`);
  return problems;
};
