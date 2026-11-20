// The audit log's actions (F-073, ADR 0054; milestone 4, ticket 10): a closed list, one dotted name
// per action, each naming the kind of entity it's about. A writer picks from it, so no writer can
// invent a spelling, and the viewer's action filter (ticket 25) lists exactly these.

/** Every audit action, and the kind of entity each one names. */
export const auditActions = {
  // ---- tasks ----
  "task.created": "task",
  "task.reopened": "task",
  "task.stopped": "task",
  /** Milestone 5 (F-067): cancelled from its pool's queue before it started. */
  "task.cancelled": "task",
  "task.driver-changed": "task",
  "task.effort-changed": "task",
  "task.update-branch": "task",
  "task.ticket-requested": "task",
  "task.ticket-sync-retried": "task",
  "task.ticket-closed": "task",
  "task.history_removed": "task",
  "checks.fix-asked": "task",
  "diff.comments-sent": "task",
  "pr.opened": "task",
  "pr.made-draft": "task",
  "pr.marked-ready": "task",
  "pr.merged": "task",
  "pr.closed": "task",
  "pr.reopened": "task",
  "pr.comment-accepted": "task",
  "approval.answered": "approval",
  "plan.answered": "task",
  // ---- uses of a credential: one entry per issuance (ADR 0054) ----
  "task.credentials-issued": "task",
  "task.credentials-refused": "task",
  "task.repo-token-refreshed": "task",
  "snapshot.credentials-issued": "environment",
  "mcp-secret.issued": "task",
  "cli-session.created": "cli-session",
  "cli-session.started": "cli-session",
  "cli-session.revoked": "cli-session",
  // ---- members, invitations and accounts (ADR 0053) ----
  "instance.first-admin-created": "member",
  "instance.admin-granted": "user",
  "instance.admin-revoked": "user",
  "invitation.created": "invitation",
  "invitation.revoked": "invitation",
  "invitation.accepted": "invitation",
  "member.verified": "member",
  "member.removed": "member",
  "member.role-changed": "member",
  "project.access-changed": "project",
  "project.member-set": "project",
  "project.member-removed": "project",
  "reset-link.created": "user",
  "reset-link.used": "user",
  "password.changed": "user",
  "github.linked": "member",
  "github.unlinked": "member",
  // ---- the organization and its settings ----
  "organization.created": "organization",
  "organization.renamed": "organization",
  "retention.saved": "organization",
  "retention.swept": "organization",
  "setup.step-skipped": "organization",
  "email.settings-saved": "organization",
  "email.test-sent": "organization",
  // ---- model providers, keys per project, prices and budgets ----
  "provider.added": "model-provider",
  "provider.updated": "model-provider",
  "model.updated": "model",
  "model.price-changed": "model",
  "model.reasoning-changed": "model",
  "providers.default-changed": "organization",
  "project.providers-changed": "project",
  "project.model-choice-changed": "project",
  "budget.set": "budget",
  "budget.cleared": "budget",
  // ---- agent profiles ----
  "agent-profile.created": "agent-profile",
  "agent-profile.updated": "agent-profile",
  "agent-profile.archived": "agent-profile",
  "agent-profile.model-set": "agent-profile",
  // ---- runners, pools and join tokens ----
  "runner.registered": "runner",
  "runner.approved": "runner",
  "runner.rejected": "runner",
  "runner.revoked": "runner",
  // Milestone 5 (F-091, F-092): a join names its token; an admin drains and resumes.
  "runner.joined": "runner",
  "runner.drained": "runner",
  "runner.resumed": "runner",
  "pool.created": "runner-pool",
  "pool.updated": "runner-pool",
  "join-token.created": "join-token",
  "join-token.revoked": "join-token",
  // Milestone 5 (F-120): the registry's settings, and each credential core hands a runner.
  "registry.set": "registry",
  "registry.credential-issued": "registry",
  // ---- connections: GitHub, Linear, boards ----
  "github.connected": "connection",
  "connection.added": "connection",
  "installation.linked": "connection",
  "installation.unlinked": "connection",
  "installation.removed": "connection",
  "linear.app-saved": "connection",
  "linear.started": "connection",
  "linear.connected": "connection",
  "linear.disconnected": "connection",
  "linear.token-refreshed": "connection",
  "linear.token-refresh-failed": "connection",
  "board.attached": "project",
  "board.mapping-saved": "project",
  "board.detached": "project",
  // ---- projects, repos and environments ----
  "project.created": "project",
  "project.default-profile-set": "project",
  "project.ticket-template-saved": "project",
  "project.repo-added": "project",
  "project.repo-removed": "project",
  "project.repos-reordered": "project",
  "project.review-check-changed": "project",
  "environment.saved": "environment",
  "environment.service-added": "environment",
  "environment.service-changed": "environment",
  "environment.service-removed": "environment",
  "environment.snapshot-rebuild-requested": "environment",
  "environment.check-added": "environment",
  "environment.check-changed": "environment",
  "environment.checks-reordered": "environment",
  "environment.check-removed": "environment",
  // ---- memory (ADR 0044) ----
  "memory.note-created": "memory-note",
  "memory.note-edited": "memory-note",
  "memory.note-archived": "memory-note",
  "memory.proposal-created": "memory-proposal",
  "memory.proposal-approved": "memory-proposal",
  "memory.proposal-merged": "memory-proposal",
  "memory.proposal-rejected": "memory-proposal",
} as const;

export type AuditAction = keyof typeof auditActions;

/** The kind of entity an action names. */
export type AuditEntityKind = (typeof auditActions)[AuditAction];

export const auditActionNames: readonly AuditAction[] = Object.freeze(Object.keys(auditActions).filter((name): name is AuditAction => name in auditActions));

export const isAuditAction = (value: string): value is AuditAction => Object.hasOwn(auditActions, value);
