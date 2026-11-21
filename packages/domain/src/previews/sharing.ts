import { randomUUID } from "node:crypto";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  attachmentIdSchema,
  blobIdSchema,
  commandKindSupportedOn,
  memberIdSchema,
  organizationIdSchema,
  previewKeySchema,
  previewLinkIdSchema,
  previewRefusalWords,
  previewViewIdSchema,
  projectIdSchema,
  runnerLimits,
  screenshotRequestIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { ExecutorKind, MemberId, OrganizationId, PreviewKey, PreviewLinkId, PreviewListItem, PreviewViewId, ProjectId, ReservedPorts, SessionId, TaskId } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { previewLinkFromRow } from "../lifecycles/m8-previews.ts";
import type { PreviewViewCloseReason } from "../lifecycles/m8-previews.ts";
import type { Ports } from "../ports.ts";
import type { PreviewSettings } from "../settings.ts";
import { loadMemberScopeInTx } from "../starts/bulk.ts";
import type {
  CreatePreviewLink,
  ListPreviews,
  PreviewLinkResolution,
  PreviewLinkView,
  PreviewSharing,
  RevokePreviewLink,
  SetPreviewLevel,
  SetPublicPreviewLinks,
  TakeMemberScreenshot,
  UsePreviewLink,
} from "../use-cases/m8-preview-signatures.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { previewAccess } from "./access.ts";
import { notifyNamedPeopleInTx } from "./named-people.ts";
import type { NamedPeopleNoticeDeps } from "./named-people.ts";
import { mayReach } from "./targets.ts";
import { newPreviewLinkToken, previewLinkTokenHash, previewLinkTokenMatches } from "./tokens.ts";
import type { RandomBytes } from "./tokens.ts";
import { boxPreviewability, closeViewInTx, previewBoxInTx, taskPreviewTargetsInTx } from "./views.ts";
import type { PreviewBox } from "./views.ts";

// Sharing a preview, and what the pane lists (milestone 8, ticket 20, F-141, F-142, ADR 0068, "Who
// can open a preview"): a preview's level, its links, a link's use from the viewer page, the
// organization's switch for public links, the pane's list and a member's screenshot. Each write is
// one transaction with its audit entry, its task event and its change notice (ADR 0054). Any
// member who can open the task may share it (ADR 0068: "set by a member who can open the task").
// Narrowing ends every view of someone who no longer qualifies, at once. Never logged: a link's
// token.

/** What sharing's writes take: the database, the ports and the previews' settings. */
export type SharingDeps = Pick<Ports, "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly settings: Pick<PreviewSettings, "linkMaxDays" | "domain">;
  readonly logger?: Logger;
  /** Random bytes for a link's token: Node's by default. */
  readonly random?: RandomBytes;
};

/** How long a new expiring link lasts when its member picks nothing *(working value, ADR 0068)*. */
export const PREVIEW_LINK_DEFAULT_HOURS = 24;

/** How many links of one preview the share menu lists, newest first. */
const LINKS_LISTED = 20;

/** The open states of a view. */
const OPEN_VIEW_STATES = ["opening", "open"] as const;

/** A task as sharing reads it. */
export type PreviewTaskRow = { readonly id: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId };

/**
 * The task, for a member who can open it, or `null`: another organization's task, and one in a
 * restricted project the member isn't on, are alike (ADR 0026: their existence doesn't leak). A
 * named person can't open the task, so they get `null` here too.
 */
const taskForMemberInTx = async (tx: Tx, scope: MemberScope, taskId: TaskId): Promise<PreviewTaskRow | null> => {
  const task = await tx.task.findFirst({ where: { id: taskId, organizationId: scope.organizationId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
  if (task === null) {
    return null;
  }
  const projectId = projectIdSchema.parse(task.projectId);
  const access = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: task.project.access }, "read");
  return access.ok ? { id: taskIdSchema.parse(task.id), organizationId: scope.organizationId, projectId } : null;
};

/** Whether a member can open the task's project now, by the project's access rule (ADR 0026). */
const canOpenProjectInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId, projectId: ProjectId): Promise<boolean> => {
  const scope = await loadMemberScopeInTx(tx, organizationId, memberId);
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { access: true } });
  return scope !== null && project !== null && requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "read").ok;
};

/**
 * The task's previews as sharing reads them: the live box's list, or, with no box, every preview
 * the environment declares, services included (a box on any executor but `host` runs them).
 */
const previewsOfTaskInTx = async (tx: Tx, task: PreviewTaskRow, box: PreviewBox | null): Promise<readonly PreviewListItem[]> => {
  const executor: ExecutorKind = box?.executor ?? "docker";
  return taskPreviewTargetsInTx(tx, task, executor);
};

/** The task's newest session: what its server events are numbered under. `null` for a task with none. */
const latestSessionInTx = async (tx: Tx, taskId: TaskId): Promise<SessionId | null> => {
  const session = await tx.session.findFirst({ where: { taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true } });
  return session === null ? null : sessionIdSchema.parse(session.id);
};

/** Whether a link row is active at `now`. */
const linkActiveWhere = (now: number) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] });

/** Ends one link in the caller's transaction: its row, its audit entry, its event, and its open views. */
const revokeLinkInTx = async (
  deps: Pick<SharingDeps, "outbox" | "notices" | "audit" | "clock">,
  tx: Tx,
  link: { readonly id: PreviewLinkId; readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly key: PreviewKey },
  by: MemberId,
  sessionId: SessionId | null,
): Promise<{ readonly revoked: boolean; readonly viewsClosed: number }> => {
  const now = deps.clock.now();
  const ended = await tx.previewLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: new Date(now), revokedByMemberId: by } });
  if (ended.count === 0) {
    return { revoked: false, viewsClosed: 0 };
  }
  await deps.audit.recordInTx(tx, {
    organizationId: link.organizationId,
    projectId: link.projectId,
    actor: { kind: "member", id: by },
    action: "preview.link_revoked",
    entity: "task",
    entityId: link.taskId,
    data: { linkId: link.id, key: link.key },
  });
  if (sessionId !== null) {
    await appendServerEvent(tx, {
      organizationId: link.organizationId,
      projectId: link.projectId,
      taskId: link.taskId,
      sessionId,
      at: now,
      event: { kind: "preview.link_revoked", linkId: link.id, memberId: by },
    });
  }
  const views = await tx.previewView.findMany({ where: { linkId: link.id, state: { in: [...OPEN_VIEW_STATES] } }, select: { id: true } });
  let viewsClosed = 0;
  for (const view of views) {
    viewsClosed += await closeOne(deps, tx, previewViewIdSchema.parse(view.id), "link-ended");
  }
  return { revoked: true, viewsClosed };
};

const closeOne = async (deps: Pick<SharingDeps, "outbox" | "notices" | "clock">, tx: Tx, viewId: PreviewViewId, reason: Exclude<PreviewViewCloseReason, "box-refused">): Promise<number> => {
  const closed = await closeViewInTx(deps, tx, { viewId, reason });
  return closed.ok && closed.closed ? 1 : 0;
};

// ---------- a preview's level ----------

/** The most people one preview names. */
export const PREVIEW_NAMED_MAX = 100;

export const setPreviewLevel = async (deps: SharingDeps & NamedPeopleNoticeDeps, scope: MemberScope, input: Parameters<SetPreviewLevel>[2]): ReturnType<SetPreviewLevel> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const task = await taskForMemberInTx(tx, scope, input.taskId);
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    const box = await previewBoxInTx(tx, task.organizationId, task.id);
    if (!(await previewsOfTaskInTx(tx, task, box)).some((item) => item.key === input.key)) {
      return { ok: false, error: "not-found", message: "No such preview" };
    }
    const named = input.level === "named" ? [...new Set(input.memberIds)] : [];
    if (named.length > PREVIEW_NAMED_MAX) {
      return { ok: false, error: "not-a-member", message: `A preview names at most ${String(PREVIEW_NAMED_MAX)} people` };
    }
    const found = await tx.member.count({ where: { id: { in: named }, organizationId: task.organizationId, state: "active" } });
    if (found !== named.length) {
      return { ok: false, error: "not-a-member", message: "Each person named must be an active member of the organization" };
    }
    const access = await tx.previewAccess.upsert({
      where: { taskId_key: { taskId: task.id, key: input.key } },
      create: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, key: input.key, level: input.level, setByMemberId: scope.memberId },
      update: { level: input.level, setByMemberId: scope.memberId },
      select: { id: true },
    });
    await tx.previewAccessMember.deleteMany({ where: { previewAccessId: access.id, memberId: { notIn: named } } });
    // The rows made now are the people newly named: those named already keep theirs.
    const added = await tx.previewAccessMember.createManyAndReturn({
      data: named.map((memberId) => ({ organizationId: task.organizationId, projectId: task.projectId, previewAccessId: access.id, memberId })),
      skipDuplicates: true,
      select: { id: true, memberId: true },
    });
    // Each person newly named is told where to watch it (F-142); taking a name off tells no one.
    const told = await notifyNamedPeopleInTx(deps, tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      by: scope.memberId,
      named: added.map((row) => ({ namingId: row.id, memberId: memberIdSchema.parse(row.memberId) })),
    });
    const sessionId = await latestSessionInTx(tx, task.id);
    // Choosing a level below links narrows the preview away from them: its active links end.
    const links = await tx.previewLink.findMany({ where: { taskId: task.id, key: input.key, organizationId: task.organizationId, ...linkActiveWhere(now) }, select: { id: true } });
    let linksEnded = 0;
    let viewsClosed = 0;
    for (const link of links) {
      const ended = await revokeLinkInTx(deps, tx, { id: previewLinkIdSchema.parse(link.id), organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, key: input.key }, scope.memberId, sessionId);
      linksEnded += ended.revoked ? 1 : 0;
      viewsClosed += ended.viewsClosed;
    }
    // A member's view ends when the member can't open the task and isn't named any more.
    const views = await tx.previewView.findMany({
      where: { taskId: task.id, key: input.key, state: { in: [...OPEN_VIEW_STATES] }, openedByMemberId: { not: null } },
      select: { id: true, openedByMemberId: true },
    });
    for (const view of views) {
      const memberId = memberIdSchema.parse(view.openedByMemberId);
      if (!named.includes(memberId) && !(await canOpenProjectInTx(tx, task.organizationId, memberId, task.projectId))) {
        viewsClosed += await closeOne(deps, tx, previewViewIdSchema.parse(view.id), "refused");
      }
    }
    await deps.audit.recordInTx(tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "preview.level_changed",
      entity: "task",
      entityId: task.id,
      data: { key: input.key, level: input.level, named: named.length, linksEnded },
    });
    if (sessionId !== null) {
      await appendServerEvent(tx, {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        sessionId,
        at: now,
        event: { kind: "preview.level_changed", key: input.key, level: input.level, memberId: scope.memberId },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
    deps.logger?.info("preview.level-changed", { taskId: task.id, key: input.key, level: input.level, named: named.length, told, linksEnded, viewsClosed });
    return { ok: true, level: input.level, linksEnded, viewsClosed };
  });
setPreviewLevel satisfies SetPreviewLevel;

// ---------- links ----------

const publicLinksInTx = async (tx: Tx, organizationId: OrganizationId): Promise<boolean> =>
  (await tx.organizationSetting.findUnique({ where: { organizationId }, select: { publicPreviewLinks: true } }))?.publicPreviewLinks ?? false;

/**
 * A new link to one preview (ADR 0068): an expiring one, 24 hours unless its member picks other,
 * up to `OSTRA_PREVIEW_LINK_MAX_DAYS`; or a public one, only where the organization allows public
 * links. Watch-only unless it allows input (Q301). Its token is in the answer once: the row keeps
 * only its SHA-256.
 */
export const createPreviewLink = async (deps: SharingDeps, scope: MemberScope, input: Parameters<CreatePreviewLink>[2]): ReturnType<CreatePreviewLink> => {
  const now = deps.clock.now();
  let expiresAt: number | null = null;
  switch (input.kind) {
    case "expiring": {
      const hours = input.expiresInHours ?? PREVIEW_LINK_DEFAULT_HOURS;
      if (!Number.isInteger(hours) || hours < 1 || hours > deps.settings.linkMaxDays * 24) {
        return { ok: false, error: "too-long", message: `A link lasts from an hour up to ${String(deps.settings.linkMaxDays)} days` };
      }
      expiresAt = now + hours * 3_600_000;
      break;
    }
    case "public":
      break;
    default:
      return input.kind satisfies never;
  }
  const minted = newPreviewLinkToken(deps.random);
  return deps.db.$transaction(async (tx) => {
    const task = await taskForMemberInTx(tx, scope, input.taskId);
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    const box = await previewBoxInTx(tx, task.organizationId, task.id);
    if (!(await previewsOfTaskInTx(tx, task, box)).some((item) => item.key === input.key)) {
      return { ok: false, error: "not-found", message: "No such preview" };
    }
    if (input.kind === "public" && !(await publicLinksInTx(tx, task.organizationId))) {
      return { ok: false, error: "public-links-off", message: "This organization doesn't allow public preview links" };
    }
    const created = await tx.previewLink.create({
      data: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        key: input.key,
        kind: input.kind,
        tokenHash: minted.tokenHash,
        allowInput: input.allowInput,
        expiresAt: expiresAt === null ? null : new Date(expiresAt),
        createdByMemberId: scope.memberId,
      },
      select: { id: true },
    });
    const linkId = previewLinkIdSchema.parse(created.id);
    await deps.audit.recordInTx(tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "preview.link_created",
      entity: "task",
      entityId: task.id,
      data: { linkId, key: input.key, kind: input.kind, allowInput: input.allowInput, expiresAt },
    });
    const sessionId = await latestSessionInTx(tx, task.id);
    if (sessionId !== null) {
      await appendServerEvent(tx, {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        sessionId,
        at: now,
        event: { kind: "preview.link_created", linkId, key: input.key, linkKind: input.kind, allowInput: input.allowInput, expiresAt, memberId: scope.memberId },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
    deps.logger?.info("preview.link-created", { taskId: task.id, linkId, key: input.key, kind: input.kind, allowInput: input.allowInput });
    return { ok: true, linkId, token: minted.token, expiresAt };
  });
};
createPreviewLink satisfies CreatePreviewLink;

/** Ends a link (ADR 0068): any member who can open its task may. Its open views close at once. */
export const revokePreviewLink = async (deps: SharingDeps, scope: MemberScope, input: Parameters<RevokePreviewLink>[2]): ReturnType<RevokePreviewLink> =>
  deps.db.$transaction(async (tx) => {
    const link = await tx.previewLink.findFirst({ where: { id: input.linkId, organizationId: scope.organizationId }, select: { id: true, taskId: true, key: true } });
    const task = link === null ? null : await taskForMemberInTx(tx, scope, taskIdSchema.parse(link.taskId));
    if (link === null || task === null) {
      return { ok: false, error: "not-found", message: "No such link" };
    }
    const sessionId = await latestSessionInTx(tx, task.id);
    const ended = await revokeLinkInTx(deps, tx, { id: previewLinkIdSchema.parse(link.id), organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, key: previewKeySchema.parse(link.key) }, scope.memberId, sessionId);
    if (ended.revoked) {
      await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
      deps.logger?.info("preview.link-revoked", { taskId: task.id, linkId: link.id, viewsClosed: ended.viewsClosed });
    }
    return { ok: true, ...ended };
  });
revokePreviewLink satisfies RevokePreviewLink;

// ---------- a link's use (the viewer page) ----------

/** A preview's label and port by its key, from the task's list; the key itself when it's gone from it. */
export const previewShownInTx = async (tx: Tx, task: PreviewTaskRow, key: PreviewKey): Promise<{ readonly label: string; readonly port: number | null }> => {
  const box = await previewBoxInTx(tx, task.organizationId, task.id);
  const item = (await previewsOfTaskInTx(tx, task, box)).find((preview) => preview.key === key);
  return item === undefined ? { label: key, port: null } : { label: item.label, port: item.port };
};

/**
 * What a link's token opens (ADR 0068), read by its SHA-256 and compared in constant time. It
 * fails closed: text that isn't a token, a token no row has, and a row whose task is gone are all
 * `unknown`, and say nothing of whether they existed.
 */
export const resolvePreviewLinkInTx = async (tx: Tx, token: string, now: number): Promise<PreviewLinkResolution> => {
  const hash = previewLinkTokenHash(token);
  const row =
    hash === null
      ? null
      : await tx.previewLink.findUnique({
          where: { tokenHash: hash },
          select: { id: true, organizationId: true, projectId: true, taskId: true, key: true, kind: true, allowInput: true, expiresAt: true, revokedAt: true, revokedByMemberId: true, tokenHash: true },
        });
  if (row === null || !previewLinkTokenMatches(token, row.tokenHash)) {
    return { state: "unknown" };
  }
  const organization = await tx.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } });
  if (organization === null) {
    return { state: "unknown" };
  }
  const task: PreviewTaskRow = { id: taskIdSchema.parse(row.taskId), organizationId: organizationIdSchema.parse(row.organizationId), projectId: projectIdSchema.parse(row.projectId) };
  const key = previewKeySchema.parse(row.key);
  const linkId = previewLinkIdSchema.parse(row.id);
  const access = previewAccess(
    {
      kind: "link",
      link: {
        linkId,
        taskId: task.id,
        key,
        kind: row.kind,
        allowInput: row.allowInput,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        revokedByMemberId: row.revokedByMemberId === null ? null : memberIdSchema.parse(row.revokedByMemberId),
      },
    },
    { taskId: task.id, key },
    null,
    { publicPreviewLinks: await publicLinksInTx(tx, task.organizationId) },
    now,
  );
  const organizationName = organization.name;
  if (access.allowed) {
    const shown = await previewShownInTx(tx, task, key);
    return { state: "active", linkId, taskId: task.id, key, ...shown, organizationName, input: access.input, expiresAt: row.expiresAt?.getTime() ?? null };
  }
  switch (access.reason) {
    case "link-revoked":
      return { state: "revoked", ...(await previewShownInTx(tx, task, key)), organizationName, at: (row.revokedAt ?? new Date(now)).getTime() };
    case "link-expired":
      return { state: "expired", ...(await previewShownInTx(tx, task, key)), organizationName, at: (row.expiresAt ?? new Date(now)).getTime() };
    case "public-links-off":
      return { state: "not-allowed", organizationName };
    case "not-allowed":
    case "link-unknown":
    case "level-unknown":
      return { state: "unknown" };
    default:
      return access.reason satisfies never;
  }
};

/**
 * A link's use from the viewer page (ADR 0068): what it opens, and for a link that's still good,
 * its first use's audit entry once (`preview.link_first_used`) and its `lastUsedAt`.
 */
export const usePreviewLink = async (deps: Pick<SharingDeps, "db" | "audit" | "clock" | "logger">, input: Parameters<UsePreviewLink>[1]): ReturnType<UsePreviewLink> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const resolved = await resolvePreviewLinkInTx(tx, input.token, now);
    if (resolved.state !== "active") {
      return resolved;
    }
    const link = await tx.previewLink.findUniqueOrThrow({ where: { id: resolved.linkId }, select: { organizationId: true, projectId: true } });
    // The first use, once: whoever sets `firstUsedAt` writes the entry.
    const first = await tx.previewLink.updateMany({ where: { id: resolved.linkId, firstUsedAt: null }, data: { firstUsedAt: new Date(now), lastUsedAt: new Date(now) } });
    if (first.count === 1) {
      await deps.audit.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(link.organizationId),
        projectId: projectIdSchema.parse(link.projectId),
        actor: { kind: "system", id: null },
        action: "preview.link_first_used",
        entity: "task",
        entityId: resolved.taskId,
        data: { linkId: resolved.linkId, key: resolved.key },
      });
      deps.logger?.info("preview.link-first-used", { taskId: resolved.taskId, linkId: resolved.linkId });
    } else {
      await tx.previewLink.update({ where: { id: resolved.linkId }, data: { lastUsedAt: new Date(now) } });
    }
    return resolved;
  });
usePreviewLink satisfies UsePreviewLink;

// ---------- the organization's switch ----------

/**
 * An organization admin allows public preview links, or stops them, with the audit entry. Off, a
 * public link opens nothing (`previewAccess` reads the switch on each use), and its open views close
 * at once; on again, the public links not revoked work again.
 */
export const setPublicPreviewLinks = async (deps: SharingDeps, scope: MemberScope, input: Parameters<SetPublicPreviewLinks>[2]): ReturnType<SetPublicPreviewLinks> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an organization admin allows public preview links" };
  }
  return deps.db.$transaction(async (tx) => {
    if ((await publicLinksInTx(tx, organizationId)) === input.enabled) {
      return { ok: true, enabled: input.enabled, viewsClosed: 0 };
    }
    await tx.organizationSetting.upsert({ where: { organizationId }, create: { organizationId, publicPreviewLinks: input.enabled }, update: { publicPreviewLinks: input.enabled } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "organization.public_preview_links_changed",
      entity: "organization",
      entityId: organizationId,
      data: { enabled: input.enabled },
    });
    let viewsClosed = 0;
    if (!input.enabled) {
      const views = await tx.previewView.findMany({ where: { organizationId, state: { in: [...OPEN_VIEW_STATES] }, link: { kind: "public" } }, select: { id: true } });
      for (const view of views) {
        viewsClosed += await closeOne(deps, tx, previewViewIdSchema.parse(view.id), "link-ended");
      }
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    deps.logger?.info("organization.public-preview-links", { organizationId, enabled: input.enabled, viewsClosed });
    return { ok: true, enabled: input.enabled, viewsClosed };
  });
};
setPublicPreviewLinks satisfies SetPublicPreviewLinks;

// ---------- the pane's list ----------

const boxStateOf = (box: PreviewBox | null, hadBox: boolean): "running" | "starting" | "stopped" | "none" => {
  if (box === null) {
    return hadBox ? "stopped" : "none";
  }
  if (box.purpose === "app" && !box.leaseAccepted) {
    return "starting";
  }
  switch (box.boxState) {
    case "ready":
    case "idle":
      return "running";
    case "creating":
    case "preparing":
    case "stopped":
      return "starting";
    case "failed":
    case "released":
      return "stopped";
    default:
      return box.boxState satisfies never;
  }
};

/**
 * What the pane shows for a task (ADR 0068), for a member who can open it: the previews, primary
 * first, each with who may open it and how many watch it; the box's state and what it can show,
 * or why not; and the latest screenshot for a stopped pane. A named person can't open the task,
 * so this refuses them, as every other read of the task does.
 */
export const listPreviews = async (deps: Pick<SharingDeps, "db" | "clock" | "settings">, scope: MemberScope, input: Parameters<ListPreviews>[2]): ReturnType<ListPreviews> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const task = await taskForMemberInTx(tx, scope, input.taskId);
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    const box = await previewBoxInTx(tx, task.organizationId, task.id);
    const items = await previewsOfTaskInTx(tx, task, box);
    const keys = items.map((item) => item.key);
    const levels = await tx.previewAccess.findMany({
      where: { taskId: task.id, organizationId: task.organizationId, key: { in: keys } },
      select: { key: true, level: true, members: { select: { memberId: true }, orderBy: { createdAt: "asc" } } },
    });
    const links = await tx.previewLink.findMany({
      where: { taskId: task.id, organizationId: task.organizationId, key: { in: keys } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        key: true,
        kind: true,
        allowInput: true,
        expiresAt: true,
        createdByMemberId: true,
        createdAt: true,
        firstUsedAt: true,
        lastUsedAt: true,
        revokedAt: true,
        revokedByMemberId: true,
        _count: { select: { views: true } },
      },
    });
    const watching = await tx.previewView.groupBy({ by: ["key"], where: { taskId: task.id, organizationId: task.organizationId, state: { in: [...OPEN_VIEW_STATES] } }, _count: { _all: true } });
    const sharingOf = (key: PreviewKey): PreviewSharing => {
      const level = levels.find((row) => row.key === key);
      const views: PreviewLinkView[] = links
        .filter((link) => link.key === key)
        .slice(0, LINKS_LISTED)
        .map((link) => {
          const lifecycle = previewLinkFromRow({ expiresAt: link.expiresAt, revokedAt: link.revokedAt, revokedByMemberId: link.revokedByMemberId === null ? null : memberIdSchema.parse(link.revokedByMemberId) }, now);
          return {
            linkId: previewLinkIdSchema.parse(link.id),
            kind: link.kind,
            allowInput: link.allowInput,
            state: lifecycle.state,
            expiresAt: link.expiresAt?.getTime() ?? null,
            createdByMemberId: memberIdSchema.parse(link.createdByMemberId),
            createdAt: link.createdAt.getTime(),
            firstUsedAt: link.firstUsedAt?.getTime() ?? null,
            lastUsedAt: link.lastUsedAt?.getTime() ?? null,
            revokedAt: link.revokedAt?.getTime() ?? null,
            opens: link._count.views,
          };
        });
      return {
        level: level?.level ?? "members",
        memberIds: level?.level === "named" ? level.members.map((member) => memberIdSchema.parse(member.memberId)) : [],
        links: views,
      };
    };
    const hadBox = box !== null || (await tx.box.count({ where: { taskId: task.id, organizationId: task.organizationId } })) > 0;
    const can = box === null ? null : boxPreviewability(box);
    const screenshot = await tx.taskAttachment.findFirst({
      where: { taskId: task.id, organizationId: task.organizationId, kind: "screenshot" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { attachmentId: true, blobId: true },
    });
    return {
      ok: true,
      previews: items.map((item) => ({ ...item, sharing: sharingOf(item.key), watchers: watching.find((row) => row.key === item.key)?._count._all ?? 0 })),
      box: boxStateOf(box, hadBox),
      can:
        can === null
          ? { stream: false, tunnel: false, native: false }
          : can.previewable
            ? { stream: can.stream, tunnel: can.tunnel, native: can.tunnel && deps.settings.domain !== null }
            : { refused: can.reason },
      carrier: box?.carrier ?? null,
      lastScreenshot: screenshot === null ? null : { attachmentId: attachmentIdSchema.parse(screenshot.attachmentId), blobId: blobIdSchema.parse(screenshot.blobId) },
      publicLinks: await publicLinksInTx(tx, task.organizationId),
      linkMaxDays: deps.settings.linkMaxDays,
    };
  });
listPreviews satisfies ListPreviews;

// ---------- a member's screenshot from the pane ----------

/** Core doesn't know a box's own ports, which it picks when it starts: the box checks them (ticket 18). */
const UNKNOWN_RESERVED: ReservedPorts = { "key-proxy": null, "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };

/**
 * "Take a screenshot" in the pane (F-121): `screenshot.take` to the box's runner, for a member who
 * can open the task, of one of its previews. The picture comes back as the runner's
 * `attachment.added` with the same request ID (ticket 15's ingest).
 */
export const takeMemberScreenshot = async (
  deps: Pick<SharingDeps, "db" | "outbox" | "clock" | "logger">,
  scope: MemberScope,
  input: Parameters<TakeMemberScreenshot>[2],
): ReturnType<TakeMemberScreenshot> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const task = await taskForMemberInTx(tx, scope, input.taskId);
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    const box = await previewBoxInTx(tx, task.organizationId, task.id);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null) {
      return { ok: false, error: "no-box", message: "This task's box isn't running: start the app to take a screenshot" };
    }
    const can = boxPreviewability(box);
    if (!can.previewable) {
      return { ok: false, error: can.reason, message: previewRefusalWords(can.reason) };
    }
    if (!can.stream || !commandKindSupportedOn("screenshot.take", box.minor, box.carrier)) {
      return { ok: false, error: "runner-cannot-preview", message: previewRefusalWords("runner-cannot-preview") };
    }
    const targets = await taskPreviewTargetsInTx(tx, task, box.executor);
    const target = targets.find((item) => item.key === input.key);
    if (target === undefined || !mayReach(target.port, targets, UNKNOWN_RESERVED).ok) {
      return { ok: false, error: "port-not-allowed", message: "This isn't one of the task's previews" };
    }
    const requestId = screenshotRequestIdSchema.parse(randomUUID());
    await deps.outbox.enqueueInTx(tx, task.organizationId, box.runnerId, {
      kind: "screenshot.take",
      body: { sessionId, requestId, key: input.key, path: input.path, width: input.width, memberId: scope.memberId },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId: task.id, projectId: task.projectId },
    });
    deps.logger?.info("preview.screenshot-asked", { taskId: task.id, key: input.key, requestId, width: input.width });
    return { ok: true, requestId };
  });
takeMemberScreenshot satisfies TakeMemberScreenshot;
