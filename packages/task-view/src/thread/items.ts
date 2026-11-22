import type { MemberId } from "@ostra/protocol";

import type {
  AttachmentsData,
  DraftData,
  HeldData,
  LimitData,
  MemoryProposedData,
  PullRequestData,
  PushedData,
  QuestionData,
  ReviewData,
  SubagentNode,
  SubagentTree,
  SystemEvent,
  TaskUIMessage,
} from "../ui-types.ts";
import { isFailure, recoveredFailures } from "./recovered.ts";
import { countKindOf, piecesOf, stepWeight } from "./steps.ts";
import type { CaptureStep, Piece, PreviewShown, ProsePart, ReadStep, RunCountKind, RunStep, StepState, ThreadContext } from "./steps.ts";

// Milestone 10 (F-151, spec section 5.3, content fix 1): one message's items for the column, in its
// order, so the panel renders items and never groups parts itself, and every test and viewer sees
// the same grouping. A turn's steps between two pieces of its prose are one run; its prose, what it
// made, what waits on a member, and a failure it didn't recover from are items of their own. No
// words: ticket 04 words them. Pure.

/** One kind's count on a run's line: reads and edits their distinct files, captures their pictures, the rest their steps. */
export type RunCount = { readonly kind: RunCountKind; readonly n: number };

/** A run's answered approvals, for its line's tail: who approved, who denied, and whether a deny gave a reason. */
export type RunApprovals = {
  readonly approved: readonly { readonly by: MemberId }[];
  readonly denied: readonly { readonly by: MemberId; readonly withReason: boolean }[];
};

/** A turn's steps between two pieces of its prose (or its start and its first, or its last and its end): one line that opens in place. */
export type RunItem = {
  readonly kind: "run";
  readonly id: string;
  /** Its steps in order, every read of the run on one step (the first read's place). */
  readonly steps: readonly RunStep[];
  /** Its counts by kind, in the order each kind's first step happened. */
  readonly counts: readonly RunCount[];
  /** A thought that starts the run, and how long it took (`null` while it streams); `null` when the run doesn't start with one. */
  readonly thought: { readonly ms: number | null } | null;
  /** Its failed steps the turn recovered from, counted, and the ones it didn't (each also a `failure` item after the run, once it closed). */
  readonly failures: { readonly recovered: number; readonly unrecovered: readonly RunStep[] };
  readonly approvals: RunApprovals;
  /** The subagents its steps started, nested ones included, by state; `null` when it started none. */
  readonly subagents: SubagentTree["counts"] | null;
  /** How many steps it took, every call once (a thought and an info line not counted). */
  readonly total: number;
  /** The turn's first run: its line carries the turn's time. */
  readonly firstInTurn: boolean;
  /** The turn runs and this is the run it's in: the live step stands in its line's place. */
  readonly open: boolean;
};

/** What failed, on a red line of its own: a step the turn didn't recover from, the turn itself, a crashed session, a lost box. */
export type TurnFailure =
  | { readonly cause: "step"; readonly step: RunStep }
  | { readonly cause: "turn"; readonly error: string }
  | { readonly cause: "crashed"; readonly event: Extract<SystemEvent, { kind: "session.crashed" }> }
  | { readonly cause: "lost"; readonly event: Extract<SystemEvent, { kind: "runner.lost" }> };

/** A stop that isn't an error, on a quiet line: a runaway limit, a budget hold, an approval nobody answered in time. */
export type TurnNotice =
  | { readonly cause: "limit"; readonly limit: LimitData }
  | { readonly cause: "held"; readonly held: HeldData }
  | { readonly cause: "approval-expired"; readonly step: RunStep };

/** What a turn made, one line each after its prose: a push, the PR (its card, under the push that opened it), a review, a draft, a preview, a memory. */
export type TurnResult =
  | { readonly kind: "push"; readonly push: PushedData }
  | { readonly kind: "pr"; readonly pr: PullRequestData }
  | { readonly kind: "review"; readonly review: ReviewData }
  | { readonly kind: "draft"; readonly draft: DraftData }
  | { readonly kind: "preview"; readonly preview: PreviewShown; readonly toolCallId: string }
  | { readonly kind: "memory"; readonly memory: MemoryProposedData };

/** What waits on a member: the agent's question (its receipt in the same place once answered), or a call's approval with its asking step. */
export type TurnNeed =
  | { readonly kind: "question"; readonly question: QuestionData }
  | { readonly kind: "approval"; readonly step: RunStep };

/** One item of the column, each with a stable `id`. */
export type TurnItem =
  | RunItem
  | { readonly kind: "prose"; readonly id: string; readonly part: ProsePart }
  | { readonly kind: "captures"; readonly id: string; readonly attachments: AttachmentsData }
  | { readonly kind: "failure"; readonly id: string; readonly failure: TurnFailure }
  | { readonly kind: "notice"; readonly id: string; readonly notice: TurnNotice }
  | { readonly kind: "result"; readonly id: string; readonly result: TurnResult }
  | {
      readonly kind: "needs";
      readonly id: string;
      /** It still waits: an open question or a pending approval. An answered or closed question keeps its place, as its receipt. */
      readonly open: boolean;
      readonly need: TurnNeed;
    };

export type TurnItemKind = TurnItem["kind"];

const isRead = (step: RunStep): step is ReadStep => step.kind === "read";
const isCapture = (step: RunStep): step is CaptureStep => step.kind === "capture";

/** Every read of a run as one step, at the first read's place, with its distinct paths. */
const withReadsShared = (atoms: readonly RunStep[], recovered: ReadonlySet<string>): RunStep[] => {
  const reads = atoms.filter(isRead);
  const [first] = reads;
  if (first === undefined || reads.length === 1) return [...atoms];
  const state = (): StepState => {
    if (reads.some((read) => read.state === "running")) return "running";
    if (reads.some((read) => isFailure(read) && !recovered.has(read.id))) return "failed";
    return reads.some((read) => read.state === "done" || isFailure(read)) ? "done" : "cancelled";
  };
  const starts = reads.flatMap((read) => (read.startedAt === null ? [] : [read.startedAt]));
  const ends = reads.flatMap((read) => (read.endedAt === null ? [] : [read.endedAt]));
  const shared: ReadStep = {
    ...first,
    state: state(),
    startedAt: starts.length === 0 ? null : Math.min(...starts),
    endedAt: reads.some((read) => read.endedAt === null) || ends.length === 0 ? null : Math.max(...ends),
    fullSubject: [...new Set(reads.map((read) => read.fullSubject))].join(", "),
    approval: reads.find((read) => read.approval !== null)?.approval ?? null,
    error: reads.find((read) => isFailure(read) && !recovered.has(read.id))?.error ?? null,
    paths: [...new Set(reads.flatMap((read) => read.paths))],
    toolCallIds: reads.flatMap((read) => read.toolCallIds),
  };
  return atoms.flatMap((atom): RunStep[] => {
    if (!isRead(atom)) return [atom];
    return atom === first ? [shared] : [];
  });
};

/** A run's counts by kind, in the order each kind's first step happened. */
const countsOf = (atoms: readonly RunStep[]): RunCount[] => {
  const counts = new Map<RunCountKind, number>();
  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  for (const atom of atoms) {
    const kind = countKindOf(atom);
    if (kind === null) continue;
    if (atom.kind === "read") {
      for (const path of atom.paths) readPaths.add(path);
      counts.set(kind, readPaths.size);
    } else if (atom.kind === "edit") {
      for (const file of atom.files) editPaths.add(file.path);
      counts.set(kind, editPaths.size);
    } else {
      counts.set(kind, (counts.get(kind) ?? 0) + stepWeight(atom));
    }
  }
  return [...counts].map(([kind, n]) => ({ kind, n }));
};

const approvalsOf = (atoms: readonly RunStep[]): RunApprovals => {
  const approved: { by: MemberId }[] = [];
  const denied: { by: MemberId; withReason: boolean }[] = [];
  for (const { approval } of atoms) {
    if (approval?.state !== "answered") continue;
    if (approval.decision === "deny") denied.push({ by: approval.by, withReason: approval.withReason === true });
    else approved.push({ by: approval.by });
  }
  return { approved, denied };
};

/** The subagents a run's steps started, nested ones included, counted by state. */
const subagentCountsOf = (atoms: readonly RunStep[], nodes: readonly SubagentNode[]): SubagentTree["counts"] | null => {
  const started = atoms.flatMap((atom) => (atom.kind === "subagent" ? [atom.node.id] : []));
  if (started.length === 0) return null;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const seen = new Map<string, SubagentNode>();
  const visit = (id: string): void => {
    const node = byId.get(id);
    if (node === undefined || seen.has(id)) return;
    seen.set(id, node);
    for (const child of node.children) visit(child);
  };
  for (const id of started) visit(id);
  const states = [...seen.values()].map((node) => node.state);
  const count = (state: SubagentNode["state"]): number => states.filter((one) => one === state).length;
  return { total: states.length, running: count("running"), needsApproval: count("needs-approval"), failed: count("failed"), stopped: count("stopped"), done: count("done") };
};

const isPendingApproval = (step: RunStep): boolean => step.approval?.state === "pending" && step.state === "running";

/**
 * One message's items, in its order (spec section 5.3).
 *
 * Over a turn: its runs, its prose, its captures under the run that took them, a failure it didn't
 * recover from right after its run, its question and pending approvals (each ending the run before
 * it), what it made after its prose, and a failed turn's red line last. Over a row outside any
 * turn: a crashed session or a lost box is a `failure`, a limit or a budget hold a `notice`, the
 * setup script a run of its one step, a member's capture from the pane its `captures`. A member's
 * message and a divider (a restore, a new driver, an effort change, a stop) have none: they're
 * drawn from their message (ticket 12).
 */
export const turnItemsOf = (message: TaskUIMessage, context: ThreadContext): TurnItem[] => {
  if (message.role === "user") return [];
  const pieces = piecesOf(message, context);
  const atoms = pieces.flatMap((piece) => (piece.t === "step" ? [piece.step] : []));
  const recovered = recoveredFailures(atoms);
  const turn = message.role === "assistant";
  const running = turn && message.metadata?.turnState === "running";
  const nodes = message.metadata?.subagents?.nodes ?? [];
  const items: TurnItem[] = [];
  let run: RunStep[] = [];
  let runs = 0;
  const previews: Extract<Piece, { t: "preview" }>[] = [];

  /** Closes the run so far; `byTheTurn`: its turn hasn't said or asked anything after it, so it's the one the turn is in. */
  const closeRun = (byTheTurn: boolean): void => {
    const atomsOfRun = run;
    run = [];
    const [first] = atomsOfRun;
    if (first === undefined) return;
    const open = running && byTheTurn;
    const unrecovered = atomsOfRun.filter((atom) => isFailure(atom) && !recovered.has(atom.id));
    items.push({
      kind: "run",
      id: `run:${first.id}`,
      steps: withReadsShared(atomsOfRun, recovered),
      counts: countsOf(atomsOfRun),
      thought: first.kind === "thought" ? { ms: first.ms } : null,
      failures: { recovered: atomsOfRun.filter((atom) => isFailure(atom) && recovered.has(atom.id)).length, unrecovered },
      approvals: approvalsOf(atomsOfRun),
      subagents: subagentCountsOf(atomsOfRun, nodes),
      total: atomsOfRun.reduce((sum, atom) => sum + stepWeight(atom), 0),
      firstInTurn: turn && runs === 0,
      open,
    });
    runs += 1;
    // While the turn is in the run, the live step says what failed so far; a later step may still recover it.
    if (!open) for (const step of unrecovered) items.push({ kind: "failure", id: `failure:${step.id}`, failure: { cause: "step", step } });
    for (const step of atomsOfRun) {
      if (step.approval?.state === "closed" && step.approval.reason === "expired") items.push({ kind: "notice", id: `notice:${step.id}`, notice: { cause: "approval-expired", step } });
    }
    for (const step of atomsOfRun.filter(isCapture)) items.push({ kind: "captures", id: `captures:${step.id}`, attachments: step.attachments });
  };

  // A turn's results come after its prose (ticket 02); the PR's card goes right under the push that opened it.
  const results = pieces.flatMap((piece) => (piece.t === "result" ? [piece.part] : []));
  const shownPrs = new Set<string>();
  const prKey = (pr: PullRequestData): string => `${pr.repoId}:${String(pr.number)}`;
  let resultsStarted = false;
  const startResults = (): void => {
    if (resultsStarted) return;
    resultsStarted = true;
    closeRun(true);
    for (const piece of previews) items.push({ kind: "result", id: `result:preview:${piece.toolCallId}`, result: { kind: "preview", preview: piece.preview, toolCallId: piece.toolCallId } });
  };

  for (const piece of pieces) {
    switch (piece.t) {
      case "step":
        if (isPendingApproval(piece.step)) {
          // The asking step leaves its run and stands where the live step was, its block under it.
          closeRun(false);
          items.push({ kind: "needs", id: `needs:${piece.step.id}`, open: true, need: { kind: "approval", step: piece.step } });
        } else {
          run.push(piece.step);
        }
        break;
      case "prose":
        closeRun(false);
        items.push({ kind: "prose", id: piece.id, part: piece.part });
        break;
      case "question":
        closeRun(false);
        items.push({ kind: "needs", id: `needs:${piece.part.data.questionId}`, open: piece.part.data.status.state === "open", need: { kind: "question", question: piece.part.data } });
        break;
      case "captures":
        closeRun(true);
        items.push({ kind: "captures", id: `captures:${piece.part.id ?? String(items.length)}`, attachments: piece.part.data });
        break;
      case "preview":
        previews.push(piece);
        break;
      case "result": {
        startResults();
        const { part } = piece;
        switch (part.type) {
          case "data-pushed": {
            items.push({ kind: "result", id: `result:${part.id ?? String(items.length)}`, result: { kind: "push", push: part.data } });
            const opened = part.data.firstPr;
            const card = opened === null ? undefined : results.find((other) => other.type === "data-pr" && prKey(other.data) === prKey(opened));
            if (card?.type === "data-pr" && !shownPrs.has(prKey(card.data))) {
              shownPrs.add(prKey(card.data));
              items.push({ kind: "result", id: `result:${card.id ?? prKey(card.data)}`, result: { kind: "pr", pr: card.data } });
            }
            break;
          }
          case "data-pr":
            if (shownPrs.has(prKey(part.data))) break;
            shownPrs.add(prKey(part.data));
            items.push({ kind: "result", id: `result:${part.id ?? prKey(part.data)}`, result: { kind: "pr", pr: part.data } });
            break;
          case "data-review":
            items.push({ kind: "result", id: `result:${part.id ?? String(items.length)}`, result: { kind: "review", review: part.data } });
            break;
          case "data-draft":
            items.push({ kind: "result", id: `result:${part.id ?? String(items.length)}`, result: { kind: "draft", draft: part.data } });
            break;
          case "data-memory-proposed":
            items.push({ kind: "result", id: `result:${part.id ?? String(items.length)}`, result: { kind: "memory", memory: part.data } });
            break;
          default:
            part satisfies never;
        }
        break;
      }
      case "row": {
        const { part } = piece;
        const id = part.id ?? String(items.length);
        switch (part.type) {
          case "data-system": {
            const { event } = part.data;
            if (event.kind === "session.crashed") items.push({ kind: "failure", id: `failure:${id}`, failure: { cause: "crashed", event } });
            else if (event.kind === "runner.lost") items.push({ kind: "failure", id: `failure:${id}`, failure: { cause: "lost", event } });
            // A restore and a stop are dividers (ticket 12); a runner's connection and a config change are the Event log's.
            break;
          }
          case "data-limit":
            items.push({ kind: "notice", id: `notice:${id}`, notice: { cause: "limit", limit: part.data } });
            break;
          case "data-held":
            items.push({ kind: "notice", id: `notice:${id}`, notice: { cause: "held", held: part.data } });
            break;
          default:
            part satisfies never;
        }
        break;
      }
      default:
        piece satisfies never;
    }
  }
  startResults();
  if (turn && message.metadata?.turnState === "failed") items.push({ kind: "failure", id: "failure:turn", failure: { cause: "turn", error: message.metadata.error ?? "" } });
  return items;
};
