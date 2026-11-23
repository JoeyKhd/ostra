import type { ComposerMode } from "@/components/tasks/task-ticket";
import { t } from "@/lib/messages";

// Owner: ticket 11 (milestone 10, F-151: the composer, parts.md part 14, `s1.md`, `s2.md`, `s5.md`).
// What the one box says: its placeholder, the hint under it (milestones 1 to 3's per-state hints, in
// the targets' words) and the name of its Send. Pure: the page passes what it knows of the task.

/** The composer's words, for one state of the task. */
export type ComposerWords = {
  /** `Message OpenCode…`, `Reply to OpenCode…`, `Ask for changes to the plan…`, `Reopen with a message…`. */
  readonly placeholder: string;
  /** Under the box at the left: what Send does now. */
  readonly hint: string;
  /** Send's accessible name: it's an icon. `Reopen` when the message reopens the task on a box it picks. */
  readonly send: string;
};

/** What the box knows of the task to word itself. */
export type ComposerSituation = {
  readonly agent: string;
  /** A turn runs now. */
  readonly running: boolean;
  /** `Interrupt and send` shows (`showsInterrupt`). */
  readonly interrupt: boolean;
  /** The agent takes a message mid-turn (`capabilities.steersMidTurn`, ADR 0036). */
  readonly steers: boolean;
  /** What the agent waits on from the driver: its question, its plan, or a reply to its last message. */
  readonly waits: "question" | "plan" | "reply" | null;
  /** A refine task: the message asks for changes to the draft. */
  readonly refine: boolean;
};

/** `Interrupt and send` shows only while a turn runs and the driver may interrupt it (`capabilities.interrupt`). */
export const showsInterrupt = (task: { readonly canSend: boolean; readonly running: boolean; readonly canInterrupt: boolean }): boolean =>
  task.canSend && task.running && task.canInterrupt;

/** While nothing waits: what Send does to a running turn, or between turns. */
const sendHint = (situation: ComposerSituation): string => {
  const { agent } = situation;
  if (situation.steers) return situation.interrupt ? t("task.composer.hintSteersInterrupt", { agent }) : t("task.composer.hintSteers", { agent });
  return situation.interrupt ? t("task.composer.hint") : t("task.composer.hintQueues");
};

/**
 * The words of a box that sends or reopens (`composerMode`): `s1-working`'s `Message OpenCode…` and
 * `Send reaches OpenCode at its next step. Interrupt and send stops the turn first.`; `s1`'s
 * `Reply to OpenCode…` and `Send reaches OpenCode after your answer.`; `s5-plan`'s `Ask for changes
 * to the plan…`; `s2`'s idle box, `The box is idle. Send starts the next turn in it.`
 */
export const composerWordsOf = (mode: Extract<ComposerMode, { readonly kind: "send" | "reopen" }>, situation: ComposerSituation): ComposerWords => {
  const { agent } = situation;
  const message = t("task.composer.placeholderAgent", { agent });
  const draft = situation.refine ? t("draft.composerHint") : null;
  if (mode.kind === "reopen") {
    return mode.inBox
      ? { placeholder: message, hint: draft ?? mode.hint, send: t("task.composer.send") }
      : { placeholder: t("taskPage.composer.reopenPlaceholder"), hint: draft ?? mode.hint, send: t("taskPage.composer.reopen") };
  }
  const send = t("task.composer.send");
  switch (situation.waits) {
    case "question":
      return { placeholder: t("task.composer.replyPlaceholder", { agent }), hint: draft ?? t("task.composer.hintAfterAnswer", { agent }), send };
    case "plan":
      return { placeholder: t("task.composer.planPlaceholder"), hint: draft ?? t("task.composer.hintPlan", { agent }), send };
    case "reply":
      return { placeholder: t("task.composer.replyPlaceholder", { agent }), hint: draft ?? t("taskPage.needsYouCard.hint", { agent }), send };
    case null:
      return { placeholder: message, hint: draft ?? (situation.running ? sendHint(situation) : (mode.hint ?? sendHint(situation))), send };
    default:
      return situation.waits satisfies never;
  }
};
