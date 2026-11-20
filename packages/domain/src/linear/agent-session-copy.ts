import type { DbEnum } from "@ostra/db";

// What ostra posts in a Linear agent session (F-012, ADR 0057, Q216): ostra's own words, counts and
// links, one renderer per moment. Never agent output, a tool's input, a plan, a draft or check
// output: the input types have no field for any of it, and a ticket's or a person's text has none
// either (a Linear user may not be able to open a restricted project). Pure: each moment gives the
// activity's kind and its body, which the outbox (`AgentActivity`) sends with its idempotency key.

export type AgentActivityKind = DbEnum.AgentActivityKind;

/** Why a task needs someone, as the elicitation says it: ostra's words for the reason, never its text. */
export type NeedsYouWords =
  | "question"
  | "approval"
  | "plan"
  | "no-changes"
  | "stalled"
  | "spend-cap"
  | "crashed"
  | "setup-failed"
  | "round-cap"
  | "review"
  | "other";

/** A moment of the session. Every field is ostra's own: a URL, a count, a repo's name, a closed reason. */
export type AgentSessionMoment =
  | { readonly kind: "received"; readonly taskUrl: string }
  | { readonly kind: "waiting-for-approval"; readonly taskUrl: string }
  | { readonly kind: "approved"; readonly taskUrl: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "working"; readonly turn: number }
  | { readonly kind: "pr-opened"; readonly repo: string; readonly number: number; readonly url: string }
  | { readonly kind: "needs-you"; readonly reason: NeedsYouWords; readonly taskUrl: string }
  | { readonly kind: "stopped-in-linear" }
  | { readonly kind: "stopped-in-ostra"; readonly taskUrl: string }
  | { readonly kind: "done"; readonly pullRequests: number; readonly taskUrl: string }
  | { readonly kind: "failed"; readonly taskUrl: string }
  /** A follow-up from someone who isn't a member of the project: it reaches no agent. */
  | { readonly kind: "follow-up-not-member" }
  /** A follow-up from a member: sent to the agent after its running turn. */
  | { readonly kind: "follow-up-queued" }
  /** The ticket's team has no board with "Start from Linear" on. */
  | { readonly kind: "no-board" };

export type AgentActivityCopy = { readonly kind: AgentActivityKind; readonly body: string; readonly ephemeral: boolean };

const needsYouLine = (reason: NeedsYouWords): string => {
  switch (reason) {
    case "question":
      return "The agent has a question";
    case "approval":
      return "The agent asks before a step";
    case "plan":
      return "The agent's plan waits for approval";
    case "no-changes":
      return "The agent ended without changes";
    case "stalled":
      return "The agent stopped making progress";
    case "spend-cap":
      return "The task used its whole budget";
    case "crashed":
      return "The task stopped unexpectedly";
    case "setup-failed":
      return "The task's setup failed";
    case "round-cap":
      return "The task reached its limit of automatic rounds";
    case "review":
      return "The pull request waits for a reviewer";
    case "other":
      return "The task needs a member";
    default:
      return reason satisfies never;
  }
};

/** The activity ostra posts for a moment. */
export const agentSessionCopy = (moment: AgentSessionMoment): AgentActivityCopy => {
  switch (moment.kind) {
    case "received":
      return { kind: "thought", ephemeral: false, body: `ostra received this ticket and queued a task for it. Follow it in ostra: ${moment.taskUrl}` };
    case "waiting-for-approval":
      return {
        kind: "thought",
        ephemeral: false,
        body: `This task waits for a member of the project to approve it, because it was started from outside the project. Nothing runs until then: ${moment.taskUrl}`,
      };
    case "approved":
      return { kind: "thought", ephemeral: false, body: `A member approved the task. It's queued: ${moment.taskUrl}` };
    case "rejected":
      return { kind: "response", ephemeral: false, body: "A member of the project rejected this task, so nothing ran." };
    case "working":
      return { kind: "thought", ephemeral: false, body: moment.turn <= 1 ? "The agent started working on this ticket." : `The agent started turn ${String(moment.turn)}.` };
    case "pr-opened":
      return { kind: "action", ephemeral: false, body: `Opened ${moment.repo}#${String(moment.number)}: ${moment.url}` };
    case "needs-you":
      return { kind: "elicitation", ephemeral: false, body: `${needsYouLine(moment.reason)}. Answer it in ostra: ${moment.taskUrl}` };
    case "stopped-in-linear":
      return { kind: "response", ephemeral: false, body: "Stopped, as asked in Linear. The work so far is saved on the task's branch." };
    case "stopped-in-ostra":
      return { kind: "response", ephemeral: false, body: `A member stopped the task in ostra. The work so far is saved: ${moment.taskUrl}` };
    case "done":
      return {
        kind: "response",
        ephemeral: false,
        body:
          moment.pullRequests === 0
            ? `The task is done: ${moment.taskUrl}`
            : `The task is done, with ${String(moment.pullRequests)} pull request${moment.pullRequests === 1 ? "" : "s"}: ${moment.taskUrl}`,
      };
    case "failed":
      return { kind: "error", ephemeral: false, body: `The task failed. See what happened in ostra: ${moment.taskUrl}` };
    case "follow-up-not-member":
      return { kind: "thought", ephemeral: false, body: "Only members of the project can steer this task, so that message wasn't sent to the agent." };
    case "follow-up-queued":
      return { kind: "thought", ephemeral: false, body: "Your message goes to the agent after its current turn." };
    case "no-board":
      return {
        kind: "error",
        ephemeral: false,
        body: "No project in ostra takes tickets from this team. A project admin turns on \"Start from Linear\" on one board for it.",
      };
    default:
      return moment satisfies never;
  }
};

/**
 * The heartbeat (ADR 0013, `OSTRA_LINEAR_HEARTBEAT_MINUTES`): a post that keeps a long session from
 * looking stale. `ephemeral` by default (`OSTRA_LINEAR_HEARTBEAT_KIND`), so it replaces itself.
 */
export const heartbeatCopy = (kind: "ephemeral" | "thought"): AgentActivityCopy => ({
  kind: "thought",
  ephemeral: kind === "ephemeral",
  body: "Still working on it.",
});
