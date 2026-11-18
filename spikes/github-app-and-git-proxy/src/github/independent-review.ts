import { verify } from '@octokit/webhooks-methods';
import { z } from 'zod';

// The `ostra/independent-review` check (ADR 0040, F-104): it passes when
// someone who didn't drive the task approves the PR's current head.

export const CHECK_NAME = 'ostra/independent-review';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export type ReviewLite = {
  readonly login: string;
  readonly isBot: boolean;
  readonly state: ReviewState;
  readonly commitId: string;
  readonly submittedAt: string;
};

export type IndependentReviewVerdict =
  | { readonly conclusion: 'success'; readonly approvers: readonly string[] }
  | { readonly conclusion: 'pending'; readonly reason: 'no-approval' | 'only-drivers-approved' | 'approval-is-stale' };

const DECIDING: ReadonlySet<ReviewState> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export const evaluateIndependentReview = (input: {
  readonly reviews: readonly ReviewLite[];
  readonly drivers: readonly string[];
  readonly headSha: string;
}): IndependentReviewVerdict => {
  const drivers = new Set(input.drivers.map((d) => d.toLowerCase()));
  // A comment doesn't change a reviewer's standing; an approval, a change
  // request or a dismissal does. The latest of those counts.
  const latest = new Map<string, ReviewLite>();
  for (const review of [...input.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (!DECIDING.has(review.state)) continue;
    latest.set(review.login.toLowerCase(), review);
  }
  const approvals = [...latest.values()].filter((r) => r.state === 'APPROVED');
  if (approvals.length === 0) return { conclusion: 'pending', reason: 'no-approval' };
  const independent = approvals.filter((r) => !r.isBot && !drivers.has(r.login.toLowerCase()));
  if (independent.length === 0) return { conclusion: 'pending', reason: 'only-drivers-approved' };
  const current = independent.filter((r) => r.commitId === input.headSha);
  if (current.length === 0) return { conclusion: 'pending', reason: 'approval-is-stale' };
  return { conclusion: 'success', approvers: current.map((r) => r.login) };
};

// The webhook that triggers a re-evaluation. A vendor format: unknown fields
// are tolerated, and only what the check needs is read.
export const PullRequestReviewEventSchema = z
  .object({
    action: z.string(),
    review: z.object({ state: z.string(), user: z.object({ login: z.string() }).loose() }).loose(),
    pull_request: z.object({ number: z.number().int(), head: z.object({ sha: z.string() }).loose() }).loose(),
    repository: z.object({ full_name: z.string() }).loose(),
  })
  .loose();
export type PullRequestReviewEvent = z.infer<typeof PullRequestReviewEventSchema>;

export type WebhookOutcome =
  | { readonly kind: 'rejected'; readonly status: 401 | 400 }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'review'; readonly event: PullRequestReviewEvent };

export const readWebhook = async (
  secret: string,
  headers: { readonly event: string | undefined; readonly signature: string | undefined },
  rawBody: string,
): Promise<WebhookOutcome> => {
  if (headers.signature === undefined || !(await verify(secret, rawBody, headers.signature))) return { kind: 'rejected', status: 401 };
  if (headers.event !== 'pull_request_review') return { kind: 'ignored' };
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: 'rejected', status: 400 };
  }
  const parsed = PullRequestReviewEventSchema.safeParse(json);
  if (!parsed.success) return { kind: 'rejected', status: 400 };
  return parsed.data.action === 'submitted' || parsed.data.action === 'dismissed' ? { kind: 'review', event: parsed.data } : { kind: 'ignored' };
};
