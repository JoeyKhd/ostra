// @ostra/domain: the lifecycles as discriminated unions with their transitions, the use-case
// seams, the job catalogue, the access checks and the server's settings.
export * from "./lifecycles/transition.ts";
export * from "./lifecycles/task.ts";
export * from "./lifecycles/session.ts";
export * from "./lifecycles/box.ts";
export * from "./lifecycles/runner.ts";
export * from "./lifecycles/approval.ts";
export * from "./lifecycles/needs-you.ts";
export * from "./lifecycles/task-repo.ts";
export * from "./lifecycles/snapshot.ts";
export * from "./lifecycles/lease.ts";
export * from "./lifecycles/mapping.ts";
export * from "./lifecycles/m4.ts";
export * from "./lifecycles/join-token.ts";

export * from "./ports.ts";
export * from "./jobs.ts";
export * from "./access.ts";
export * from "./accounts.ts";
export * from "./branch-name.ts";
export * from "./dispatch-wait.ts";
export * from "./fleet/index.ts";
export * from "./settings.ts";
export * from "./postgres-ports.ts";
export * from "./postgres-outbox.ts";

// Milestone 2.
export * from "./tickets/board-mapping.ts";
export * from "./tickets/ticket-template.ts";
export * from "./tickets/rebuild-template.ts";
export * from "./tickets/contracts.ts";
export * from "./tickets/ticket-writes.ts";
export * from "./tickets/ticket-cache.ts";
export * from "./postgres-plumbing.ts";

export * from "./use-cases/common.ts";
export * from "./use-cases/moves.ts";
export * from "./use-cases/accept-offer.ts";
export * from "./use-cases/add-model-provider.ts";
export * from "./use-cases/connect-github-app.ts";
export * from "./setup/complete.ts";
export * from "./use-cases/seed-first-admin.ts";
export * from "./use-cases/seed-member.ts";
export * from "./use-cases/check-secrets-key.ts";
export * from "./use-cases/create-project.ts";
export * from "./use-cases/create-prompt-task.ts";
export * from "./use-cases/dispatch-task.ts";
export * from "./use-cases/admission.ts";
export * from "./use-cases/fleet-rows.ts";
export * from "./use-cases/fleet-settings.ts";
export * from "./use-cases/runner-report.ts";
export * from "./use-cases/hold-provider.ts";
export * from "./use-cases/ingest-events.ts";
export * from "./use-cases/issue-task-credentials.ts";
export * from "./use-cases/open-pull-requests.ts";
export * from "./use-cases/record-session-end.ts";
export * from "./use-cases/register-personal-runner.ts";
export * from "./use-cases/save-environment.ts";
export * from "./use-cases/drain-runner.ts";
export * from "./use-cases/revoke-runner.ts";
export * from "./use-cases/stop-task.ts";
export * from "./use-cases/server-events.ts";
export * from "./use-cases/agent-profiles.ts";
export * from "./use-cases/agent-profile-setup.ts";
export * from "./use-cases/task-profile.ts";
export * from "./panel-blob-token.ts";
export * from "./use-cases/approvals.ts";
export * from "./use-cases/plans-questions.ts";
export * from "./use-cases/pools.ts";
export * from "./use-cases/pool-admin.ts";
export * from "./use-cases/runner-approval.ts";
export * from "./use-cases/sync-provider-models.ts";
export * from "./use-cases/linear-connection.ts";
export * from "./use-cases/boards.ts";
export * from "./use-cases/tickets.ts";
export * from "./use-cases/reopen.ts";
export * from "./use-cases/needs-you-items.ts";
export * from "./use-cases/notifications.ts";
export * from "./use-cases/email-settings.ts";
export * from "./use-cases/usage.ts";
export * from "./use-cases/sessions-m2.ts";
export * from "./use-cases/spend.ts";
export * from "./use-cases/budgets.ts";
export * from "./use-cases/budget-notices.ts";
export * from "./use-cases/insights.ts";
export * from "./use-cases/rebuild-history.ts";
export * from "./use-cases/pull-request-states.ts";
export * from "./use-cases/cleanup.ts";
export * from "./use-cases/repo-checks.ts";
export * from "./environment/detect.ts";
export * from "./environment/services.ts";

// Milestone 3.
export * from "./rules/index.ts";
export * from "./notifications/index.ts";
export * from "./prompts/index.ts";
export * from "./use-cases/m3-signatures.ts";
export * from "./use-cases/m4-signatures.ts";
export * from "./use-cases/m5-signatures.ts";
export * from "./use-cases/invitations.ts";
export * from "./use-cases/members.ts";

// Milestone 4.
export * from "./budget/gate.ts";
export * from "./insights/figures.ts";
export * from "./memory/secret-scan.ts";
export * from "./memory/block.ts";
export * from "./memory/remember-this.ts";
export * from "./memory/store.ts";
export * from "./memory/notes.ts";
export * from "./memory/closing-turn.ts";
export * from "./repos/several-repos.ts";
export * from "./review/independent-review.ts";
export * from "./review/review-check.ts";
export * from "./repos/project-repos.ts";
export * from "./repos/repo-skills.ts";
export * from "./mail/account-mails.ts";
export * from "./mail/account-mail-links.ts";
export * from "./audit/actions.ts";
export * from "./audit/record-audit.ts";
export * from "./search/entries.ts";
export * from "./search/query.ts";
export * from "./providers/model-name.ts";
export * from "./providers/resolve.ts";
export * from "./providers/provider-lists.ts";
export * from "./providers/session-model.ts";
export * from "./providers/turn-start.ts";
export * from "./providers/release-boxes.ts";
export * from "./code-host/installations.ts";
export * from "./diff/unified-diff.ts";
export * from "./diff/stored-diff.ts";
export * from "./use-cases/repo-access.ts";
export * from "./use-cases/member-message.ts";
export * from "./use-cases/diff-comments.ts";
export * from "./checks/pr-checks.ts";
export * from "./use-cases/checks.ts";
export * from "./use-cases/notification-settings.ts";
export * from "./use-cases/snapshots.ts";
export * from "./use-cases/registry.ts";
export * from "./use-cases/registry-clear.ts";
export * from "./use-cases/behind.ts";
export * from "./use-cases/after-merge.ts";
export * from "./use-cases/cli-sessions.ts";
export * from "./use-cases/github-link.ts";
export * from "./use-cases/pr-comments.ts";

// Milestone 4: reasoning effort (F-137, ADR 0066).
export * from "./effort/reasoning.ts";
export * from "./effort/levels.ts";
export * from "./use-cases/effort.ts";
// Milestone 4: an admin's model prices (F-037, ticket 27).
export * from "./use-cases/model-price.ts";
export * from "./use-cases/box-wait.ts";

// Milestone 7 (ticket 36): the palette's actions, setup's timeline and the theme.
export * from "./palette/actions.ts";
export * from "./setup/timeline.ts";
export * from "./use-cases/theme.ts";

// Milestone 6 (spec section 5.4): automations, starts, Linear's agent mode and the review loop.
export * from "./lifecycles/m6.ts";
export * from "./automations/cron.ts";
export * from "./automations/cron-sentence.ts";
export * from "./automations/intake-filter.ts";
export * from "./starts/start-task.ts";
// Milestone 6, tickets 10 and 11: the one start's body, bulk starts, intake rules and the scheduler.
export * from "./starts/start-task-body.ts";
export * from "./starts/bulk.ts";
export * from "./automations/intake.ts";
export * from "./automations/intake-enqueue.ts";
export * from "./automations/manage.ts";
export * from "./automations/scheduler.ts";
export * from "./automations/webhook.ts";
export * from "./automations/webhook-request.ts";
export * from "./automations/webhook-template.ts";
export * from "./tickets/ticket-outbox.ts";
// Milestone 6, ticket 12: sub-issues and the parent's progress comment.
export * from "./starts/sub-issues.ts";
export * from "./tickets/parent-progress.ts";
export * from "./starts/origin-labels.ts";
export * from "./review-loop/ci-verdict.ts";
export * from "./review-loop/rounds.ts";
export * from "./review-loop/place-findings.ts";
export * from "./review-loop/codeowners.ts";
export * from "./review-loop/loop.ts";
export * from "./review-loop/evaluate-ci.ts";
export * from "./review-loop/start-round.ts";
export * from "./review-loop/review.ts";
export * from "./review-loop/review-settings.ts";
export * from "./review-loop/reviewers.ts";
export * from "./review-loop/changes-requested.ts";
export * from "./onboarding/onboarding.ts";
export * from "./linear/agent-session-copy.ts";
export * from "./prompts/m6.ts";
export * from "./use-cases/m6-signatures.ts";
export * from "./use-cases/agent-sessions.ts";
export * from "./use-cases/outside-tasks.ts";
export * from "./linear/agent-session-moments.ts";
export * from "./use-cases/agent-mode.ts";
export * from "./use-cases/refine-drafts.ts";

// Milestone 8 (ticket 06, ADR 0069): the library.
export * from "./library/reference.ts";
export * from "./library/vendor.ts";
export * from "./library/hash.ts";
export * from "./library/check-skill.ts";
export * from "./library/allowed.ts";
export * from "./library/diffs.ts";
export * from "./library/profile-items.ts";
export * from "./lifecycles/m8-library.ts";
export * from "./use-cases/m8-library-signatures.ts";

// Milestone 8 (ticket 05, ADR 0068): app processes, attachments, previews and sharing.
export * from "./previews/app-processes.ts";
export * from "./previews/targets.ts";
export * from "./previews/access.ts";
export * from "./previews/warm.ts";
export * from "./previews/host.ts";
export * from "./previews/tokens.ts";
export * from "./environment/detect-app.ts";
export * from "./lifecycles/m8-previews.ts";
export * from "./use-cases/m8-preview-signatures.ts";

// Milestone 8 (ticket 27, ADR 0069): the library's install by reference, its sources and its test call.
export * from "./library/stored.ts";
export * from "./library/outbound.ts";
export * from "./library/github-source.ts";
export * from "./library/well-known-source.ts";
export * from "./library/registry-source.ts";
export * from "./library/mcp-test-call.ts";
export * from "./library/sources.ts";
export * from "./library/install.ts";
// Milestone 8 (ticket 29, ADR 0069): the marketplace search and its switch.
export * from "./library/search.ts";
// Milestone 8 (ticket 19, ADR 0068): views, warm boxes and "Start the app".
export * from "./previews/views.ts";
export * from "./previews/start-app.ts";
export * from "./previews/app-lease.ts";
