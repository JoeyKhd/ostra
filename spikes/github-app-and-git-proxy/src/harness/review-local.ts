import { sign } from '@octokit/webhooks-methods';
import { randomBytes } from 'node:crypto';
import { evaluateIndependentReview, readWebhook, type ReviewLite } from '../github/independent-review.ts';
import type { Check } from './git-scenarios.ts';

// The independent-review check's logic and its webhook verification, on
// made-up reviews and a locally signed payload. GitHub's side is the
// GitHub-target run.

export const runReviewLocal = async (): Promise<Check[]> => {
  const head = 'a'.repeat(40);
  const old = 'b'.repeat(40);
  const at = (m: number): string => new Date(Date.UTC(2026, 10, 18, 12, m)).toISOString();
  const r = (login: string, state: ReviewLite['state'], commitId: string, m: number, isBot = false): ReviewLite => ({
    login,
    isBot,
    state,
    commitId,
    submittedAt: at(m),
  });
  const drivers = ['driver'];
  const cases: { name: string; reviews: ReviewLite[]; want: 'success' | 'pending' }[] = [
    { name: 'no review: pending', reviews: [], want: 'pending' },
    { name: "the App's own comment review: pending", reviews: [r('ostra[bot]', 'COMMENTED', head, 1, true)], want: 'pending' },
    { name: 'the driver approves: pending', reviews: [r('driver', 'APPROVED', head, 1)], want: 'pending' },
    { name: 'someone else approves the head: success', reviews: [r('driver', 'APPROVED', head, 1), r('reviewer', 'APPROVED', head, 2)], want: 'success' },
    { name: 'an approval of an older commit: pending', reviews: [r('reviewer', 'APPROVED', old, 1)], want: 'pending' },
    { name: 'an approval later withdrawn by a change request: pending', reviews: [r('reviewer', 'APPROVED', head, 1), r('reviewer', 'CHANGES_REQUESTED', head, 2)], want: 'pending' },
    { name: 'an approval followed by a comment still counts: success', reviews: [r('reviewer', 'APPROVED', head, 1), r('reviewer', 'COMMENTED', head, 2)], want: 'success' },
    { name: 'the driver in other case: pending', reviews: [r('DRIVER', 'APPROVED', head, 1)], want: 'pending' },
  ];
  const checks: Check[] = cases.map((c) => {
    const got = evaluateIndependentReview({ reviews: c.reviews, drivers, headSha: head }).conclusion;
    return { name: c.name, ok: got === c.want, detail: got };
  });
  const secret = randomBytes(20).toString('hex');
  const body = JSON.stringify({
    action: 'submitted',
    review: { state: 'approved', user: { login: 'reviewer' } },
    pull_request: { number: 7, head: { sha: head } },
    repository: { full_name: 'ostra-sandbox/spike-repo' },
    installation: { id: 1 },
  });
  const good = await readWebhook(secret, { event: 'pull_request_review', signature: await sign(secret, body) }, body);
  checks.push({ name: 'a correctly signed pull_request_review webhook is read', ok: good.kind === 'review', detail: good.kind });
  const forged = await readWebhook(secret, { event: 'pull_request_review', signature: await sign('not-the-secret', body) }, body);
  checks.push({ name: 'a webhook with a bad signature is rejected', ok: forged.kind === 'rejected', detail: forged.kind });
  const unsigned = await readWebhook(secret, { event: 'pull_request_review', signature: undefined }, body);
  checks.push({ name: 'an unsigned webhook is rejected', ok: unsigned.kind === 'rejected', detail: unsigned.kind });
  return checks;
};
