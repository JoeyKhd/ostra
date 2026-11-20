import { describe, expect, it } from "vitest";

import {
  budgetIdSchema,
  diffCommentIdSchema,
  gitShaSchema,
  memberIdSchema,
  modelIdSchema,
  noteIdSchema,
  organizationIdSchema,
  projectIdSchema,
  repoFullNameSchema,
  repoIdSchema,
  taskIdSchema,
  taskSpecMemorySchema,
  userIdSchema,
} from "@ostra/protocol";
import type { MemberId, NoteId, TurnOrigin } from "@ostra/protocol";

import { canArchiveNote, canReadAudit, canWriteNote, requireInstanceAdmin, scopeForMembership } from "./access.ts";
import type { MemberScope, NoteAccessInfo, ProjectAccessInfo } from "./access.ts";
import { budgetGate, budgetLevel, budgetMonthBounds, budgetMonthOf, budgetNoticesDue, budgetOvershoot, turnOrigins } from "./budget/gate.ts";
import type { GateBudgets } from "./budget/gate.ts";
import { median, medianTimeToFirstPr, mergeRate, prsClosedUnmerged, prsMerged, prsOpened, timeWaiting, tokensAndSpend } from "./insights/figures.ts";
import type { InsightPullRequest } from "./insights/figures.ts";
import { jobKey, jobNames, jobPayloadSchemas, jobSending, reviewEvaluateSingletonSeconds } from "./jobs.ts";
import {
  membershipMakesScope,
  membershipOnAccept,
  proposalReachesAgents,
  transitionBudgetMonth,
  transitionInvitation,
  transitionMembership,
  transitionProposal,
  transitionReviewCheck,
} from "./lifecycles/m4.ts";
import type { InvitationLifecycle, MembershipLifecycle, ProposalLifecycle, ReviewCheckLifecycle } from "./lifecycles/m4.ts";
import {
  renderBudgetReachedMail,
  renderBudgetWarningMail,
  renderInvitationMail,
  renderPasswordResetMail,
  renderVerificationMail,
} from "./mail/account-mails.ts";
import { buildMemoryIndex, checkNoteVersion, foldMemoryIntoInstructions, renderMemoryBlock } from "./memory/block.ts";
import type { BlockNote } from "./memory/block.ts";
import { rememberThis } from "./memory/remember-this.ts";
import { credentialShapes, MODEL_CONTROL_TOKEN_KIND, modelControlTokens, ORGANIZATION_SECRET_KIND, scanMemoryText, secretScanMessage } from "./memory/secret-scan.ts";
import { canAddProjectRepo, checkoutDirFor, RELATED_END, RELATED_START, renderReposForAgent, repoInUse, withRelatedSection } from "./repos/several-repos.ts";
import { evaluateIndependentReview, pendingReasonWords } from "./review/independent-review.ts";
import type { ReviewLite } from "./review/independent-review.ts";

// Milestone 4's domain (ticket 06, spec section 5.4): the pure pieces every core and api ticket
// builds on, each with its cases.

const member = (id: string): MemberId => memberIdSchema.parse(id);
const note = (id: string): NoteId => noteIdSchema.parse(id);
const organizationId = organizationIdSchema.parse("org-a");
const projectId = projectIdSchema.parse("project-a");
const budgetId = budgetIdSchema.parse("budget-project");
const orgBudgetId = budgetIdSchema.parse("budget-organization");
const head = gitShaSchema.parse("a".repeat(40));
const oldHead = gitShaSchema.parse("b".repeat(40));

// ---------- lifecycles ----------

describe("the membership", () => {
  const remove = { type: "remove", at: 5, byMemberId: member("admin") } as const;

  it("F-002: starts pending with email on and active without it; only an active one makes a scope", () => {
    expect(membershipOnAccept(true)).toEqual({ state: "pending_verification" });
    expect(membershipOnAccept(false)).toEqual({ state: "active" });
    expect(membershipMakesScope({ state: "active" })).toBe(true);
    expect(membershipMakesScope({ state: "pending_verification" })).toBe(false);
    expect(membershipMakesScope({ state: "removed", removedAt: 1, removedByMemberId: member("admin") })).toBe(false);
  });

  it("moves pending → active → removed, and pending → removed; nothing leaves removed", () => {
    const pending: MembershipLifecycle = { state: "pending_verification" };
    expect(transitionMembership(pending, { type: "verify" })).toEqual({ ok: true, state: { state: "active" } });
    expect(transitionMembership(pending, remove)).toEqual({ ok: true, state: { state: "removed", removedAt: 5, removedByMemberId: member("admin") } });
    expect(transitionMembership({ state: "active" }, remove).ok).toBe(true);
    expect(transitionMembership({ state: "active" }, { type: "verify" }).ok).toBe(false);
    const removed: MembershipLifecycle = { state: "removed", removedAt: 5, removedByMemberId: member("admin") };
    expect(transitionMembership(removed, { type: "verify" }).ok).toBe(false);
    expect(transitionMembership(removed, remove).ok).toBe(false);
  });
});

describe("the invitation", () => {
  const pending: InvitationLifecycle = { state: "pending", expiresAt: 100 };
  const accept = { type: "accept", at: 50, userId: userIdSchema.parse("user-1") } as const;

  it("F-002: works once, before its expiry, and not after a revoke", () => {
    expect(transitionInvitation(pending, accept)).toEqual({ ok: true, state: { state: "accepted", acceptedAt: 50, acceptedUserId: "user-1" } });
    // At or after the expiry, even before the sweep marked it.
    expect(transitionInvitation(pending, { ...accept, at: 100 }).ok).toBe(false);
    const accepted = transitionInvitation(pending, accept);
    expect(accepted.ok && transitionInvitation(accepted.state, accept).ok).toBe(false);
    const revoked = transitionInvitation(pending, { type: "revoke", at: 10, byMemberId: member("admin") });
    expect(revoked.ok && revoked.state.state).toBe("revoked");
    expect(revoked.ok && transitionInvitation(revoked.state, accept).ok).toBe(false);
  });

  it("expires by the sweep only at its time, and every end is final", () => {
    expect(transitionInvitation(pending, { type: "expire", at: 99 }).ok).toBe(false);
    expect(transitionInvitation(pending, { type: "expire", at: 100 })).toEqual({ ok: true, state: { state: "expired" } });
    for (const end of [{ state: "expired" }, { state: "revoked", revokedAt: 1, revokedByMemberId: member("a") }] as const satisfies readonly InvitationLifecycle[]) {
      expect(transitionInvitation(end, accept).ok).toBe(false);
      expect(transitionInvitation(end, { type: "expire", at: 1000 }).ok).toBe(false);
      expect(transitionInvitation(end, { type: "revoke", at: 1, byMemberId: member("a") }).ok).toBe(false);
    }
  });
});

describe("the proposal", () => {
  const proposed: ProposalLifecycle = { state: "proposed" };
  const by = member("reviewer");

  it("F-111: reaches no agent until approved or merged; approve, approve and archive, merge and reject are final", () => {
    expect(proposalReachesAgents(proposed)).toBe(false);
    const approved = transitionProposal(proposed, { type: "approve", noteId: note("n-new"), byMemberId: by });
    expect(approved).toEqual({ ok: true, state: { state: "approved", noteId: "n-new", archivedNoteId: null, decidedBy: by } });
    const archived = transitionProposal(proposed, { type: "approve_and_archive", noteId: note("n-new"), archivedNoteId: note("n-old"), byMemberId: by });
    expect(archived.ok && archived.state).toEqual({ state: "approved", noteId: "n-new", archivedNoteId: "n-old", decidedBy: by });
    // Archiving the note it becomes is refused.
    expect(transitionProposal(proposed, { type: "approve_and_archive", noteId: note("n"), archivedNoteId: note("n"), byMemberId: by }).ok).toBe(false);
    const merged = transitionProposal(proposed, { type: "merge", intoNoteId: note("n-old"), byMemberId: by });
    const rejected = transitionProposal(proposed, { type: "reject", byMemberId: by });
    for (const result of [approved, archived, merged, rejected]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(transitionProposal(result.state, { type: "reject", byMemberId: by }).ok).toBe(false);
        expect(transitionProposal(result.state, { type: "approve", noteId: note("x"), byMemberId: by }).ok).toBe(false);
      }
    }
    expect(approved.ok && proposalReachesAgents(approved.state)).toBe(true);
    expect(merged.ok && proposalReachesAgents(merged.state)).toBe(true);
    expect(rejected.ok && proposalReachesAgents(rejected.state)).toBe(false);
  });
});

describe("a budget's month", () => {
  it("F-037: only moves up within a month, starts again in a new one, and a raise moves it down", () => {
    const under = { state: "under", month: "2026-11" } as const;
    const warned = transitionBudgetMonth(under, { type: "measure", month: "2026-11", level: "warn" });
    expect(warned).toEqual({ ok: true, state: { state: "warned", month: "2026-11" } });
    // A second warn is refused: the notice was sent once.
    expect(warned.ok && transitionBudgetMonth(warned.state, { type: "measure", month: "2026-11", level: "warn" }).ok).toBe(false);
    const reached = warned.ok ? transitionBudgetMonth(warned.state, { type: "measure", month: "2026-11", level: "reached" }) : warned;
    expect(reached.ok && reached.state.state).toBe("reached");
    expect(reached.ok && transitionBudgetMonth(reached.state, { type: "measure", month: "2026-11", level: "warn" }).ok).toBe(false);
    // A new month starts at its own level.
    expect(reached.ok && transitionBudgetMonth(reached.state, { type: "measure", month: "2026-12", level: "under" })).toEqual({ ok: true, state: { state: "under", month: "2026-12" } });
    // A raise moves down to what the new amount gives.
    expect(reached.ok && transitionBudgetMonth(reached.state, { type: "raise", level: "under" })).toEqual({ ok: true, state: { state: "under", month: "2026-11" } });
  });
});

describe("the review check", () => {
  const pending: ReviewCheckLifecycle = { state: "pending", headSha: head, reason: "x" };

  it("F-104/c6: moves both ways per head, a new head is pending again, and an old head's evaluation is refused", () => {
    const passed = transitionReviewCheck(pending, { type: "evaluated", headSha: head, verdict: { passed: true, approverMemberId: member("r") } });
    expect(passed).toEqual({ ok: true, state: { state: "passed", headSha: head, approverMemberId: member("r") } });
    const back = passed.ok ? transitionReviewCheck(passed.state, { type: "evaluated", headSha: head, verdict: { passed: false, reason: "changes requested" } }) : passed;
    expect(back.ok && back.state).toEqual({ state: "pending", headSha: head, reason: "changes requested" });
    const pushed = passed.ok ? transitionReviewCheck(passed.state, { type: "new_head", headSha: oldHead }) : passed;
    expect(pushed.ok && pushed.state.state).toBe("pending");
    expect(pushed.ok && pushed.state.headSha).toBe(oldHead);
    expect(transitionReviewCheck(pending, { type: "new_head", headSha: head }).ok).toBe(false);
    expect(transitionReviewCheck(pending, { type: "evaluated", headSha: oldHead, verdict: { passed: true, approverMemberId: member("r") } }).ok).toBe(false);
  });
});

// ---------- access ----------

describe("milestone 4's access", () => {
  const open: ProjectAccessInfo = { id: projectId, organizationId, access: "open" };
  const restricted: ProjectAccessInfo = { id: projectIdSchema.parse("project-r"), organizationId, access: "restricted" };
  const scopeOf = (role: "admin" | "member", projectRoles: ReadonlyMap<ProjectAccessInfo["id"], "admin" | "member"> = new Map()): MemberScope => ({
    organizationId,
    memberId: member(`${role}-1`),
    role,
    projectRoles,
  });
  const memberScope = scopeOf("member");
  const adminScope = scopeOf("admin");

  it("F-003: a removed or pending membership makes no scope", () => {
    const base = { organizationId, memberId: member("m"), role: "member" } as const;
    expect(scopeForMembership({ ...base, state: "active" }, new Map())).toMatchObject({ memberId: "m" });
    expect(scopeForMembership({ ...base, state: "removed" }, new Map())).toBeNull();
    expect(scopeForMembership({ ...base, state: "pending_verification" }, new Map())).toBeNull();
  });

  it("only an instance admin passes requireInstanceAdmin", () => {
    expect(requireInstanceAdmin({ userId: userIdSchema.parse("u"), instanceAdmin: true }).ok).toBe(true);
    expect(requireInstanceAdmin({ userId: userIdSchema.parse("u"), instanceAdmin: false })).toEqual({ ok: false, code: "forbidden" });
  });

  it("F-109: members write what they can open; archiving another's note needs an admin of its scope", () => {
    const projectNote = (project: ProjectAccessInfo, author: MemberId | null): NoteAccessInfo => ({ organizationId, project, authorMemberId: author });
    const orgNote = (author: MemberId | null): NoteAccessInfo => ({ organizationId, project: null, authorMemberId: author });
    expect(canWriteNote(memberScope, projectNote(open, null))).toBe(true);
    expect(canWriteNote(memberScope, orgNote(null))).toBe(true);
    expect(canWriteNote(memberScope, projectNote(restricted, null))).toBe(false);
    expect(canWriteNote({ ...memberScope, organizationId: organizationIdSchema.parse("org-b") }, orgNote(null))).toBe(false);
    // Their own note, yes; another's, no; an admin, yes.
    expect(canArchiveNote(memberScope, projectNote(open, memberScope.memberId))).toBe(true);
    expect(canArchiveNote(memberScope, projectNote(open, member("someone")))).toBe(false);
    expect(canArchiveNote(memberScope, orgNote(member("someone")))).toBe(false);
    expect(canArchiveNote(adminScope, orgNote(member("someone")))).toBe(true);
    const projectAdmin = scopeOf("member", new Map([[restricted.id, "admin"]]));
    expect(canArchiveNote(projectAdmin, projectNote(restricted, member("someone")))).toBe(true);
    expect(canArchiveNote(projectAdmin, orgNote(member("someone")))).toBe(false);
  });

  it("F-073: organization admins read the whole audit log, project admins their project's", () => {
    const projectAdmin = scopeOf("member", new Map([[restricted.id, "admin"]]));
    expect(canReadAudit(adminScope, organizationId, null)).toBe(true);
    expect(canReadAudit(adminScope, organizationIdSchema.parse("org-b"), null)).toBe(false);
    expect(canReadAudit(projectAdmin, organizationId, null)).toBe(false);
    expect(canReadAudit(projectAdmin, organizationId, restricted)).toBe(true);
    expect(canReadAudit(memberScope, organizationId, open)).toBe(false);
  });
});

// ---------- the budget gate ----------

describe("the budget gate", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  const month = budgetMonthOf(now);
  const budgets: GateBudgets = {
    organization: { budgetId: orgBudgetId, monthlyMicroUsd: 1_000_000_000n },
    project: { budgetId, monthlyMicroUsd: 100_000_000n },
  };
  const spendAt = (percent: number) => ({ month, organizationMicroUsd: 0n, projectMicroUsd: BigInt(percent) * 1_000_000n, modelPriced: true });

  it("does the month and threshold arithmetic in UTC", () => {
    expect(budgetMonthOf(Date.UTC(2026, 10, 30, 23, 59, 59, 999))).toBe("2026-11");
    expect(budgetMonthOf(Date.UTC(2026, 11, 1))).toBe("2026-12");
    expect(budgetMonthBounds("2026-12")).toEqual({ start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) });
    expect(budgetLevel(79n, 100n, 80)).toBe("under");
    expect(budgetLevel(80n, 100n, 80)).toBe("warn");
    expect(budgetLevel(99n, 100n, 80)).toBe("warn");
    expect(budgetLevel(100n, 100n, 80)).toBe("reached");
    expect(budgetLevel(0n, 0n, 80)).toBe("reached");
    expect(budgetOvershoot(112n, 100n)).toBe(12n);
    expect(budgetOvershoot(50n, 100n)).toBe(0n);
    expect(budgetNoticesDue("reached", new Set())).toEqual(["warn", "reached"]);
    expect(budgetNoticesDue("reached", new Set(["warn"]))).toEqual(["reached"]);
    expect(budgetNoticesDue("warn", new Set(["warn"]))).toEqual([]);
    expect(budgetNoticesDue("under", new Set())).toEqual([]);
  });

  it("has one closed list of origins", () => {
    expect([...turnOrigins]).toEqual(["dispatch", "reopen", "message", "diff-comments", "update-branch", "pr-comment", "keep-working", "closing-turn", "automatic-round", "changes-requested", "linear-follow-up"]);
  });

  it("F-037/c4: every origin is open at 79%, 80% and 99%, held at 100%, and open again across a month's end", () => {
    for (const origin of turnOrigins) {
      expectGate(origin);
    }
  });

  const expectGate = (origin: TurnOrigin): void => {
    for (const percent of [79, 80, 99]) {
      expect(budgetGate(budgets, spendAt(percent), origin, now)).toEqual({ kind: "open" });
    }
    expect(budgetGate(budgets, spendAt(100), origin, now)).toEqual({ kind: "held", budgetId, scope: "project", reason: "reached", origin });
    // Across the month's end the new month's spend starts at nothing.
    expect(budgetGate(budgets, spendAt(100), origin, Date.UTC(2026, 11, 1))).toEqual({ kind: "open" });
    // The organization's budget holds every project.
    const orgReached = { month, organizationMicroUsd: 1_000_000_000n, projectMicroUsd: 0n, modelPriced: true };
    expect(budgetGate(budgets, orgReached, origin, now)).toEqual({ kind: "held", budgetId: orgBudgetId, scope: "organization", reason: "reached", origin });
    // An unpriced model waits where a budget applies, and runs where none does.
    expect(budgetGate(budgets, { ...spendAt(0), modelPriced: false }, origin, now)).toMatchObject({ kind: "held", reason: "unpriced" });
    expect(budgetGate({ organization: null, project: null }, { ...spendAt(500), modelPriced: false }, origin, now)).toEqual({ kind: "open" });
  };
});

// ---------- Insights ----------

describe("Insights' six figures", () => {
  const day = (d: number, h = 0): number => Date.UTC(2026, 10, d, h);
  const period = { start: day(10), end: day(17) };
  const t1 = taskIdSchema.parse("t1");
  const t2 = taskIdSchema.parse("t2");
  const t3 = taskIdSchema.parse("t3");
  const r1 = repoIdSchema.parse("r1");
  const r2 = repoIdSchema.parse("r2");
  const prs: readonly InsightPullRequest[] = [
    // t1: two repos, both in the period; one merged, one closed unmerged.
    { taskId: t1, repoId: r1, openedAt: day(11), mergedAt: day(12), closedUnmergedAt: null },
    { taskId: t1, repoId: r2, openedAt: day(11, 6), mergedAt: null, closedUnmergedAt: day(13) },
    // t2: opened before the period, merged in it.
    { taskId: t2, repoId: r1, openedAt: day(8), mergedAt: day(14), closedUnmergedAt: null },
    // t3: opened in the period, both still open.
    { taskId: t3, repoId: r1, openedAt: day(15), mergedAt: null, closedUnmergedAt: null },
    { taskId: t3, repoId: r2, openedAt: day(16), mergedAt: null, closedUnmergedAt: null },
    // Outside the period entirely.
    { taskId: t2, repoId: r2, openedAt: day(20), mergedAt: day(21), closedUnmergedAt: null },
  ];

  it("F-108/c1: counts PRs opened, merged and closed, and the merge rate, over a fixture", () => {
    expect(prsOpened(prs, period)).toBe(4);
    expect(prsMerged(prs, period)).toBe(2);
    expect(prsClosedUnmerged(prs, period)).toBe(1);
    expect(mergeRate(prs, period)).toBeCloseTo(2 / 3);
    expect(mergeRate(prs, { start: day(1), end: day(2) })).toBeNull();
  });

  it("F-108/c1: takes the median time to a first PR over code tasks whose first PR opened in the period", () => {
    const tasks = [
      { taskId: t1, kind: "code", createdAt: day(10) },
      { taskId: t2, kind: "code", createdAt: day(7) },
      { taskId: t3, kind: "code", createdAt: day(14) },
    ] as const;
    // t1: 1 day to its first PR; t3: 1 day; t2's first PR is before the period.
    expect(medianTimeToFirstPr(tasks, prs, period)).toEqual({ medianMs: 86_400_000, count: 2 });
    expect(medianTimeToFirstPr([{ taskId: t1, kind: "refine", createdAt: day(10) }], prs, period)).toEqual({ medianMs: null, count: 0 });
    expect(median([1, 5, 2, 8])).toBe(3);
    expect(median([])).toBeNull();
  });

  it("F-108/c1: totals the time waiting on people, with the median per item and per reason", () => {
    const hour = 3_600_000;
    const figure = timeWaiting(
      [
        { reason: "approval", createdAt: day(11), endedAt: day(11) + hour },
        { reason: "approval", createdAt: day(12), endedAt: day(12) + 3 * hour },
        { reason: "question", createdAt: day(12), endedAt: day(12) + 2 * hour },
        // Still open, and ended outside the period: neither counts.
        { reason: "question", createdAt: day(12), endedAt: null },
        { reason: "plan", createdAt: day(1), endedAt: day(2) },
      ],
      period,
    );
    expect(figure).toMatchObject({ totalMs: 6 * hour, medianMs: 2 * hour, count: 3 });
    expect(figure.byReason.get("approval")).toEqual({ totalMs: 4 * hour, medianMs: 2 * hour, count: 2 });
    expect(figure.byReason.get("question")).toEqual({ totalMs: 2 * hour, medianMs: 2 * hour, count: 1 });
    expect(figure.byReason.has("plan")).toBe(false);
  });

  it("F-108/c1: sums tokens and spend from SpendDaily, by project and by model", () => {
    const m1 = modelIdSchema.parse("m1");
    const m2 = modelIdSchema.parse("m2");
    const p2 = projectIdSchema.parse("p2");
    const row = (p: typeof projectId, m: typeof m1, d: number, spent: bigint) => ({
      projectId: p,
      modelId: m,
      day: day(d),
      inputTokens: 10n,
      outputTokens: 5n,
      cacheReadTokens: 2n,
      cacheWriteTokens: 1n,
      spentMicroUsd: spent,
    });
    const result = tokensAndSpend([row(projectId, m1, 11, 100n), row(projectId, m2, 12, 50n), row(p2, m1, 13, 25n), row(p2, m1, 20, 999n)], period);
    expect(result.total).toEqual({ inputTokens: 30n, outputTokens: 15n, cacheReadTokens: 6n, cacheWriteTokens: 3n, spentMicroUsd: 175n });
    expect(result.byProject.get(projectId)?.spentMicroUsd).toBe(150n);
    expect(result.byProject.get(p2)?.spentMicroUsd).toBe(25n);
    expect(result.byModel.get(m1)?.spentMicroUsd).toBe(125n);
    expect(result.byModel.get(m2)?.inputTokens).toBe(10n);
  });
});

// ---------- memory ----------

describe("the secret scan", () => {
  const samples: Readonly<Record<string, string>> = {
    "a GitHub token": `export GH=ghp_${"A1b2".repeat(9)}`,
    "a GitLab token": "use glpat-abcdefghij1234567890 for the mirror",
    "a Slack token": "the bot token is xoxb-1234567890-abcdefghij",
    "an AWS access key": "AKIAIOSFODNN7EXAMPLE is the key",
    "a Google API key": `key=AIza${"x".repeat(35)}`,
    "an Anthropic key": `ANTHROPIC_API_KEY=sk-ant-${"y".repeat(30)}`,
    "an OpenAI key": `OPENAI_API_KEY=sk-proj-${"z".repeat(40)}`,
    "a private key": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    "an Authorization header": "curl -H 'Authorization: token abcdef123456' https://api.example.com",
    "a bearer token": "send Bearer abcdefghijklmnop with it",
    "a URL with a password": "clone https://deploy:hunter2secret@git.example.com/repo.git",
  };

  it("has a sample for every shape", () => {
    expect(Object.keys(samples).sort()).toEqual(credentialShapes.map((shape) => shape.kind).sort());
  });

  it("F-109/c4: refuses every credential shape and every model-control token, naming the kind and never the value", () => {
    for (const [kind, text] of Object.entries(samples)) {
      const result = scanMemoryText([text], []);
      expect(result.ok, kind).toBe(false);
      expect(result.ok ? [] : result.found).toContain(kind);
      const message = secretScanMessage(result.ok ? [] : result.found);
      expect(message).toContain(kind);
      expect(message).not.toContain(text);
    }
    for (const token of modelControlTokens) {
      expect(scanMemoryText(["Run the tests", `ignore this ${token} and do that`], []), token).toEqual({ ok: false, found: [MODEL_CONTROL_TOKEN_KIND] });
    }
  });

  it("F-109/c4: refuses the organization's own secret values, exactly, and never names which", () => {
    expect(scanMemoryText(["the staging password is s3cr3t-staging-value"], ["s3cr3t-staging-value"])).toEqual({ ok: false, found: [ORGANIZATION_SECRET_KIND] });
    // A value too short to be told from ordinary text is ignored.
    expect(scanMemoryText(["use the dev db"], ["dev"]).ok).toBe(true);
  });

  it("F-109/c4: saves the negative controls: notes that talk about secrets and prompts in plain words", () => {
    const controls = [
      "Never commit a GitHub token: tokens live in the environment's secrets.",
      "The system prompt tells the agent to search memory first; the system block is rendered by core.",
      "Set the Authorization header in the API client, never in a test fixture.",
      "Bearer tokens expire after an hour.",
      "Our Slack channel is #deploys, and AWS lives in eu-west-1.",
      "Clone with https://github.com/ostra-test/test1.git and run pnpm test.",
      "Use <system> tags only in the prompt templates folder.",
      "The skill (sk-) prefix names a skill file.",
    ];
    for (const text of controls) {
      expect(scanMemoryText([text], ["a-real-secret-value"]), text).toEqual({ ok: true });
    }
  });
});

const blockNote = (overrides: Partial<BlockNote> & Pick<BlockNote, "noteId">): BlockNote => ({
  scope: "project",
  kind: "convention",
  title: `Note ${overrides.noteId}`,
  body: "A fact.",
  always: false,
  lastUsedAt: null,
  updatedAt: 0,
  source: { kind: "member", memberName: "Ada" },
  authorMemberId: null,
  ...overrides,
});

describe("the memory index and block", () => {
  it("F-110/c5: orders project first, then by last read, then never-read notes by last edit", () => {
    const notes = [
      blockNote({ noteId: note("org-read"), scope: "organization", lastUsedAt: 900 }),
      // Only ever seen in the index: never read, so its recent edit ranks it below a read note.
      blockNote({ noteId: note("index-only"), lastUsedAt: null, updatedAt: 1_000 }),
      blockNote({ noteId: note("read-old"), lastUsedAt: 100, updatedAt: 1 }),
      blockNote({ noteId: note("read-new"), lastUsedAt: 500, updatedAt: 1 }),
      blockNote({ noteId: note("never-old"), lastUsedAt: null, updatedAt: 10 }),
    ];
    const built = buildMemoryIndex(notes);
    expect(built.index.map((entry) => entry.noteId)).toEqual(["read-new", "read-old", "index-only", "never-old", "org-read"]);
    expect(built.omitted).toBe(0);
  });

  it("F-110/c5: cuts the index at its count and size, counting what's left out, and keeps \"always\" notes within theirs", () => {
    const many = Array.from({ length: 12 }, (_, i) => blockNote({ noteId: note(`n-${String(i).padStart(2, "0")}`), updatedAt: 100 - i }));
    const byCount = buildMemoryIndex(many, { indexMaxNotes: 10, indexMaxBytes: 8192, alwaysMaxBytes: 8192 });
    expect(byCount.index).toHaveLength(10);
    expect(byCount.omitted).toBe(2);
    const bySize = buildMemoryIndex(many, { indexMaxNotes: 100, indexMaxBytes: 200, alwaysMaxBytes: 8192 });
    expect(bySize.index.length).toBeLessThan(12);
    expect(bySize.omitted).toBe(12 - bySize.index.length);
    const big = "x".repeat(3000);
    const always = [1, 2, 3].map((i) => blockNote({ noteId: note(`always-${String(i)}`), always: true, body: big, updatedAt: 10 - i }));
    const built = buildMemoryIndex(always);
    // Two 3 KB notes fit in 8 KiB; the third goes to the index.
    expect(built.always.map((entry) => entry.noteId)).toEqual(["always-1", "always-2"]);
    expect(built.index.map((entry) => entry.noteId)).toEqual(["always-3"]);
  });

  it("F-110/c6: renders the block as the approved notes, each with its source, and the standing instruction", () => {
    const built = buildMemoryIndex(
      [
        blockNote({ noteId: note("a1"), always: true, title: "Say client, not customer", body: "Always say client.", kind: "term", scope: "organization", source: { kind: "member", memberName: "Ada" } }),
        blockNote({ noteId: note("i1"), title: "Tests run with pnpm test", kind: "command", source: { kind: "task", taskId: taskIdSchema.parse("t9"), taskTitle: "Fix the CI" } }),
        blockNote({ noteId: note("i2"), title: "Migrations add first", kind: "decision", source: { kind: "proposal", approvedBy: "Grace" } }),
      ],
      { indexMaxNotes: 1, indexMaxBytes: 8192, alwaysMaxBytes: 8192 },
    );
    const memory = renderMemoryBlock(built, true);
    expect(taskSpecMemorySchema.parse(memory)).toEqual(memory);
    expect(memory.block).toContain("the organization's and the project's approved notes");
    expect(memory.block).toContain("Say client, not customer");
    expect(memory.block).toContain("Always say client.");
    expect(memory.block).toContain("written by Ada");
    expect(memory.block).toContain("Tests run with pnpm test");
    // Each note carries its source, in the index as in the always notes (ADR 0044, Q91 change 5).
    expect(memory.block).toContain("- [command] Tests run with pnpm test (id: i1, project, from task \"Fix the CI\")");
    expect(memory.block).not.toContain("Migrations add first");
    expect(memory.block).toContain("1 more notes: search with `memory_search`");
    expect(memory.block).toContain("memory_search");
    expect(memory.block).toContain('relation: "contradicts"');
    expect(memory).toMatchObject({ alwaysNoteIds: ["a1"], indexNoteIds: ["i1"], omitted: 1, tools: true });
    // The index carries no body, and names each note's ID.
    const indexOnly = renderMemoryBlock(buildMemoryIndex([blockNote({ noteId: note("i3"), body: "SECRET-BODY-TEXT", source: { kind: "diff_comment", memberName: "Lin" } })]), true);
    expect(indexOnly.block).not.toContain("SECRET-BODY-TEXT");
    expect(indexOnly.block).toContain("id: i3");
    // An index-only agent is told it has no tools.
    const noTools = renderMemoryBlock(built, false);
    expect(noTools.block).not.toContain("memory_search");
    expect(foldMemoryIntoInstructions("Be brief.", noTools)).toBe(`Be brief.\n\n${noTools.block}`);
    expect(foldMemoryIntoInstructions(null, noTools)).toBe(noTools.block);
  });

  it("F-109/c5: refuses a stale expected version, saying who saved and which version", () => {
    expect(checkNoteVersion({ version: 3, lastEditedBy: member("grace") }, 3)).toEqual({ ok: true, nextVersion: 4 });
    expect(checkNoteVersion({ version: 4, lastEditedBy: member("grace") }, 3)).toEqual({ ok: false, code: "conflict", currentVersion: 4, savedBy: "grace" });
  });

  it("F-111: \"Remember this\" starts a project proposal from a diff comment or a PR comment", () => {
    const fromDiff = rememberThis({
      source: { kind: "diff_comment", commentId: diffCommentIdSchema.parse("dc-1"), path: "src/a.ts", line: 4, body: "## Use the logger\n\nNever console.log in core." },
      projectId,
      taskId: taskIdSchema.parse("t1"),
      memberId: member("ada"),
    });
    expect(fromDiff).toMatchObject({ title: "Use the logger", scope: "project", kind: "convention", sourceKind: "diff_comment", sourceRef: "dc-1" });
    const fromPr = rememberThis({
      source: { kind: "pr_comment", url: "https://github.com/ostra-test/test1/pull/1#issuecomment-1", body: "x".repeat(300) },
      projectId,
      taskId: taskIdSchema.parse("t1"),
      memberId: member("ada"),
    });
    expect("title" in fromPr && fromPr.title.length).toBe(120);
    expect(rememberThis({ source: { kind: "pr_comment", url: "https://x", body: "   " }, projectId, taskId: taskIdSchema.parse("t1"), memberId: member("ada") })).toEqual({ error: "empty" });
  });
});

// ---------- several repos ----------

describe("several repos", () => {
  const name = (fullName: string) => repoFullNameSchema.parse(fullName);

  it("F-098: holds a project to its repo limit, and keeps a repo in use while a task that names it runs", () => {
    expect(canAddProjectRepo(9)).toBe(true);
    expect(canAddProjectRepo(10)).toBe(false);
    expect(canAddProjectRepo(2, 2)).toBe(false);
    const t = (id: string, state: "running" | "merged" | "stopped" | "in_review" | "queued") => ({ taskId: taskIdSchema.parse(id), state });
    expect(repoInUse([t("a", "merged"), t("b", "stopped")])).toEqual([]);
    expect(repoInUse([t("a", "merged"), t("b", "in_review"), t("c", "queued")])).toEqual(["b", "c"]);
  });

  it("F-098: names a repo's folder from its name, unique in the project", () => {
    expect(checkoutDirFor(name("ostra-test/test1"), new Set())).toBe("test1");
    expect(checkoutDirFor(name("client-org/api"), new Set(["api"]))).toBe("api-2");
    expect(checkoutDirFor(name("client-org/API"), new Set(["api", "api-2"]))).toBe("API-3");
  });

  it("F-066: names the branch of a repo that has one of its own, and no other", () => {
    const repos = [
      { fullName: name("ostra-test/test1"), checkoutDir: "test1", defaultBranch: "main", branchName: "ostra/x-2" },
      { fullName: name("client-org/api"), checkoutDir: "api", defaultBranch: "develop", branchName: "ostra/x" },
    ];
    const text = renderReposForAgent(repos, "ostra/x") ?? "";
    expect(text).toContain("`test1/`: ostra-test/test1 (base: main, branch: `ostra/x-2`)");
    expect(text).toContain("`api/`: client-org/api (base: develop)");
    expect(text).not.toContain("branch: `ostra/x`)");
  });

  it("F-098: lists the repos for the agent, and sets each PR's Related section idempotently", () => {
    const repos = [
      { fullName: name("ostra-test/test1"), checkoutDir: "test1", defaultBranch: "main" },
      { fullName: name("client-org/api"), checkoutDir: "api", defaultBranch: "develop" },
    ];
    expect(renderReposForAgent(repos.slice(0, 1), "ostra/x")).toBeNull();
    const text = renderReposForAgent(repos, "ostra/x") ?? "";
    expect(text).toContain("`test1/`: ostra-test/test1");
    expect(text).toContain("`api/`: client-org/api (base: develop)");
    const related = [{ repoId: repoIdSchema.parse("r2"), prNumber: 3, fullName: name("client-org/api"), url: "https://github.com/client-org/api/pull/3" }];
    const once = withRelatedSection("Adds the date.", related);
    expect(once).toContain(RELATED_START);
    expect(once).toContain("client-org/api#3");
    expect(withRelatedSection(once, related)).toBe(once);
    expect(withRelatedSection(once, [])).toBe("Adds the date.");
    expect(once.split(RELATED_END)).toHaveLength(2);
  });
});

// ---------- the evaluator ----------

describe("the independent-review evaluator", () => {
  const drivers = new Set([member("driver")]);
  const links = new Map([
    ["100", member("reviewer")],
    ["200", member("driver")],
  ]);
  const review = (overrides: Partial<ReviewLite>): ReviewLite => ({
    userId: "100",
    login: "reviewer",
    isBot: false,
    state: "approved",
    commitId: head,
    submittedAt: 10,
    ...overrides,
  });
  const verdict = (reviews: readonly ReviewLite[]) => evaluateIndependentReview({ reviews, drivers, links, headSha: head });

  it("F-104/c4: passes on a linked non-driver's approval of the current head", () => {
    expect(verdict([review({})])).toEqual({ status: "passed", approverMemberId: "reviewer", approverLogin: "reviewer" });
    // A later comment doesn't change the standing.
    expect(verdict([review({}), review({ state: "commented", submittedAt: 20 })]).status).toBe("passed");
  });

  const pendingCases = [
    ["no review", [], "no-approval"],
    ["a stale approval", [review({ commitId: oldHead })], "approval-is-stale"],
    ["a dismissed approval", [review({}), review({ state: "dismissed", submittedAt: 20 })], "no-approval"],
    ["a bot's approval", [review({ userId: "300", login: "ci[bot]", isBot: true })], "only-bots-approved"],
    ["the driver's approval", [review({ userId: "200", login: "driver" })], "only-drivers-approved"],
    ["an unlinked approval", [review({ userId: "999", login: "stranger" })], "only-unlinked-approved"],
    ["changes requested after an approval", [review({}), review({ state: "changes_requested", submittedAt: 20 })], "changes-requested"],
  ] as const;

  it("F-104/c4: stays pending on a stale, dismissed, bot's, driver's or unlinked approval, and on changes requested after one", () => {
    for (const [name, reviews, reason] of pendingCases) {
      expect(verdict(reviews), name).toEqual({ status: "pending", reason });
      expect(pendingReasonWords(reason).length).toBeGreaterThan(0);
    }
  });
});

// ---------- mails ----------

describe("milestone 4's mails", () => {
  const publicUrl = "https://ostra.example.com";
  const link = "https://ostra.example.com/invite/inv-123?token=abc";
  const budget = { organizationName: "Acme", budgetName: "platform", month: "2026-11", percent: 80, spent: "$80.00", budget: "$100.00", link: `${publicUrl}/settings/budgets`, publicUrl };
  const mails = {
    invitation: renderInvitationMail({ organizationName: "Acme", inviterName: "Ada", link, expiresAt: Date.UTC(2026, 10, 26, 14, 5), publicUrl }),
    verification: renderVerificationMail({ organizationName: "Acme", link, expiresAt: Date.UTC(2026, 10, 20), publicUrl }),
    reset: renderPasswordResetMail({ organizationName: "Acme", link, expiresAt: Date.UTC(2026, 10, 20), publicUrl }),
    "budget warning": renderBudgetWarningMail(budget),
    "budget reached": renderBudgetReachedMail({ ...budget, percent: 100, spent: "$100.00" }),
  };

  it("F-115: every account and budget mail renders with its link in both parts", () => {
    for (const [kind, mail] of Object.entries(mails)) {
      const expected = kind.startsWith("budget") ? budget.link : link;
      expect(mail.text, kind).toContain(expected);
      expect(mail.html, kind).toContain(expected.replaceAll("&", "&amp;"));
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.subject).not.toMatch(/[\r\n]/);
    }
  });

  it("says who invited to what, until when, and the budget's share and month", () => {
    expect(mails.invitation.subject).toBe("Ada invited you to Acme on ostra");
    expect(mails.invitation.text).toContain("26 November 2026, 14:05 UTC");
    expect(mails["budget warning"].text).toContain("$80.00 of its $100.00 budget for November 2026");
    expect(mails["budget warning"].subject).toBe("platform is at 80% of its budget");
    expect(mails["budget reached"].subject).toBe("platform reached its budget");
    expect(mails["budget reached"].text).toContain("Raise the budget: ");
  });

  it("escapes a name in the HTML", () => {
    const mail = renderInvitationMail({ organizationName: "<script>", inviterName: "A&B", link, expiresAt: 0, publicUrl });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("A&amp;B");
  });
});

// ---------- jobs ----------

describe("milestone 4's jobs", () => {
  it("F-002/c4: an account mail's job key, which log lines carry, holds no invitation ID: the link's secret", () => {
    const invitationId = "Fk3yqY0d1sJ2bE8xH5tQ-w";
    const key = jobKey("account-mail.send", { organizationId, purpose: "invitation", recordId: invitationId });
    expect(key).not.toContain(invitationId);
    // Still one key per mail: the same record gives the same key, another record another.
    expect(jobKey("account-mail.send", { organizationId, purpose: "invitation", recordId: invitationId })).toBe(key);
    expect(jobKey("account-mail.send", { organizationId, purpose: "invitation", recordId: `${invitationId}x` })).not.toBe(key);
  });

  it("names each job with its key rule", () => {
    for (const name of ["account-mail.send", "invitation.expire", "budget.check", "budget.release", "insights.compute", "search.backfill", "pr.link-related", "review.evaluate"] as const) {
      expect(jobNames).toContain(name);
      expect(jobSending[name]).toBeDefined();
    }
    const org = organizationId;
    expect(jobKey("account-mail.send", { organizationId: org, purpose: "invitation", recordId: "inv-1" })).toMatch(/^account-mail:invitation:[0-9a-f]{32}$/);
    expect(jobKey("budget.check", { organizationId: org, budgetId, month: "2026-11", threshold: "warn" })).toBe("budget:budget-project:2026-11:warn");
    expect(jobKey("budget.release", { organizationId: org, budgetId, raisedAt: 7 })).toBe("budget:budget-project:release:7");
    expect(jobKey("search.backfill", { organizationId: org, taskId: taskIdSchema.parse("t1") })).toBe("task:t1:search-backfill");
    expect(jobKey("pr.link-related", { organizationId: org, taskId: taskIdSchema.parse("t1"), repoId: repoIdSchema.parse("r1"), prNumber: 4 })).toBe("task:t1:link-related:r1:4");
    expect(jobSending["insights.compute"].kind).toBe("schedule");
    expect(jobSending["invitation.expire"].kind).toBe("schedule");
    expect(reviewEvaluateSingletonSeconds).toBe(10);
    // IDs only: a payload with text in it is refused.
    expect(jobPayloadSchemas["account-mail.send"].safeParse({ organizationId: org, purpose: "invitation", recordId: "inv-1", link: "https://x" }).success).toBe(false);
    expect(jobPayloadSchemas["budget.check"].safeParse({ organizationId: org, budgetId, month: "2026-13", threshold: "warn" }).success).toBe(false);
  });
});
