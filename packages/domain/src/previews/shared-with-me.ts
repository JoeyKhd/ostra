import type { PreviewNoticeSubject } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { memberIdSchema, notificationIdSchema, previewAccessIdSchema, previewKeySchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemberId, NotificationId, OrganizationId, PreviewAccessId, PreviewKey, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { sharedPreviewUrl } from "../notifications/preview-notices.ts";
import { previewAccess } from "./access.ts";
import { namingIdOfNoticeKey, PREVIEW_SHARED_KIND } from "./named-people.ts";
import { previewShownInTx } from "./sharing.ts";

// A preview shared with a person by name, as they see it (milestone 8, F-142, ADR 0068;
// `preview-viewer.md`, open point 2): its own page in the panel (`/previews/<the level's ID>`), the
// notice that links there, and the Needs you page's row of it. Each reads the preview's level again,
// through `previewAccess`, so a person whose name was taken off, or who was never named, finds
// nothing, just as a stranger does. What they're shown is the preview's label and port, the
// organization's name and who shared it: never the task's title, key, project or thread.

/** A preview a member may open from its own page, with what the page shows of it. */
export type SharedPreview = {
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly label: string;
  readonly port: number | null;
  readonly organizationName: string;
  /** Whether they may click and type in it: only a member who can open the task (Q301). */
  readonly input: boolean;
};

/**
 * The preview a level's ID names, for a member who may open it now (`previewAccess`): a person it
 * names watches it, and a member who can open the task may use it. `null` for anyone else, for a
 * level of another organization and for an ID no level has: the page never says which.
 */
export const sharedPreviewForMember = (db: Db, scope: MemberScope, previewId: PreviewAccessId, now: number): Promise<SharedPreview | null> =>
  db.$transaction(async (tx) => {
    const row = await tx.previewAccess.findFirst({
      where: { id: previewId, organizationId: scope.organizationId },
      select: { taskId: true, key: true, projectId: true, level: true, members: { select: { memberId: true } }, project: { select: { access: true } } },
    });
    if (row === null) {
      return null;
    }
    const taskId = taskIdSchema.parse(row.taskId);
    const key = previewKeySchema.parse(row.key);
    const projectId = projectIdSchema.parse(row.projectId);
    const canOpenTask = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: row.project.access }, "read").ok;
    const level = { level: row.level, memberIds: row.members.map((member) => memberIdSchema.parse(member.memberId)) };
    // A member never opens a link here: the organization's switch for public links plays no part.
    const access = previewAccess({ kind: "member", memberId: scope.memberId, canOpenTask }, { taskId, key }, level, { publicPreviewLinks: false }, now);
    if (!access.allowed) {
      return null;
    }
    const shown = await previewShownInTx(tx, { id: taskId, organizationId: scope.organizationId, projectId }, key);
    const organization = await tx.organization.findUnique({ where: { id: scope.organizationId }, select: { name: true } });
    return { taskId, key, label: shown.label, port: shown.port, organizationName: organization?.name ?? "", input: access.input };
  });

/** A naming that still holds, as its notice and its row read it. */
type Naming = { readonly previewId: PreviewAccessId; readonly label: string; readonly port: number | null; readonly sharedBy: string | null; readonly organizationName: string };

/** The naming a notice's key holds, if the member is still named on that preview; else `null`. */
const namingInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId, key: string): Promise<Naming | null> => {
  const namingId = namingIdOfNoticeKey(key);
  if (namingId === null) {
    return null;
  }
  const naming = await tx.previewAccessMember.findFirst({
    where: { id: namingId, organizationId, memberId },
    select: { previewAccess: { select: { id: true, level: true, taskId: true, key: true, projectId: true, setByMemberId: true } } },
  });
  // A name taken off, or the level moved to the project's members: nothing to say any more.
  const access = naming?.previewAccess;
  if (access?.level !== "named") {
    return null;
  }
  const shown = await previewShownInTx(
    tx,
    { id: taskIdSchema.parse(access.taskId), organizationId, projectId: projectIdSchema.parse(access.projectId) },
    previewKeySchema.parse(access.key),
  );
  const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  const sharer = access.setByMemberId === null ? null : await tx.member.findFirst({ where: { id: access.setByMemberId, organizationId }, select: { user: { select: { name: true } } } });
  return { previewId: previewAccessIdSchema.parse(access.id), label: shown.label, port: shown.port, sharedBy: sharer?.user.name ?? null, organizationName: organization?.name ?? "" };
};

/**
 * What a preview notice delivery says, read from the naming when it's due (`notify.deliver`): the
 * preview, who shared it and its own page. `null` once the person isn't named any more.
 */
export const loadPreviewShareNotice = (
  db: Db,
  input: { readonly organizationId: OrganizationId; readonly memberId: MemberId; readonly key: string; readonly publicUrl: string },
): Promise<PreviewNoticeSubject | null> =>
  db.$transaction(async (tx) => {
    const naming = await namingInTx(tx, input.organizationId, input.memberId, input.key);
    return naming === null
      ? null
      : { label: naming.label, port: naming.port, sharedBy: naming.sharedBy, organizationName: naming.organizationName, url: sharedPreviewUrl(input.publicUrl, naming.previewId) };
  });

/** A row of the Needs you page: a preview shared with the member, still. */
export type PreviewShare = {
  readonly notificationId: NotificationId;
  readonly previewId: PreviewAccessId;
  readonly label: string;
  readonly port: number | null;
  readonly sharedBy: string | null;
  readonly read: boolean;
  readonly createdAt: number;
};

/** How many open preview notices the Needs you page reads, newest first. */
const SHARES_READ = 50;

/**
 * The member's open preview notices whose naming still holds, newest first, one per preview: the
 * Needs you page's rows, each opening the preview's own page. A notice whose name was taken off
 * shows nothing, without a write.
 */
export const previewSharesOfMember = (db: Db, scope: MemberScope): Promise<readonly PreviewShare[]> =>
  db.$transaction(async (tx) => {
    const rows = await tx.notification.findMany({
      where: { organizationId: scope.organizationId, memberId: scope.memberId, kind: PREVIEW_SHARED_KIND, state: "open" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SHARES_READ,
      select: { id: true, readAt: true, createdAt: true, deliveries: { select: { idempotencyKey: true }, take: 1 } },
    });
    const shares: PreviewShare[] = [];
    for (const row of rows) {
      const key = row.deliveries[0]?.idempotencyKey;
      const naming = key === undefined ? null : await namingInTx(tx, scope.organizationId, scope.memberId, key);
      if (naming === null || shares.some((share) => share.previewId === naming.previewId)) {
        continue;
      }
      shares.push({
        notificationId: notificationIdSchema.parse(row.id),
        previewId: naming.previewId,
        label: naming.label,
        port: naming.port,
        sharedBy: naming.sharedBy,
        read: row.readAt !== null,
        createdAt: row.createdAt.getTime(),
      });
    }
    return shares;
  });
