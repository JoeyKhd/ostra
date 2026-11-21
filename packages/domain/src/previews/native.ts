import { randomBytes } from "node:crypto";

import type { Db, Tx } from "@ostra/db";
import {
  commandKindSupportedOn,
  memberIdSchema,
  organizationIdSchema,
  previewIdSchema,
  previewKeySchema,
  previewLinkIdSchema,
  previewRefusalWords,
  previewViewIdSchema,
  projectIdSchema,
  runnerLimits,
  taskIdSchema,
} from "@ostra/protocol";
import type { LoginSessionId, MemberId, OrganizationId, PreviewId, PreviewKey, PreviewViewer, PreviewViewId, ProjectId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { Clock, Ports } from "../ports.ts";
import type { PreviewSettings } from "../settings.ts";
import type { EnterNativePreview } from "../use-cases/m8-preview-signatures.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { previewAccess, previewAccessWords } from "./access.ts";
import type { PreviewAccessRefusal, PreviewLinkFacts, PreviewViewerFacts } from "./access.ts";
import { redeemPreviewCodeInTx } from "./cli-tunnel.ts";
import { PREVIEW_COOKIE_MAX_MS, PREVIEW_ENTER_PATH, previewHost, previewHostOrigin, previewOriginOf, previewRedirectPath } from "./host.ts";
import { mayReach } from "./targets.ts";
import { issuePreviewCode, previewLinkTokenHash, previewLinkTokenMatches } from "./tokens.ts";
import type { PreviewCodeViewer, PreviewCookieClaims, PreviewCookieViewer, RandomBytes } from "./tokens.ts";
import { boxPreviewability, boxWarmHold, canOpenTaskInTx, previewBoxInTx, taskPreviewTargetsInTx, UNKNOWN_RESERVED } from "./views.ts";
import type { PreviewBox } from "./views.ts";

// The native preview's rows (milestone 8, ticket 25, F-144, ADR 0068 "The native preview"):
//
// - the task's `previewId`, set at its first native preview (128 random bits, lower-case base32);
// - `enterNativePreview`, the panel's side of the handshake (ticket 26's `previews.enter`): the
//   same checks a view makes, then a one-time code bound to the member (and their panel login
//   session) or the link, the task, the port and the lease epoch, and the preview host's
//   `/.ostra/enter?code=…`;
// - `redeemNativeEntry`, core's side: the code's one use on the host it names, and how long the
//   cookie may live (12 hours at most, and no longer than the session or the link);
// - `nativeViewFor`, the check core makes on each new connection and every 5 minutes: the viewer
//   still may (a member who can open the task, in a session still signed in; a link that allows
//   input), the task's live box and its lease, a runner that can tunnel, the port one of the task's
//   previews. It answers the open `native` view of that viewer on that lease, or opens one (its row,
//   its `preview.opened` event and `preview.open` in `tunnel` mode), so a reopen's new lease is
//   picked up by the same preview host.
//
// The bytes are core's (`apps/core/src/previews/native.ts`). Never logged: a code, a cookie.

/** How often core checks a preview cookie's viewer and lease again while it's in use (ADR 0068). */
export const NATIVE_RECHECK_MS = 5 * 60_000;

// ---------- the task's preview ID ----------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new preview ID: 128 random bits in lower-case base32, 26 characters (ADR 0068). It's no secret. */
export const newPreviewId = (random: RandomBytes = randomBytes): PreviewId => {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of random(16)) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32.charAt((value << (5 - bits)) & 31);
  }
  return previewIdSchema.parse(out);
};

/** The task's preview ID, set now when it has none: it belongs to the task, so its hosts outlive a box. */
export const taskPreviewIdInTx = async (tx: Tx, organizationId: OrganizationId, taskId: TaskId, random?: RandomBytes): Promise<PreviewId | null> => {
  const task = await tx.task.findFirst({ where: { id: taskId, organizationId }, select: { previewId: true } });
  if (task === null) {
    return null;
  }
  if (task.previewId === null) {
    await tx.task.updateMany({ where: { id: taskId, organizationId, previewId: null }, data: { previewId: newPreviewId(random) } });
  }
  const set = await tx.task.findFirst({ where: { id: taskId, organizationId }, select: { previewId: true } });
  const previewId = set?.previewId ?? null;
  return previewId === null ? null : previewIdSchema.parse(previewId);
};

// ---------- shared reads ----------

const linkSelect = { id: true, taskId: true, key: true, kind: true, allowInput: true, expiresAt: true, revokedAt: true, revokedByMemberId: true, organizationId: true } as const;

const linkFactsOf = (row: {
  readonly id: string;
  readonly taskId: string;
  readonly key: string;
  readonly kind: PreviewLinkFacts["kind"];
  readonly allowInput: boolean;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedByMemberId: string | null;
}): PreviewLinkFacts => ({
  linkId: previewLinkIdSchema.parse(row.id),
  taskId: taskIdSchema.parse(row.taskId),
  key: previewKeySchema.parse(row.key),
  kind: row.kind,
  allowInput: row.allowInput,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  revokedByMemberId: row.revokedByMemberId === null ? null : memberIdSchema.parse(row.revokedByMemberId),
});

const levelInTx = async (tx: Tx, taskId: TaskId, key: PreviewKey) => {
  const row = await tx.previewAccess.findUnique({ where: { taskId_key: { taskId, key } }, select: { level: true, members: { select: { memberId: true } } } });
  return row === null ? null : { level: row.level, memberIds: row.members.map((member) => memberIdSchema.parse(member.memberId)) };
};

const publicLinksInTx = async (tx: Tx, organizationId: OrganizationId): Promise<boolean> =>
  (await tx.organizationSetting.findUnique({ where: { organizationId }, select: { publicPreviewLinks: true } }))?.publicPreviewLinks ?? false;

/** A panel login session still signed in, for this member's account: its deadline, or `null`. */
const loginSessionUntilInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId, loginSessionId: LoginSessionId, now: number): Promise<number | null> => {
  const member = await tx.member.findFirst({ where: { id: memberId, organizationId, state: "active" }, select: { userId: true } });
  const session = await tx.authSession.findUnique({ where: { id: loginSessionId }, select: { userId: true, expiresAt: true } });
  if (member === null || session?.userId !== member.userId || session.expiresAt.getTime() <= now) {
    return null;
  }
  return session.expiresAt.getTime();
};

/** Whether the box's runner can carry a tunnel now: minor 7 over a WebSocket, and it says so. Never over the HTTP carrier (ADR 0068). */
const canTunnel = (box: PreviewBox): boolean => {
  const can = boxPreviewability(box);
  return can.previewable && can.tunnel && commandKindSupportedOn("preview.open", box.minor, box.carrier);
};

// ---------- the panel's side: a one-time code (ticket 26's `previews.enter`) ----------

type EnterResult = Awaited<ReturnType<EnterNativePreview>>;
type EnterError = Extract<EnterResult, { readonly ok: false }>["error"];

const refusedEnter = (error: EnterError, message: string): EnterResult => ({ ok: false, error, message });

/** What `enterNativePreview` takes beyond its signature's: a fixed random source in tests. */
export type EnterNativePreviewDeps = Parameters<EnterNativePreview>[0] & { readonly random?: RandomBytes };

/** The words for a runner that reaches the server over the HTTP carrier only, or can't tunnel. */
export const RUNNER_CANNOT_TUNNEL_WORDS = "This task's runner reaches the server over HTTP only, so its app can't open in your browser: use the browser view.";

/**
 * The native preview's handshake, the panel's half (ADR 0068): the viewer may open the preview and
 * give input (a member who can open the task, or a link that allows input; a watch-only viewer gets
 * no code); the preview domain is set; the task has a live box short of the warm cap, on a runner
 * that can tunnel; the key is one of its previews, and `mayReach` allows its port. Then a one-time
 * code (single use, 60 s, bound to the member and their login session or the link, the task, the
 * port and the lease epoch), stored as its hash, and the preview host's URL that redeems it.
 */
export const enterNativePreview = async (deps: EnterNativePreviewDeps, opener: Parameters<EnterNativePreview>[1], input: Parameters<EnterNativePreview>[2]): Promise<EnterResult> => {
  const domain = deps.settings.domain;
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx): Promise<EnterResult> => {
    let organizationId: OrganizationId;
    let link: PreviewLinkFacts | null = null;
    switch (opener.kind) {
      case "member":
        organizationId = opener.scope.organizationId;
        break;
      case "link": {
        const hash = previewLinkTokenHash(opener.token);
        const row = hash === null ? null : await tx.previewLink.findUnique({ where: { tokenHash: hash }, select: { ...linkSelect, tokenHash: true } });
        if (row === null || !previewLinkTokenMatches(opener.token, row.tokenHash)) {
          return refusedEnter("link-unknown", previewAccessWords("link-unknown"));
        }
        organizationId = organizationIdSchema.parse(row.organizationId);
        link = linkFactsOf(row);
        break;
      }
      default:
        return opener satisfies never;
    }
    const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
    if (task === null) {
      return link === null ? refusedEnter("not-found", "No such task") : refusedEnter("link-unknown", previewAccessWords("link-unknown"));
    }
    const taskId = taskIdSchema.parse(task.id);
    const projectId = projectIdSchema.parse(task.projectId);
    let viewer: PreviewViewerFacts;
    if (opener.kind === "member") {
      viewer = { kind: "member", memberId: opener.scope.memberId, canOpenTask: requireProjectAccess(opener.scope, { id: projectId, organizationId, access: task.project.access }, "read").ok };
    } else if (link !== null) {
      viewer = { kind: "link", link };
    } else {
      return refusedEnter("link-unknown", previewAccessWords("link-unknown"));
    }
    const access = previewAccess(viewer, { taskId, key: input.key }, await levelInTx(tx, taskId, input.key), { publicPreviewLinks: await publicLinksInTx(tx, organizationId) }, now);
    if (!access.allowed) {
      return refusedEnter(access.reason, previewAccessWords(access.reason));
    }
    if (!access.input) {
      return refusedEnter("watch-only", "This preview is shared with you to watch: it opens in the browser view");
    }
    // After the viewer's access (ticket 26): with no preview domain, someone who can't open the task
    // still learns nothing of it, as with one.
    if (domain === null) {
      return refusedEnter("no-preview-domain", "This install has no preview domain: the preview shows in the browser view");
    }
    const box = await previewBoxInTx(tx, organizationId, taskId);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null) {
      return refusedEnter("no-box", "This task's box isn't running: start the app to see it");
    }
    const can = boxPreviewability(box);
    if (!can.previewable) {
      return refusedEnter(can.reason, previewRefusalWords(can.reason));
    }
    if (!canTunnel(box)) {
      return refusedEnter("runner-cannot-tunnel", RUNNER_CANNOT_TUNNEL_WORDS);
    }
    const hold = boxWarmHold(box, now, deps.settings.warmMinutes);
    if (!hold.hold && hold.reason === "past-the-cap") {
      return refusedEnter("no-box", "This task's box is idling out: start the app to see it again");
    }
    const targets = await taskPreviewTargetsInTx(tx, { id: taskId, organizationId, projectId }, box.executor);
    const target = targets.find((item) => item.key === input.key);
    if (target === undefined || !mayReach(target.port, targets, UNKNOWN_RESERVED).ok) {
      return refusedEnter("port-not-allowed", "This isn't one of the task's previews");
    }
    const previewId = await taskPreviewIdInTx(tx, organizationId, taskId, deps.random);
    if (previewId === null) {
      return refusedEnter("not-found", "No such task");
    }
    const codeViewer: PreviewCodeViewer = viewer.kind === "member" ? { kind: "member", memberId: viewer.memberId } : { kind: "link", linkId: viewer.link.linkId };
    const issued = issuePreviewCode({ kind: "enter", taskId, key: target.key, port: target.port, leaseEpoch: box.leaseEpoch, viewer: codeViewer }, now, deps.random);
    if (!issued.ok) {
      return refusedEnter("not-found", "No such task");
    }
    await tx.previewCode.create({
      data: {
        organizationId,
        projectId,
        kind: "enter",
        codeHash: issued.row.codeHash,
        taskId,
        key: issued.row.key,
        port: issued.row.port,
        memberId: issued.row.memberId,
        linkId: issued.row.linkId,
        leaseEpoch: issued.row.leaseEpoch,
        expiresAt: issued.row.expiresAt,
        authSessionId: opener.kind === "member" ? opener.loginSessionId : null,
      },
    });
    const origin = previewHostOrigin(previewHost(target.port, previewId, domain), previewOriginOf(deps.corePublicUrl));
    const path = previewRedirectPath(input.path ?? target.path);
    return { ok: true, url: `${origin}${PREVIEW_ENTER_PATH}?code=${encodeURIComponent(issued.code)}&path=${encodeURIComponent(path)}`, origin, previewId, expiresAt: issued.row.expiresAt.getTime() };
  });
};
enterNativePreview satisfies EnterNativePreview;

// ---------- core's side: the code's one use ----------

/** What a handshake grants: the claims of the cookie core sets, without its random grant ID. */
export type NativeEntry = Omit<PreviewCookieClaims, "grantId">;

export type NativeEntryResult =
  | { readonly ok: true; readonly entry: NativeEntry }
  /** `reason` is for the log, never the code. */
  | { readonly ok: false; readonly reason: "no-preview" | "unknown" | "used" | "expired" | "wrong-kind" | "wrong-binding" | "stale-lease" | "session-ended" | "link-ended" };

/**
 * A handshake's code on the preview host it names (ADR 0068): the host's preview ID is a task's,
 * and the code is that task's and port's, unused, under 60 s old, for the task's current lease
 * epoch (`redeemPreviewCodeInTx`, which marks it used in the same transaction). The cookie it
 * grants lasts 12 hours at most, and no longer than the member's panel session or the link.
 */
export const redeemNativeEntry = async (deps: { readonly db: Db; readonly clock: Clock }, input: { readonly previewId: PreviewId; readonly port: number; readonly code: string }): Promise<NativeEntryResult> => {
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx): Promise<NativeEntryResult> => {
    const task = await tx.task.findUnique({ where: { previewId: input.previewId }, select: { id: true, organizationId: true } });
    if (task === null) {
      return { ok: false, reason: "no-preview" };
    }
    const taskId = taskIdSchema.parse(task.id);
    const redeemed = await redeemPreviewCodeInTx(tx, { code: input.code, kind: "enter", taskId, port: input.port }, now);
    if (!redeemed.ok) {
      return { ok: false, reason: redeemed.reason };
    }
    if (redeemed.organizationId !== organizationIdSchema.parse(task.organizationId)) {
      return { ok: false, reason: "unknown" };
    }
    let until = now + PREVIEW_COOKIE_MAX_MS;
    let viewer: PreviewCookieViewer;
    switch (redeemed.viewer.kind) {
      case "member": {
        const loginSessionId = redeemed.loginSessionId;
        const session = loginSessionId === null ? null : await loginSessionUntilInTx(tx, redeemed.organizationId, redeemed.viewer.memberId, loginSessionId, now);
        if (loginSessionId === null || session === null) {
          return { ok: false, reason: "session-ended" };
        }
        until = Math.min(until, session);
        viewer = { kind: "member", memberId: redeemed.viewer.memberId, loginSessionId };
        break;
      }
      case "link": {
        const row = await tx.previewLink.findFirst({ where: { id: redeemed.viewer.linkId, organizationId: redeemed.organizationId }, select: { expiresAt: true, revokedAt: true } });
        if (row?.revokedAt !== null || (row.expiresAt !== null && row.expiresAt.getTime() <= now)) {
          return { ok: false, reason: "link-ended" };
        }
        until = Math.min(until, row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY);
        viewer = { kind: "link", linkId: redeemed.viewer.linkId };
        break;
      }
      default:
        return redeemed.viewer satisfies never;
    }
    return { ok: true, entry: { organizationId: redeemed.organizationId, taskId: redeemed.taskId, key: redeemed.key, port: redeemed.port, viewer, expiresAt: until } };
  });
};

// ---------- core's check: the cookie's view ----------

/** What core needs to proxy a cookie's requests: its view, and how the requests are rewritten. */
export type NativeView = {
  readonly viewId: PreviewViewId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly port: number;
  readonly leaseEpoch: number;
  /** The app process's `hostRewrite` (Q304); a service and an announced port are rewritten. */
  readonly hostRewrite: boolean;
  /** The viewer came by a link: people outside the project, whose WebSocket upgrades keep the browser's `Origin`. */
  readonly outsideLink: boolean;
  /** This check opened the view: `preview.open` went to the box's runner. */
  readonly opened: boolean;
};

/** Why a cookie opens nothing now: `gone` ends the cookie; `not-running` waits for the app. */
export type NativeViewRefusal =
  | { readonly ok: false; readonly kind: "gone"; readonly reason: "no-preview" | "session-ended" | "watch-only" | PreviewAccessRefusal }
  | { readonly ok: false; readonly kind: "not-running"; readonly reason: "no-box" | "past-the-cap" | "runner-cannot-tunnel" }
  | { readonly ok: false; readonly kind: "not-a-preview"; readonly reason: "port-not-allowed" };

export type NativeViewResult = { readonly ok: true; readonly view: NativeView } | NativeViewRefusal;

/** What `nativeViewFor` takes: the view's writes, and the warm cap. */
export type NativeViewDeps = Pick<Ports, "outbox" | "notices" | "clock"> & { readonly db: Db; readonly settings: Pick<PreviewSettings, "warmMinutes"> };

const gone = (reason: Extract<NativeViewRefusal, { readonly kind: "gone" }>["reason"]): NativeViewRefusal => ({ ok: false, kind: "gone", reason });
const notRunning = (reason: Extract<NativeViewRefusal, { readonly kind: "not-running" }>["reason"]): NativeViewRefusal => ({ ok: false, kind: "not-running", reason });

/**
 * The check core makes for a preview cookie on each new connection and every 5 minutes (ADR 0068):
 * the host's preview ID is the cookie's task's; the viewer still may open the preview and give
 * input (a member who can open the task, in a panel session still signed in; a link neither
 * revoked nor expired, that allows input, and a public one only where public links are allowed);
 * the task has a live box short of the warm cap, on a runner that can tunnel; the cookie's port is
 * one of the task's previews and `mayReach` allows it. Then the viewer's open `native` view on the
 * box's lease, or a new one: its row (`opening`), its `preview.opened` event and `preview.open` in
 * `tunnel` mode to the box's runner, in one transaction.
 */
export const nativeViewFor = async (deps: NativeViewDeps, claims: Pick<PreviewCookieClaims, "organizationId" | "taskId" | "key" | "port" | "viewer">, previewId: PreviewId): Promise<NativeViewResult> => {
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx): Promise<NativeViewResult> => {
    const { organizationId, taskId } = claims;
    const task = await tx.task.findFirst({ where: { id: taskId, organizationId }, select: { previewId: true, projectId: true } });
    if (task?.previewId !== previewId) {
      return gone("no-preview");
    }
    const projectId = projectIdSchema.parse(task.projectId);
    let viewer: PreviewViewerFacts;
    switch (claims.viewer.kind) {
      case "member": {
        if ((await loginSessionUntilInTx(tx, organizationId, claims.viewer.memberId, claims.viewer.loginSessionId, now)) === null) {
          return gone("session-ended");
        }
        viewer = { kind: "member", memberId: claims.viewer.memberId, canOpenTask: await canOpenTaskInTx(tx, organizationId, claims.viewer.memberId, projectId) };
        break;
      }
      case "link": {
        const row = await tx.previewLink.findFirst({ where: { id: claims.viewer.linkId, organizationId }, select: linkSelect });
        if (row === null) {
          return gone("link-unknown");
        }
        viewer = { kind: "link", link: linkFactsOf(row) };
        break;
      }
      default:
        return claims.viewer satisfies never;
    }
    const access = previewAccess(viewer, { taskId, key: claims.key }, await levelInTx(tx, taskId, claims.key), { publicPreviewLinks: await publicLinksInTx(tx, organizationId) }, now);
    if (!access.allowed) {
      return gone(access.reason);
    }
    if (!access.input) {
      return gone("watch-only");
    }
    const box = await previewBoxInTx(tx, organizationId, taskId);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null) {
      return notRunning("no-box");
    }
    if (!canTunnel(box)) {
      return notRunning("runner-cannot-tunnel");
    }
    const hold = boxWarmHold(box, now, deps.settings.warmMinutes);
    if (!hold.hold && hold.reason === "past-the-cap") {
      return notRunning("past-the-cap");
    }
    const targets = await taskPreviewTargetsInTx(tx, { id: taskId, organizationId, projectId }, box.executor);
    const target = targets.find((item) => item.key === claims.key && item.port === claims.port);
    if (target === undefined || !mayReach(target.port, targets, UNKNOWN_RESERVED).ok) {
      return { ok: false, kind: "not-a-preview", reason: "port-not-allowed" };
    }
    const process = "process" in target.target ? await tx.appProcess.findFirst({ where: { organizationId, projectId, name: target.target.process }, select: { hostRewrite: true } }) : null;
    const by: PreviewViewer = claims.viewer.kind === "member" ? { kind: "member", memberId: claims.viewer.memberId } : { kind: "link", linkId: claims.viewer.linkId };
    const base = {
      organizationId,
      projectId,
      taskId,
      key: claims.key,
      port: target.port,
      leaseEpoch: box.leaseEpoch,
      hostRewrite: process?.hostRewrite ?? true,
      outsideLink: by.kind === "link",
    };
    const existing = await tx.previewView.findFirst({
      where: {
        taskId,
        organizationId,
        key: claims.key,
        mode: "native",
        state: { not: "closed" },
        leaseId: box.leaseId,
        ...(by.kind === "member" ? { openedByMemberId: by.memberId } : { linkId: by.linkId }),
      },
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (existing !== null) {
      return { ok: true, view: { ...base, viewId: previewViewIdSchema.parse(existing.id), opened: false } };
    }
    const created = await tx.previewView.create({
      data: {
        organizationId,
        projectId,
        taskId,
        key: claims.key,
        mode: "native",
        openedByMemberId: by.kind === "member" ? by.memberId : null,
        linkId: by.kind === "link" ? by.linkId : null,
        leaseId: box.leaseId,
        leaseEpoch: box.leaseEpoch,
        state: "opening",
        openedAt: new Date(now),
        lastHeartbeatAt: new Date(now),
      },
      select: { id: true },
    });
    const viewId = previewViewIdSchema.parse(created.id);
    await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId, at: now, event: { kind: "preview.opened", viewId, key: claims.key, mode: "native", by } });
    await deps.outbox.enqueueInTx(tx, organizationId, box.runnerId, {
      kind: "preview.open",
      body: { sessionId, viewId, key: claims.key, mode: "tunnel", viewport: null },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId, projectId },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    return { ok: true, view: { ...base, viewId, opened: true } };
  });
};
