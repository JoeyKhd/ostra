import { z } from "zod";

import type { TaskUIMessage } from "../ui-types.ts";
import { unrecoveredFailures } from "./recovered.ts";
import { piecesOf, stepWeight, toolNameOf } from "./steps.ts";
import type { RunStep, ThreadContext } from "./steps.ts";

// Milestone 10 (F-151, spec section 5.3, content fix 9): what the agent does this second while a
// turn runs, from the running part, with the turn's progress: its finished steps, its failures not
// yet recovered, the plan step in progress, and when the turn started (the panel ticks the clock
// from it, and announces a new step at most every 10 s). A pending approval's step stands in its
// place. No words: ticket 04 words it (`task.doing.*`). Pure.

/** What the agent does now, from the part that's running. */
export type LiveDoing =
  | { readonly kind: "thinking" }
  | { readonly kind: "writing" }
  /** `path` is the one file's, relative; `null` when it reads several at once (`count`). */
  | { readonly kind: "reading"; readonly path: string | null; readonly count: number }
  | { readonly kind: "editing"; readonly path: string }
  | { readonly kind: "running"; readonly command: string }
  | { readonly kind: "searching-code"; readonly query: string; readonly folder: string | null }
  | { readonly kind: "searching-web"; readonly query: string | null }
  | { readonly kind: "fetching"; readonly host: string | null }
  | { readonly kind: "capturing"; readonly route: string | null }
  | { readonly kind: "subagent"; readonly type: string | null; readonly description: string }
  | { readonly kind: "setting-up" }
  | { readonly kind: "compacting" }
  | { readonly kind: "tool"; readonly name: string; readonly server: string | null };

/** The plan's entry in progress (`data-plan`), `index` counted from 1, `of` the plan's length. */
export type LivePlanStep = { readonly index: number; readonly of: number; readonly entry: string };

export type LiveStep = {
  readonly doing: LiveDoing;
  /** The turn's finished steps: every call once, failed and cancelled ones too; a thought isn't a step. */
  readonly done: number;
  /** The turn's failures it hasn't recovered from yet. */
  readonly failed: number;
  readonly planStep: LivePlanStep | null;
  /** When the turn started, in ms since the epoch: the clock's start. `null` on a turn whose start never came. */
  readonly startedAt: number | null;
  /** The step whose approval is pending: it stands in the live step's place, and its block follows it. */
  readonly waiting: RunStep | null;
};

const routeInputSchema = z.object({ path: z.string().optional() });

/** What a running step says the agent does. `reads`: how many reads run at once. */
const doingOf = (step: RunStep, reads: number, context: ThreadContext): LiveDoing | null => {
  switch (step.kind) {
    case "thought":
      return { kind: "thinking" };
    case "read":
      return reads > 1 ? { kind: "reading", path: null, count: reads } : { kind: "reading", path: step.paths[0] ?? null, count: 1 };
    case "edit":
      return { kind: "editing", path: step.path };
    case "command":
      return { kind: "running", command: step.line };
    case "search":
      return { kind: "searching-code", query: step.query, folder: step.folder };
    case "web-search":
      return { kind: "searching-web", query: step.query };
    case "fetch":
      return { kind: "fetching", host: step.host };
    case "subagent":
      return { kind: "subagent", type: step.node.type, description: step.node.description };
    case "setup":
      return { kind: "setting-up" };
    case "compaction":
      return { kind: "compacting" };
    case "ostra": {
      if (step.tool === "take_screenshot" || step.tool === "record_app") {
        const input = routeInputSchema.safeParse(step.input);
        return { kind: "capturing", route: input.success ? (input.data.path ?? null) : null };
      }
      return { kind: "tool", ...toolNameOf(step.fullSubject, context.mcpServers) };
    }
    case "pr-text":
    case "tool":
      return { kind: "tool", ...toolNameOf(step.fullSubject, context.mcpServers) };
    case "capture":
    case "info":
      // A capture is done when it shows; an app process starting is the box's, not the agent's step.
      return null;
    default:
      return step satisfies never;
  }
};

const planStepOf = (message: TaskUIMessage): LivePlanStep | null => {
  const plan = message.parts.findLast((part) => part.type === "data-plan");
  if (plan?.type !== "data-plan") return null;
  const index = plan.data.entries.findIndex((entry) => entry.status === "in_progress");
  const entry = plan.data.entries[index];
  return entry === undefined ? null : { index: index + 1, of: plan.data.entries.length, entry: entry.content };
};

/**
 * The live step of a turn that runs (spec section 5.3), or `null`: the turn ended or failed, the
 * message isn't a turn, or the turn waits on its question with nothing running (the question's
 * block stands at its end). The setup script's row, while it runs, is `setting-up`.
 */
export const liveStepOf = (message: TaskUIMessage, context: ThreadContext): LiveStep | null => {
  const pieces = piecesOf(message, context);
  if (message.role === "system") {
    const setup = pieces.find((piece) => piece.t === "step" && piece.step.kind === "setup" && piece.step.state === "running");
    return setup === undefined ? null : { doing: { kind: "setting-up" }, done: 0, failed: 0, planStep: null, startedAt: null, waiting: null };
  }
  if (message.role !== "assistant" || message.metadata?.turnState !== "running") return null;
  const steps = pieces.flatMap((piece) => (piece.t === "step" ? [piece.step] : []));
  const pending = (step: RunStep): boolean => step.approval?.state === "pending" && step.state === "running";
  const waiting = steps.find(pending) ?? null;
  // The latest thing at work: a step running, or the prose the agent writes now.
  let latest: { readonly t: "step"; readonly step: RunStep } | { readonly t: "writing" } | null = null;
  for (const piece of pieces) {
    if (piece.t === "step" && piece.step.state === "running" && !pending(piece.step) && piece.step.kind !== "info") latest = { t: "step", step: piece.step };
    else if (piece.t === "prose" && piece.part.type === "text" && piece.part.state === "streaming") latest = { t: "writing" };
  }
  const asking = pieces.some((piece) => piece.t === "question" && piece.part.data.status.state === "open");
  if (asking && latest === null && waiting === null) return null;
  const reads = steps.filter((step) => step.kind === "read" && step.state === "running" && !pending(step)).length;
  const doing: LiveDoing = latest === null ? { kind: "thinking" } : latest.t === "writing" ? { kind: "writing" } : (doingOf(latest.step, reads, context) ?? { kind: "thinking" });
  return {
    doing,
    done: steps.filter((step) => step.state !== "running").reduce((sum, step) => sum + stepWeight(step), 0),
    failed: unrecoveredFailures(steps).length,
    planStep: planStepOf(message),
    startedAt: message.metadata.at ?? null,
    waiting,
  };
};
