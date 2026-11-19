import type { Db } from "@ostra/db";
import { acceptPrCommentWith, ostraMentionText } from "@ostra/domain";
import type { M3Deps, SessionTimers, SpendCapSettings } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import { repoIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import type { WebhookDeliveryContext, WebhookOutcome } from "../webhooks/process.ts";
import type { PrCommentEvent } from "./pull-requests.ts";

// `@ostra` on a task's PR (F-053, ticket 25). The App's `issue_comment` and
// `pull_request_review_comment` webhooks reach `webhook.process` through milestone 2's inbox; a
// comment created or edited that asks `@ostra` becomes a `github.comment` job keyed by the comment's
// ID, so a replayed delivery or a later edit is one job. The job reads the comment from its newest
// stored delivery and hands it to the domain's `acceptPrComment`. Logs carry IDs and reasons,
// never a comment's text. A comment from anyone ostra can't match is dropped with no reply.

export type PrCommentDeps = M3Deps & {
  readonly timers?: SessionTimers;
  readonly spendCap?: SpendCapSettings;
};

const ACTIONS: ReadonlySet<string> = new Set(["created", "edited"]);

/**
 * An edit made by someone other than the comment's author. On GitHub anyone with write access can
 * edit another's comment, so such a comment's text isn't the member's: it is never heard as them
 * (F-053, F-119).
 */
const editedByAnother = (event: PrCommentEvent): boolean => event.action === "edited" && event.senderId !== event.comment.authorId;

/** `githubWebhookHandler`'s comment hook: an `@ostra` comment on a PR is queued as its `github.comment`. */
export const prCommentHook =
  (deps: Pick<M3Deps, "db" | "jobs">) =>
  async (context: WebhookDeliveryContext, event: PrCommentEvent): Promise<WebhookOutcome> => {
    if (!ACTIONS.has(event.action)) {
      return { outcome: "ignored", reason: `a comment ${event.action.slice(0, 32)}` };
    }
    if (editedByAnother(event)) {
      return { outcome: "ignored", reason: "a comment edited by someone other than its author" };
    }
    if (event.kind === "issue_comment" && !event.onPullRequest) {
      return { outcome: "ignored", reason: "a comment on an issue, not a PR" };
    }
    if (ostraMentionText(event.comment.body) === null) {
      return { outcome: "ignored", reason: "no @ostra" };
    }
    if (!/^[0-9]+$/.test(event.comment.commentId)) {
      return { outcome: "ignored", reason: "the comment's ID couldn't be read" };
    }
    await deps.db.$transaction((tx) =>
      deps.jobs.enqueueInTx(tx, "github.comment", { organizationId: context.organizationId, connectionId: context.connectionId, commentId: event.comment.commentId }),
    );
    context.logger.info("pr.comment-queued", { event: event.kind, number: event.number, commentId: event.comment.commentId });
    return { outcome: "processed" };
  };

/**
 * The newest stored delivery of a comment on the connection, read by the code host's adapter. A
 * delivery that is another account's edit is passed over: the job may run after one has arrived.
 */
const commentFromInbox = async (
  db: Db,
  deps: Pick<M3Deps, "adapters">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly commentId: string },
): Promise<{ readonly event: PrCommentEvent; readonly deliveryId: string } | null> => {
  const rows = await db.webhookDelivery.findMany({
    where: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      event: { in: ["issue_comment", "pull_request_review_comment"] },
      payload: { path: ["comment", "id"], equals: Number(input.commentId) },
    },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: { deliveryId: true, event: true, payload: true },
  });
  for (const row of rows) {
    const parsed = deps.adapters.codeHost.parseWebhook({ headers: { "x-github-event": row.event }, body: JSON.stringify(row.payload), secret: "" });
    if (!parsed.ok || (parsed.value.kind !== "issue_comment" && parsed.value.kind !== "pull_request_review_comment") || editedByAnother(parsed.value)) {
      continue;
    }
    return { event: parsed.value, deliveryId: row.deliveryId };
  }
  return null;
};

/** `github.comment`: the comment's newest delivery, matched to a task and a linked member, or dropped by IDs. */
export const githubCommentHandler =
  (deps: PrCommentDeps): JobHandler<"github.comment"> =>
  async (context) => {
    const { organizationId, connectionId, commentId } = context.payload;
    const found = await commentFromInbox(deps.db, deps, { organizationId, connectionId, commentId });
    if (found === null) {
      context.logger.warn("pr.comment-missing", { connectionId, commentId });
      return;
    }
    const { event, deliveryId } = found;
    const text = ostraMentionText(event.comment.body);
    const repo = await deps.db.repo.findFirst({ where: { organizationId, connectionId, hostRepoId: event.hostRepoId }, select: { id: true } });
    if (text === null || repo === null) {
      context.logger.info("pr.comment-dropped", { deliveryId, commentId, taskId: null, reason: text === null ? "no-mention" : "no-task" });
      return;
    }
    const result = await acceptPrCommentWith(
      deps,
      { timers: deps.timers, spendCap: deps.spendCap, logger: context.logger },
      {
        repoId: repoIdSchema.parse(repo.id),
        prNumber: event.number,
        commentId,
        commenterGithubUserId: event.comment.authorId,
        commenterLogin: event.comment.authorLogin,
        text,
        url: event.comment.url,
        path: event.kind === "pull_request_review_comment" ? event.path : null,
        line: event.kind === "pull_request_review_comment" ? event.line : null,
        kind: event.kind === "pull_request_review_comment" ? "review" : "issue",
      },
    );
    if (result.ok) {
      context.logger.info("pr.comment-accepted", { deliveryId, commentId, taskId: result.taskId, delivery: result.delivery });
      return;
    }
    if (result.error === "not-reopenable") {
      // The task is reopened and waits for its runner: there's no session to queue for yet, and
      // nothing to reopen. The job runs again, with its backoff, until the session goes; then the
      // comment is a queued steer like any other. It's never dropped.
      context.logger.info("pr.comment-waits", { deliveryId, commentId });
      throw new Error("the task is starting: the comment waits for its session");
    }
    const reason = result.error === "not-a-member" ? "unlinked" : result.error;
    context.logger.info("pr.comment-dropped", { deliveryId, commentId, reason });
  };
