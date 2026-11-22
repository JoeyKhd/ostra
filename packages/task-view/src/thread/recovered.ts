import type { RunStep } from "./steps.ts";

// Milestone 10 (F-151, the targets' choice 4, spec section 5.3): what "recovered" means. A failed
// step (a command's exit other than 0, `killed`, or any tool's error) is recovered when a later step
// in the same turn, of the same kind and the same subject (the same command line, path or URL),
// succeeded. `pnpm test a` failing and `pnpm test b` passing is not recovered. A cancelled step
// (its turn cancelled, its approval denied or closed) isn't a failure at all.

/** Whether a step failed. A cancelled or denied one didn't: it never ran. */
export const isFailure = (step: RunStep): boolean => step.state === "failed";

/** What a step acted on, for matching a failure with a later success of the same kind: its full, raw subject. */
export const subjectOf = (step: RunStep): string => {
  switch (step.kind) {
    case "read":
    case "command":
    case "fetch":
    case "search":
    case "web-search":
    case "tool":
    case "capture":
    case "info":
      return step.fullSubject;
    case "edit":
      return step.files.map((file) => file.path).sort().join("\n");
    case "thought":
      return step.id;
    case "subagent":
      return `${step.node.type ?? ""}\n${step.node.description}`;
    case "ostra":
      return step.tool;
    case "setup":
    case "pr-text":
    case "compaction":
      return step.kind;
    default:
      return step satisfies never;
  }
};

/**
 * The failures a turn recovered from, by step ID: each failed step with a later step of the same
 * kind and subject that succeeded. `steps` are the turn's, in its order, one per call.
 */
export const recoveredFailures = (steps: readonly RunStep[]): ReadonlySet<string> => {
  const recovered = new Set<string>();
  steps.forEach((step, i) => {
    if (!isFailure(step)) return;
    const subject = subjectOf(step);
    if (steps.slice(i + 1).some((later) => later.kind === step.kind && later.state === "done" && subjectOf(later) === subject)) recovered.add(step.id);
  });
  return recovered;
};

/** The turn's failures it hasn't recovered from (yet, while it runs), in its order. */
export const unrecoveredFailures = (steps: readonly RunStep[]): RunStep[] => {
  const recovered = recoveredFailures(steps);
  return steps.filter((step) => isFailure(step) && !recovered.has(step.id));
};
