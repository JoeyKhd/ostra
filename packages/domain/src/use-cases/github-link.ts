import type { Tx } from "@ostra/db";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";

import { enqueueReviewEvaluationsForUserInTx } from "../review/review-check.ts";
import type { LinkGitHubUser, UnlinkGitHubUser } from "./m3-signatures.ts";

// The verified GitHub link (F-119, ADR 0052; ticket 39): an account's GitHub user ID and login, as
// the App's own OAuth returned them. ostra keeps no token. The ID is unique across the install, so
// one GitHub account cannot stand for two members (F-053 and F-102 read it to know who someone is).
// IDs only in the audit entry.

/** The member an audit entry of this account's is filed under: its oldest membership. */
const auditPlace = (tx: Tx, userId: string) => tx.member.findFirst({ where: { userId }, orderBy: { createdAt: "asc" }, select: { id: true, organizationId: true } });

export const linkGitHubUser: LinkGitHubUser = async (deps, input) =>
  deps.db.$transaction(async (tx) => {
    const holder = await tx.user.findFirst({ where: { githubUserId: input.githubUserId, NOT: { id: input.userId } }, select: { id: true } });
    if (holder !== null) {
      return { ok: false, error: "linked-to-someone-else", message: "That GitHub account is linked to another ostra account. Unlink it there first" } as const;
    }
    const now = new Date(deps.clock.now());
    await tx.user.update({ where: { id: input.userId }, data: { githubUserId: input.githubUserId, githubLogin: input.githubLogin, githubLinkedAt: now } });
    // Milestone 4 (F-104): an approval by this account may count now, on the organizations' open task PRs.
    await enqueueReviewEvaluationsForUserInTx(deps.jobs, tx, input.userId);
    const place = await auditPlace(tx, input.userId);
    if (place !== null) {
      await deps.audit.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(place.organizationId),
        projectId: null,
        actor: { kind: "member", id: place.id },
        action: "github.linked",
        entity: "member",
        entityId: memberIdSchema.parse(place.id),
        data: { githubUserId: input.githubUserId },
      });
    }
    return { ok: true, githubLogin: input.githubLogin } as const;
  });

export const unlinkGitHubUser: UnlinkGitHubUser = async (deps, input) =>
  deps.db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { githubUserId: true } });
    if (!user?.githubUserId) {
      return { ok: false, error: "not-linked", message: "No GitHub account is linked" } as const;
    }
    await tx.user.update({ where: { id: input.userId }, data: { githubUserId: null, githubLogin: null, githubLinkedAt: null } });
    // Milestone 4 (F-104): an approval by this account counts no more.
    await enqueueReviewEvaluationsForUserInTx(deps.jobs, tx, input.userId);
    const place = await auditPlace(tx, input.userId);
    if (place !== null) {
      await deps.audit.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(place.organizationId),
        projectId: null,
        actor: { kind: "member", id: place.id },
        action: "github.unlinked",
        entity: "member",
        entityId: memberIdSchema.parse(place.id),
        data: { githubUserId: user.githubUserId },
      });
    }
    return { ok: true, unlinked: true } as const;
  });

/**
 * The address a commit credits for a member with a verified GitHub link (ADR 0052): GitHub's own
 * no-reply address for that ID and login, so the commit shows on their profile and carries no email.
 */
export const githubNoReplyAddress = (githubUserId: string, githubLogin: string): string => `${githubUserId}+${githubLogin}@users.noreply.github.com`;
