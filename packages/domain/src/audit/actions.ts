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
  // Milestone 6 (F-040, ADR 0057): an outside task's answer.
  "task.approved": "task",
  // Milestone 6 (F-099, ticket 15): a member's edit of a refine draft, "Update ticket" and "Mark ready".
  "draft.edited": "task",
  "draft.applied": "task",
  "draft.marked-ready": "task",
  // Milestone 6 (F-099, ticket 27): "Create ticket" from a prompt refine task's draft.
  "draft.ticket-created": "task",
  "task.rejected": "task",
  "checks.fix-asked": "task",
  "diff.comments-sent": "task",
  "pr.opened": "task",
  "pr.made-draft": "task",
  "pr.marked-ready": "task",
  "pr.merged": "task",
  "pr.closed": "task",
  "pr.reopened": "task",
  "pr.comment-accepted": "task",
  // Milestone 6 (F-105): a reviewer's "changes requested" reopened the task.
  "pr.changes-requested": "task",
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
  /** Milestone 8 (F-144, ticket 26): the preview domain's check ran, with whether it passed and no result text. */
  "instance.preview_domain_checked": "organization",
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
  // Milestone 7 (F-082): a member chose dark, light or the system's theme.
  "account.theme_changed": "user",
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
  /** Milestone 9 (F-148, ADR 0070): an admin's "Reads images" on a model, set or cleared. */
  "model.image-input-changed": "model",
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
  // Milestone 5 (F-120, ticket 28): an admin cleared it.
  "registry.cleared": "registry",
  // Milestone 5 (F-095, F-086): the box sizes, and a project's pools and default size.
  "box-size.updated": "organization",
  "project.pools-set": "project",
  "project.default-box-size-set": "project",
  // ---- connections: GitHub, Linear, boards ----
  "github.connected": "connection",
  // Q295: an admin added or replaced the own App's OAuth client secret, which members link through.
  "github.client-secret-set": "connection",
  // F-006/c4: an admin finished the webhook of an App made without one, or replaced its secret.
  "github.webhook-secret-set": "connection",
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
  // Milestone 6 (F-012, ticket 13): agent mode turned on, after the re-authorization with its scopes.
  "linear.agent-mode-enabled": "connection",
  // Milestone 11 (F-152, F-008, ADR 0071): a tracker connection of any kind. The `linear.*` entries
  // already written stay, and the setup timeline reads `linear.connected` beside `tracker.connected`.
  "tracker.connection-created": "connection",
  "tracker.renamed": "connection",
  "tracker.site-found": "connection",
  "tracker.token-saved": "connection",
  "tracker.connected": "connection",
  "tracker.secret-rotated": "connection",
  "tracker.token-replaced": "connection",
  "tracker.disconnected": "connection",
  "tracker.resumed": "connection",
  /** Ticket 06: step 3 made a pending Jira connection's webhook secret, once (never the secret). */
  "tracker.secret-made": "connection",
  /** Ticket 06: "Check again" read the saved token back, and kept what it read (IDs and outcomes only). */
  "tracker.token-checked": "connection",
  /** Ticket 06: a connection failed on its own (`token-expired`, `token-refused`); its boards pause. */
  "tracker.failed": "connection",
  /** Ticket 07: a Jira token's date is 14 days or less away; recorded once per connection and date. */
  "tracker.token-expiring": "connection",
  "board.attached": "project",
  "board.mapping-saved": "project",
  "board.detached": "project",
  // Milestone 6 (F-012): "Start from Linear" on a board, one board per team.
  "board.agent-mode-changed": "project",
  // ---- projects, repos and environments ----
  "project.created": "project",
  "project.default-profile-set": "project",
  "project.ticket-template-saved": "project",
  // Milestone 6 (F-100, ticket 28): a project's AI review switch.
  "project.ai-review-set": "project",
  // 2026-11-22 (F-097, Q31): "Make a ticket for every prompt task", with the board it names, or off.
  "project.prompt-tickets-set": "project",
  "project.repo-added": "project",
  "project.repo-removed": "project",
  "project.repos-reordered": "project",
  // 2026-11-21 (F-021, ADR 0049 amended): whether the repos' own skills reach the agent.
  "project.repo-skills-set": "project",
  "project.review-check-changed": "project",
  // Milestone 6 (F-040): "Outside tasks need approval", an organization admin's switch.
  "project.outside-approval-changed": "project",
  "environment.saved": "environment",
  "environment.service-added": "environment",
  "environment.service-changed": "environment",
  "environment.service-removed": "environment",
  "environment.snapshot-rebuild-requested": "environment",
  "environment.check-added": "environment",
  "environment.check-changed": "environment",
  "environment.checks-reordered": "environment",
  "environment.check-removed": "environment",
  // Milestone 6 (F-113): a project admin decided an onboarding task's environment proposal.
  "environment.proposal-accepted": "environment",
  "environment.proposal-rejected": "environment",
  // 2026-11-23 (F-112/c1, Q345 option (b)): a new repo's draft beside the saved setup, set aside, and its Undo.
  "environment.repo-draft-dismissed": "environment",
  "environment.repo-draft-restored": "environment",
  // Milestone 8 (F-140, ticket 15): the app's processes saved, by name and field, never a command;
  // "Keep it" on a port an agent announced, which proposes it for a project admin.
  "environment.app-processes-saved": "environment",
  "environment.app-process-kept": "environment",
  // ---- memory (ADR 0044) ----
  "memory.note-created": "memory-note",
  "memory.note-edited": "memory-note",
  "memory.note-archived": "memory-note",
  "memory.proposal-created": "memory-proposal",
  "memory.proposal-approved": "memory-proposal",
  "memory.proposal-merged": "memory-proposal",
  "memory.proposal-rejected": "memory-proposal",
  // ---- automations and bulk starts (milestone 6, F-011, F-106, F-107, ADR 0056) ----
  "automation.created": "automation",
  "automation.updated": "automation",
  "automation.paused": "automation",
  "automation.resumed": "automation",
  "automation.deleted": "automation",
  /** A tick found occurrences more than `OSTRA_SCHEDULE_MISSED_HOURS` late: one entry per catch-up, with the count. */
  "automation.occurrences-missed": "automation",
  /** A webhook automation's new signing secret (F-139): the old one stops working at once. Never the secret. */
  "automation.secret-rotated": "automation",
  "bulk-start.created": "bulk-start",
  // ---- the library (milestone 8, F-145, F-146, ADR 0069): names and sources, never a file or a secret ----
  "library.installed": "library-item",
  "library.attached": "library-item",
  "library.detached": "library-item",
  /** An item put on every profile, or taken off it. */
  "library.every_profile_changed": "library-item",
  "library.update_accepted": "library-item",
  "library.update_dismissed": "library-item",
  "library.removed": "library-item",
  /** A library server marked read-only, or not (ticket 28): plan mode may call a read-only one's tools. */
  "library.read_only_changed": "library-item",
  "library.source_added": "library-source",
  "library.source_removed": "library-source",
  /** A member's suggestion installed or dismissed. Never its note. */
  "library.suggestion_decided": "library-suggestion",
  // An organization admin's switches (F-146, F-142).
  "organization.marketplace_search_changed": "organization",
  "organization.public_preview_links_changed": "organization",
  // ---- previews (milestone 8, F-141, F-142, ADR 0068): levels, links and starts, never a token ----
  /** "Start the app": a box for the app alone, with no agent turn. */
  "app.started": "task",
  "preview.level_changed": "task",
  "preview.link_created": "task",
  "preview.link_revoked": "task",
  /** A link's first use, once per link. */
  "preview.link_first_used": "task",
} as const;

export type AuditAction = keyof typeof auditActions;

/** The kind of entity an action names. */
export type AuditEntityKind = (typeof auditActions)[AuditAction];

export const auditActionNames: readonly AuditAction[] = Object.freeze(Object.keys(auditActions).filter((name): name is AuditAction => name in auditActions));

export const isAuditAction = (value: string): value is AuditAction => Object.hasOwn(auditActions, value);
