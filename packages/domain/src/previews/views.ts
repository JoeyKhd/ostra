import type { Db, DbEnum, Tx } from "@ostra/db";
import {
  boxIdSchema,
  commandKindSupportedOn,
  isPreviewable,
  leaseEpochSchema,
  memberIdSchema,
  organizationIdSchema,
  previewOpenBodySchema,
  previewOpenRefusalOf,
  previewKeySchema,
  previewLinkIdSchema,
  previewRefusalWords,
  previewSupportSchema,
  previewViewIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
  viewportPresetSizes,
} from "@ostra/protocol";
import type {
  BoxId,
  CommandKind,
  CommandResult,
  ExecutorKind,
  LeaseEpoch,
  MemberId,
  OrganizationId,
  PanelPreviewInputBody,
  PreviewCarrier,
  PreviewKey,
  PreviewLinkId,
  PreviewListItem,
  PreviewOpenRefusal,
  PreviewSupport,
  PreviewViewer,
  PreviewViewId,
  Previewability,
  ProjectId,
  ReservedPorts,
  RunnerId,
  SessionId,
  TaskId,
} from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import { transitionPreviewView } from "../lifecycles/m8-previews.ts";
import type { PreviewViewCloseReason, PreviewViewLifecycle } from "../lifecycles/m8-previews.ts";
import type { Ports } from "../ports.ts";
import type { PreviewSettings } from "../settings.ts";
import { loadMemberScopeInTx } from "../starts/bulk.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import type { CloseView, HeartbeatView, OpenView, ViewOpener } from "../use-cases/m8-preview-signatures.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { previewAccess, previewAccessWords } from "./access.ts";
import type { PreviewAccessRefusal, PreviewLevelRow, PreviewLinkFacts, PreviewViewerFacts } from "./access.ts";
import { mayReach, previewTargets } from "./targets.ts";
import { PANEL_PREVIEW_TOKEN_TTL_MS, previewLinkTokenHash, previewLinkTokenMatches } from "./tokens.ts";
import type { PanelPreviewTokens, PreviewCodeViewer } from "./tokens.ts";
import { PREVIEW_WATCHED_WITHIN_MS, warmHold } from "./warm.ts";
import type { WarmHold } from "./warm.ts";

// A preview's views (milestone 8, ticket 19, F-141, F-142, ADR 0068): opening one (the access check,
// the row, its event and `preview.open` to the box's runner, in one transaction), closing one, the
// heartbeat that keeps a watched box warm, the sweep that closes what nobody watches or what passed
// the warm cap, and the check core makes before a viewer's input reaches the box. The bytes are
// core's (`apps/core/src/previews/`): this is the rows. Never logged: a link's token, typed text.

/** The ports a view's writes take. */
export type ViewPorts = Pick<Ports, "outbox" | "notices" | "clock"> & { readonly db: Db };

/** What `openView` takes: the ports, the warm cap, and the panel's token signer (under the secrets key). */
export type OpenViewDeps = ViewPorts & { readonly settings: Pick<PreviewSettings, "warmMinutes">; readonly panelTokens: PanelPreviewTokens };

/** A view's sweep also reads the warm cap. */
export type ViewSweepDeps = ViewPorts & { readonly settings: Pick<PreviewSettings, "warmMinutes"> };

/** How long a view lives without a heartbeat: the same 2 minutes a box counts as watched (ADR 0068). */
export const PREVIEW_VIEW_HEARTBEAT_LAPSE_MS = PREVIEW_WATCHED_WITHIN_MS;

// ---------- the panel's routes on core ----------

/** Core's routes for the panel's stream and input of one view (ADR 0068), with the panel's token. */
export const panelPreviewPaths = {
  stream: (viewId: PreviewViewId): string => `/panel/v1/previews/${encodeURIComponent(viewId)}/stream`,
  input: (viewId: PreviewViewId): string => `/panel/v1/previews/${encodeURIComponent(viewId)}/input`,
} as const;

const panelPathPattern = /^\/panel\/v1\/previews\/([^/]{1,64})\/(stream|input)$/;

/** A panel preview route's view and kind, or `null` for any other path. */
export const parsePanelPreviewPath = (pathname: string): { readonly viewId: PreviewViewId; readonly route: "stream" | "input" } | null => {
  const found = panelPathPattern.exec(pathname);
  if (found === null) {
    return null;
  }
  let raw: string;
  try {
    raw = decodeURIComponent(found[1] ?? "");
  } catch {
    return null;
  }
  const viewId = previewViewIdSchema.safeParse(raw);
  const route = found[2] === "stream" ? "stream" : found[2] === "input" ? "input" : null;
  return viewId.success && route !== null ? { viewId: viewId.data, route } : null;
};

// ---------- the task's box, as a view reads it ----------

/**
 * The box states that can serve a view while its lease is active. `stopped` too: a kept box the
 * dispatch resumes (ADR 0039) stays `stopped` until a turn starts in it, and an `app` lease's box
 * runs no turn.
 */
const LIVE_BOX_STATES = ["creating", "preparing", "ready", "idle", "stopped"] as const satisfies readonly DbEnum.BoxState[];

const isLive = (state: DbEnum.BoxState): boolean => LIVE_BOX_STATES.some((live) => live === state);

/** The task's live box, its lease and its runner, as a view needs them. */
export type PreviewBox = {
  readonly leaseId: string;
  readonly leaseEpoch: LeaseEpoch;
  readonly purpose: DbEnum.LeasePurpose;
  /** When the lease was accepted, or granted before that: an `app` lease's start. */
  readonly leaseStartedAt: Date;
  /** The runner accepted the lease's offer. */
  readonly leaseAccepted: boolean;
  readonly boxId: BoxId;
  readonly boxState: DbEnum.BoxState;
  readonly executor: ExecutorKind;
  readonly idleSince: Date | null;
  readonly previewWatchedAt: Date | null;
  readonly runnerId: RunnerId;
  /** The box's newest session: what its commands and events are routed by. */
  readonly sessionId: SessionId | null;
  /** The minor and carrier of the runner's connection (its last one, if it's away). */
  readonly minor: number;
  readonly carrier: PreviewCarrier;
  /** What the runner reported it can show (minor 7), or `null`. */
  readonly reported: PreviewSupport | null;
  /** The box said it has no browser (`app.browser`, available `false`). */
  readonly noBrowser: boolean;
};

const appBrowserPayloadSchema = z.looseObject({ browser: z.looseObject({ available: z.boolean() }) });

/** The task's live box, or `null` when it has none: no active lease, or a box that stopped. */
export const previewBoxInTx = async (tx: Tx, organizationId: OrganizationId, taskId: TaskId): Promise<PreviewBox | null> => {
  const lease = await tx.lease.findFirst({
    where: { taskId, organizationId, state: "active" },
    select: {
      id: true,
      epoch: true,
      purpose: true,
      grantedAt: true,
      acceptedAt: true,
      runnerId: true,
      boxId: true,
      box: { select: { state: true, executor: true, idleSince: true, previewWatchedAt: true } },
    },
  });
  if (lease === null || !isLive(lease.box.state)) {
    return null;
  }
  const runner = await tx.runner.findFirst({
    where: { id: lease.runnerId, organizationId },
    select: { minor: true, preview: true, presence: { select: { minor: true, carrier: true } } },
  });
  const session = await tx.session.findFirst({
    where: { taskId, boxId: lease.boxId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const browser = await tx.event.findFirst({
    where: { taskId, kind: "app.browser", session: { boxId: lease.boxId } },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const reported = previewSupportSchema.safeParse(runner?.preview);
  const said = appBrowserPayloadSchema.safeParse(browser?.payload);
  return {
    leaseId: lease.id,
    leaseEpoch: leaseEpochSchema.parse(lease.epoch),
    purpose: lease.purpose,
    leaseStartedAt: lease.acceptedAt ?? lease.grantedAt,
    leaseAccepted: lease.acceptedAt !== null,
    boxId: boxIdSchema.parse(lease.boxId),
    boxState: lease.box.state,
    executor: lease.box.executor,
    idleSince: lease.box.idleSince,
    previewWatchedAt: lease.box.previewWatchedAt,
    runnerId: runnerIdSchema.parse(lease.runnerId),
    sessionId: session === null ? null : sessionIdSchema.parse(session.id),
    minor: runner?.presence?.minor ?? runner?.minor ?? 0,
    carrier: runner?.presence?.carrier === "http" ? "http" : "websocket",
    reported: reported.success ? reported.data : null,
    noBrowser: said.success && !said.data.browser.available,
  };
};

/**
 * What the box can show (ADR 0068): `isPreviewable` on its runner's minor, carrier and report, and
 * no browser view for a box that said it has no browser. Fails closed.
 */
export const boxPreviewability = (box: Pick<PreviewBox, "minor" | "carrier" | "reported" | "noBrowser">): Previewability => {
  const can = isPreviewable(box.minor, box.carrier, box.reported);
  if (!can.previewable || !box.noBrowser) {
    return can;
  }
  return can.tunnel ? { ...can, stream: false } : { previewable: false, reason: "runner-cannot-preview" };
};

/** Whether the box is in a turn: it isn't idle, so the warm rule doesn't apply to it. An `app` box never is. */
const inTurn = (box: Pick<PreviewBox, "purpose" | "boxState">): boolean => box.purpose === "turn" && box.boxState !== "idle";

/**
 * The warm rule for a live box at `now` (ADR 0068, ADR 0039 amended): `hold` while someone watches
 * and the box is under `warmMinutes` past its last turn's end or its app's start. A box in a turn
 * is never past it.
 */
export const boxWarmHold = (box: Pick<PreviewBox, "purpose" | "boxState" | "idleSince" | "previewWatchedAt" | "leaseStartedAt">, now: number, warmMinutes: number): WarmHold => {
  if (inTurn(box)) {
    return { hold: true, until: Number.POSITIVE_INFINITY };
  }
  return warmHold(
    {
      previewWatchedAt: box.previewWatchedAt?.getTime() ?? null,
      lastTurnEndedAt: box.idleSince?.getTime() ?? null,
      appStartedAt: box.purpose === "app" ? box.leaseStartedAt.getTime() : null,
    },
    now,
    { warmMinutes },
  );
};

/** The task's previews, primary first, from its environment and the ports the agent announced. */
export const taskPreviewTargetsInTx = async (
  tx: Tx,
  task: { readonly id: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  executor: ExecutorKind,
): Promise<readonly PreviewListItem[]> => {
  const where = { organizationId: task.organizationId, projectId: task.projectId };
  const processes = await tx.appProcess.findMany({ where, select: { name: true, port: true, label: true, primary: true, position: true } });
  const services = await tx.service.findMany({ where, select: { name: true, port: true, previewLabel: true } });
  const announced = await tx.taskPreview.findMany({
    where: { taskId: task.id, organizationId: task.organizationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { port: true, label: true, path: true, primary: true },
  });
  return previewTargets({ processes, services, servicesRun: executor !== "host" }, announced);
};

/** Core doesn't know a box's own ports, which it picks when it starts: the box checks them (ticket 18). */
export const UNKNOWN_RESERVED: ReservedPorts = { "key-proxy": null, "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };

// ---------- who's asking ----------

const linkFactsOf = (row: {
  readonly id: string;
  readonly taskId: string;
  readonly key: string;
  readonly kind: DbEnum.PreviewLinkKind;
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

const linkSelect = { id: true, taskId: true, key: true, kind: true, allowInput: true, expiresAt: true, revokedAt: true, revokedByMemberId: true, organizationId: true } as const;

/** A preview's level below its links: no row is `members`. */
const levelInTx = async (tx: Tx, taskId: TaskId, key: PreviewKey): Promise<PreviewLevelRow | null> => {
  const row = await tx.previewAccess.findUnique({ where: { taskId_key: { taskId, key } }, select: { level: true, members: { select: { memberId: true } } } });
  return row === null ? null : { level: row.level, memberIds: row.members.map((member) => memberIdSchema.parse(member.memberId)) };
};

const publicLinksInTx = async (tx: Tx, organizationId: OrganizationId): Promise<boolean> =>
  (await tx.organizationSetting.findUnique({ where: { organizationId }, select: { publicPreviewLinks: true } }))?.publicPreviewLinks ?? false;

/** Whether the member can open the project's tasks now: an active membership, and the project's access rule (ADR 0026). */
export const canOpenTaskInTx = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId, projectId: ProjectId): Promise<boolean> => {
  const scope = await loadMemberScopeInTx(tx, organizationId, memberId);
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { access: true } });
  return scope !== null && project !== null && requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "read").ok;
};

// ---------- opening a view ----------

type OpenViewResult = Awaited<ReturnType<OpenView>>;
type OpenViewError = Extract<OpenViewResult, { readonly ok: false }>["error"];

const refusedView = (error: OpenViewError, message: string): Extract<OpenViewResult, { readonly ok: false }> => ({ ok: false, error, message });

const accessRefusal = (reason: PreviewAccessRefusal) => refusedView(reason, previewAccessWords(reason));

/** The input `openView` takes (the signature's). */
export type OpenViewInput = Parameters<OpenView>[2];

/**
 * Opens a view (ADR 0068, "Opening a view"): who asks may open this preview (`previewAccess`,
 * failing closed); the task has a live box whose runner can show it (`isPreviewable`); the key is
 * one of the task's previews (`mayReach`). Then, in one transaction, the `PreviewView` row
 * (`opening`), its `preview.opened` event, and `preview.open` to the box's runner. The answer
 * carries the panel's token for core's stream and input, good for a minute.
 */
export const openView = async (deps: OpenViewDeps, opener: ViewOpener, input: OpenViewInput): Promise<OpenViewResult> => {
  const now = deps.clock.now();
  const outcome = await deps.db.$transaction(async (tx) => {
    // Who asks: a member in their organization, or a link, by its token's hash.
    let organizationId: OrganizationId;
    let viewer: PreviewViewerFacts | null = null;
    switch (opener.kind) {
      case "member":
        organizationId = opener.scope.organizationId;
        break;
      case "link": {
        const hash = previewLinkTokenHash(opener.token);
        const row = hash === null ? null : await tx.previewLink.findUnique({ where: { tokenHash: hash }, select: { ...linkSelect, tokenHash: true } });
        if (row === null || !previewLinkTokenMatches(opener.token, row.tokenHash)) {
          return accessRefusal("link-unknown");
        }
        organizationId = organizationIdSchema.parse(row.organizationId);
        viewer = { kind: "link", link: linkFactsOf(row) };
        break;
      }
      default:
        return opener satisfies never;
    }
    const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
    if (task === null) {
      return viewer === null ? refusedView("not-found", "No such task") : accessRefusal("link-unknown");
    }
    const taskId = taskIdSchema.parse(task.id);
    const projectId = projectIdSchema.parse(task.projectId);
    if (opener.kind === "member") {
      const canOpenTask = requireProjectAccess(opener.scope, { id: projectId, organizationId, access: task.project.access }, "read").ok;
      viewer = { kind: "member", memberId: opener.scope.memberId, canOpenTask };
    }
    if (viewer === null) {
      return accessRefusal("link-unknown");
    }
    const access = previewAccess(viewer, { taskId, key: input.key }, await levelInTx(tx, taskId, input.key), { publicPreviewLinks: await publicLinksInTx(tx, organizationId) }, now);
    if (!access.allowed) {
      return accessRefusal(access.reason);
    }
    const box = await previewBoxInTx(tx, organizationId, taskId);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null) {
      return refusedView("no-box", "This task's box isn't running: start the app to see it");
    }
    const can = boxPreviewability(box);
    if (!can.previewable) {
      return refusedView(can.reason, previewRefusalWords(can.reason));
    }
    const mode = input.mode === "native" ? "tunnel" : "stream";
    if ((mode === "stream" && !can.stream) || (mode === "tunnel" && !can.tunnel) || !commandKindSupportedOn("preview.open", box.minor, box.carrier)) {
      return refusedView("runner-cannot-preview", previewRefusalWords("runner-cannot-preview"));
    }
    // Past the warm cap the box idles out (ADR 0068): a new view doesn't hold it again.
    const hold = boxWarmHold(box, now, deps.settings.warmMinutes);
    if (!hold.hold && hold.reason === "past-the-cap") {
      return refusedView("no-box", "This task's box is idling out: start the app to see it again");
    }
    const targets = await taskPreviewTargetsInTx(tx, { id: taskId, organizationId, projectId }, box.executor);
    const target = targets.find((item) => item.key === input.key);
    if (target === undefined || !mayReach(target.port, targets, UNKNOWN_RESERVED).ok) {
      return refusedView("port-not-allowed", "This isn't one of the task's previews");
    }
    const by: PreviewViewer = viewer.kind === "member" ? { kind: "member", memberId: viewer.memberId } : { kind: "link", linkId: viewer.link.linkId };
    const created = await tx.previewView.create({
      data: {
        organizationId,
        projectId,
        taskId,
        key: input.key,
        mode: input.mode,
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
    await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId, at: now, event: { kind: "preview.opened", viewId, key: input.key, mode: input.mode, by } });
    await deps.outbox.enqueueInTx(tx, organizationId, box.runnerId, {
      kind: "preview.open",
      body: { sessionId, viewId, key: input.key, mode, viewport: mode === "stream" ? (input.viewport ?? viewportPresetSizes.desktop) : null },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId, projectId },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    const codeViewer: PreviewCodeViewer = by.kind === "member" ? { kind: "member", memberId: by.memberId } : { kind: "link", linkId: by.linkId };
    return { ok: true as const, viewId, input: access.input, organizationId, viewer: codeViewer };
  });
  if (!outcome.ok) {
    return outcome;
  }
  const panelToken = deps.panelTokens.issue({ organizationId: outcome.organizationId, viewId: outcome.viewId, viewer: outcome.viewer, expiresAt: now + PANEL_PREVIEW_TOKEN_TTL_MS });
  return { ok: true, viewId: outcome.viewId, input: outcome.input, panelToken };
};
openView satisfies OpenView;

// ---------- a view's row ----------

const viewSelect = {
  id: true,
  organizationId: true,
  projectId: true,
  taskId: true,
  key: true,
  mode: true,
  openedByMemberId: true,
  linkId: true,
  leaseId: true,
  leaseEpoch: true,
  replicaUrl: true,
  state: true,
  openedAt: true,
  lastHeartbeatAt: true,
  closedAt: true,
  refusal: true,
} as const;

/** A view's row, as core and the sweep read it. */
export type PreviewViewRow = {
  readonly id: PreviewViewId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly mode: DbEnum.PreviewViewMode;
  readonly viewer: PreviewCodeViewer;
  readonly leaseId: string | null;
  readonly leaseEpoch: number;
  readonly replicaUrl: string | null;
  readonly lifecycle: PreviewViewLifecycle;
  /** Why its box refused its `preview.open`, when it did: the pane's stream ends with it. Only a closed view has one. */
  readonly refusal: PreviewOpenRefusal | null;
};

const toViewRow = (row: {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly key: string;
  readonly mode: DbEnum.PreviewViewMode;
  readonly openedByMemberId: string | null;
  readonly linkId: string | null;
  readonly leaseId: string | null;
  readonly leaseEpoch: number;
  readonly replicaUrl: string | null;
  readonly state: DbEnum.PreviewViewState;
  readonly openedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly closedAt: Date | null;
  readonly refusal: string | null;
}): PreviewViewRow => {
  const refusal = row.refusal === null ? null : previewOpenRefusalOf(row.refusal);
  const lifecycle: PreviewViewLifecycle =
    row.state === "opening"
      ? { state: "opening", since: row.openedAt.getTime() }
      : row.state === "open"
        ? { state: "open", since: row.openedAt.getTime(), lastHeartbeatAt: row.lastHeartbeatAt.getTime() }
        : // The reason isn't a column, but a box's refusal: the event and the sweep's log carry it.
          { state: "closed", at: (row.closedAt ?? row.lastHeartbeatAt).getTime(), reason: refusal === null ? "closed" : "box-refused" };
  return {
    id: previewViewIdSchema.parse(row.id),
    organizationId: organizationIdSchema.parse(row.organizationId),
    projectId: projectIdSchema.parse(row.projectId),
    taskId: taskIdSchema.parse(row.taskId),
    key: previewKeySchema.parse(row.key),
    mode: row.mode,
    // The row's check holds one or the other (`preview_view_member_or_link`).
    viewer: row.openedByMemberId !== null ? { kind: "member", memberId: memberIdSchema.parse(row.openedByMemberId) } : { kind: "link", linkId: previewLinkIdSchema.parse(row.linkId) },
    leaseId: row.leaseId,
    leaseEpoch: row.leaseEpoch,
    replicaUrl: row.replicaUrl,
    lifecycle,
    refusal,
  };
};

/** A view's row, or `null`. */
export const previewViewInTx = async (tx: Db | Tx, viewId: PreviewViewId): Promise<PreviewViewRow | null> => {
  const row = await tx.previewView.findUnique({ where: { id: viewId }, select: viewSelect });
  return row === null ? null : toViewRow(row);
};

/** The views among `viewIds` that are closed now: what a replica holding them stops relaying. */
export const closedViewIds = async (db: Db, viewIds: readonly PreviewViewId[]): Promise<ReadonlySet<PreviewViewId>> => {
  if (viewIds.length === 0) {
    return new Set();
  }
  const rows = await db.previewView.findMany({ where: { id: { in: [...viewIds] }, state: "closed" }, select: { id: true } });
  return new Set(rows.map((row) => previewViewIdSchema.parse(row.id)));
};

// ---------- the box's preview connection (core) ----------

/**
 * The box's preview connection reached a replica (ADR 0068): the view is `open`, and its presence
 * names the replica's internal address, so a replica that gets a viewer's request for it forwards
 * there. `null` when the view is closed or gone.
 */
export const markViewConnected = async (db: Db, viewId: PreviewViewId, replicaUrl: string, now: number): Promise<PreviewViewRow | null> =>
  db.$transaction(async (tx) => {
    const view = await previewViewInTx(tx, viewId);
    if (view === null || view.lifecycle.state === "closed") {
      return null;
    }
    const moved = transitionPreviewView(view.lifecycle, { type: "connected", at: now });
    await tx.previewView.update({
      where: { id: viewId },
      data: { replicaUrl, ...(moved.ok ? { state: "open", lastHeartbeatAt: new Date(now) } : {}) },
    });
    return previewViewInTx(tx, viewId);
  });

/** The box's preview connection left this replica: its presence goes, unless another replica took it since. */
export const markViewDisconnected = async (db: Db, viewId: PreviewViewId, replicaUrl: string): Promise<void> => {
  await db.previewView.updateMany({ where: { id: viewId, replicaUrl }, data: { replicaUrl: null } });
};

// ---------- closing a view ----------

/** Why core closes a view: a box's refusal carries the box's reason, which the view keeps. */
export type ViewClosing =
  | { readonly viewId: PreviewViewId; readonly reason: Exclude<PreviewViewCloseReason, "box-refused"> }
  | { readonly viewId: PreviewViewId; readonly reason: "box-refused"; readonly refusal: PreviewOpenRefusal };

/**
 * Closes a view in the caller's transaction: its row, its `preview.closed` event, and
 * `preview.close` to the box, except for a view its box refused, which the box never held.
 */
export const closeViewInTx = (
  deps: Pick<ViewPorts, "outbox" | "notices" | "clock">,
  tx: Tx,
  input: ViewClosing,
): Promise<UseCaseResult<{ readonly closed: boolean }, "not-found">> => closeInTx(deps, input.reason === "box-refused" ? null : deps.outbox, tx, input);

/** Closes a view its box refused or dropped, with the box's reason: the box holds nothing of it, so nothing goes to it. */
const closeBoxRefusedInTx = (
  deps: Pick<ViewPorts, "notices" | "clock">,
  tx: Tx,
  viewId: PreviewViewId,
  refusal: PreviewOpenRefusal,
): Promise<UseCaseResult<{ readonly closed: boolean }, "not-found">> => closeInTx(deps, null, tx, { viewId, reason: "box-refused", refusal });

/** A view's close: `outbox` sends its box `preview.close`; `null` for a box that never held it. */
const closeInTx = async (
  deps: Pick<ViewPorts, "notices" | "clock">,
  outbox: ViewPorts["outbox"] | null,
  tx: Tx,
  input: ViewClosing,
): Promise<UseCaseResult<{ readonly closed: boolean }, "not-found">> => {
  const now = deps.clock.now();
  const view = await previewViewInTx(tx, input.viewId);
  if (view === null) {
    return { ok: false, error: "not-found", message: "No such view" };
  }
  const moved = transitionPreviewView(view.lifecycle, { type: "close", at: now, reason: input.reason });
  if (!moved.ok) {
    return { ok: true, closed: false };
  }
  const refusal = input.reason === "box-refused" ? input.refusal : null;
  const closed = await tx.previewView.updateMany({ where: { id: view.id, state: { not: "closed" } }, data: { state: "closed", closedAt: new Date(now), refusal } });
  if (closed.count === 0) {
    return { ok: true, closed: false };
  }
  // A box that refused or dropped the view holds nothing of it: no `preview.close` for it.
  const lease = view.leaseId === null || outbox === null ? null : await tx.lease.findFirst({ where: { id: view.leaseId, state: "active" }, select: { runnerId: true, boxId: true } });
  const session = await tx.session.findFirst({
    where: { taskId: view.taskId, ...(lease === null ? {} : { boxId: lease.boxId }) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (session !== null) {
    const sessionId = sessionIdSchema.parse(session.id);
    await appendServerEvent(tx, { organizationId: view.organizationId, projectId: view.projectId, taskId: view.taskId, sessionId, at: now, event: { kind: "preview.closed", viewId: view.id } });
    if (lease !== null && outbox !== null) {
      await outbox.enqueueInTx(tx, view.organizationId, runnerIdSchema.parse(lease.runnerId), {
        kind: "preview.close",
        body: { sessionId, viewId: view.id },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: view.taskId, projectId: view.projectId },
      });
    }
  }
  await deps.notices.emitInTx(tx, { organizationId: view.organizationId, projectId: view.projectId, entity: "task", entityId: view.taskId });
  return { ok: true, closed: true };
};

/** One command's result, as the gateway read it back for the runner that answered it. */
export type ViewOpenResult = { readonly kind: CommandKind; readonly body: unknown; readonly result: CommandResult; readonly reason: string | null };

/**
 * The views whose `preview.open` their box refused (ADR 0068's note of 2026-11-21): each is closed
 * in the transaction that records the runner's results, with the box's reason, so it doesn't wait
 * for the sweep and the pane's stream says why. Only the answering runner's organization's views.
 */
export const closeRefusedViewsInTx = async (
  deps: Pick<ViewPorts, "outbox" | "notices" | "clock">,
  tx: Tx,
  organizationId: OrganizationId,
  results: readonly ViewOpenResult[],
): Promise<readonly { readonly viewId: PreviewViewId; readonly refusal: PreviewOpenRefusal }[]> => {
  const closed: { readonly viewId: PreviewViewId; readonly refusal: PreviewOpenRefusal }[] = [];
  for (const result of results) {
    if (result.kind !== "preview.open" || result.result !== "rejected") {
      continue;
    }
    const body = previewOpenBodySchema.safeParse(result.body);
    if (!body.success || (await tx.previewView.count({ where: { id: body.data.viewId, organizationId } })) === 0) {
      continue;
    }
    const refusal = previewOpenRefusalOf(result.reason);
    const done = await closeBoxRefusedInTx(deps, tx, body.data.viewId, refusal);
    if (done.ok && done.closed) {
      closed.push({ viewId: body.data.viewId, refusal });
    }
  }
  return closed;
};

/** A box's `preview.dropped`, as the ingest of its session's events reads it. */
export type ViewDrop = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  /** The event's lease epoch: the box's. */
  readonly leaseEpoch: LeaseEpoch;
  readonly viewId: PreviewViewId;
  readonly refusal: PreviewOpenRefusal;
};

/**
 * A view its box took and then dropped before it connected (`preview.dropped`, ADR 0068's note
 * of 2026-11-21): its app never got ready, the box has no browser, its page didn't open, or its
 * connection didn't reach core. It closes at once with the box's reason, as a refused open does,
 * in the transaction that stores the box's events. Only a view of the session's own task and
 * lease epoch: a box closes no other task's view, nor a newer lease's.
 */
export const closeDroppedViewInTx = async (deps: Pick<ViewPorts, "notices" | "clock">, tx: Tx, drop: ViewDrop): Promise<boolean> => {
  const mine = await tx.previewView.count({ where: { id: drop.viewId, organizationId: drop.organizationId, taskId: drop.taskId, leaseEpoch: drop.leaseEpoch } });
  if (mine === 0) {
    return false;
  }
  const done = await closeBoxRefusedInTx(deps, tx, drop.viewId, drop.refusal);
  return done.ok && done.closed;
};

/** Closes a view: its viewer closed it, or the sweep did. Whoever may close it is the caller's check. */
export const closeView = async (deps: ViewPorts, input: Parameters<CloseView>[1]): ReturnType<CloseView> =>
  deps.db.$transaction((tx) => closeViewInTx(deps, tx, input));
closeView satisfies CloseView;

// ---------- the heartbeat (warm while watched) ----------

/**
 * The pane's or the viewer page's heartbeat, every 30 s while it's open and visible (Q299): the
 * view's `lastHeartbeatAt` and its box's `previewWatchedAt`, which the warm rule reads. Only this
 * counts as watching: the app's own sockets, and the frames themselves, never do. A view still
 * `opening` takes none: one whose box never connects closes after 2 minutes.
 */
export const heartbeatView = async (deps: ViewPorts, input: Parameters<HeartbeatView>[1]): ReturnType<HeartbeatView> =>
  deps.db.$transaction(async (tx) => {
    const now = deps.clock.now();
    const view = await previewViewInTx(tx, input.viewId);
    if (view === null) {
      return { ok: false, error: "not-found", message: "No such view" };
    }
    const moved = transitionPreviewView(view.lifecycle, { type: "heartbeat", at: now });
    switch (view.lifecycle.state) {
      case "closed":
        return { ok: false, error: "closed", message: "This view is closed" };
      case "opening":
        return { ok: true, open: false };
      case "open":
        break;
      default:
        return view.lifecycle satisfies never;
    }
    if (moved.ok) {
      await tx.previewView.updateMany({ where: { id: view.id, state: "open" }, data: { lastHeartbeatAt: new Date(now) } });
    }
    if (view.leaseId !== null) {
      const lease = await tx.lease.findFirst({ where: { id: view.leaseId, state: "active" }, select: { boxId: true } });
      if (lease !== null) {
        await tx.box.updateMany({ where: { id: lease.boxId }, data: { previewWatchedAt: new Date(now) } });
      }
    }
    return { ok: true, open: true };
  });
heartbeatView satisfies HeartbeatView;

// ---------- a viewer's input ----------

export type ViewInputCheck =
  | {
      readonly ok: true;
      readonly view: PreviewViewRow;
      /** The box's runner and session, for `preview.input` on the HTTP carrier. */
      readonly box: { readonly runnerId: RunnerId; readonly sessionId: SessionId; readonly minor: number; readonly carrier: PreviewCarrier } | null;
    }
  | { readonly ok: false; readonly reason: "not-found" | "closed" | "watch-only" | PreviewAccessRefusal };

/**
 * Whether a viewer's input for `viewId` may reach the box (ADR 0068, Q301): the view is open and its
 * opener may give input now. The access is read again on each batch, so a link revoked or a member
 * removed stops at once. Input from a watch-only viewer (a named person, a link without input) is
 * dropped here, before it reaches the runner.
 */
export const checkViewInput = async (db: Db, viewId: PreviewViewId, now: number): Promise<ViewInputCheck> =>
  db.$transaction(async (tx) => {
    const view = await previewViewInTx(tx, viewId);
    if (view === null) {
      return { ok: false, reason: "not-found" };
    }
    if (view.lifecycle.state === "closed") {
      return { ok: false, reason: "closed" };
    }
    let viewer: PreviewViewerFacts;
    switch (view.viewer.kind) {
      case "member":
        viewer = { kind: "member", memberId: view.viewer.memberId, canOpenTask: await canOpenTaskInTx(tx, view.organizationId, view.viewer.memberId, view.projectId) };
        break;
      case "link": {
        const row = await tx.previewLink.findFirst({ where: { id: view.viewer.linkId, organizationId: view.organizationId }, select: linkSelect });
        if (row === null) {
          return { ok: false, reason: "link-unknown" };
        }
        viewer = { kind: "link", link: linkFactsOf(row) };
        break;
      }
      default:
        return view.viewer satisfies never;
    }
    const access = previewAccess(viewer, { taskId: view.taskId, key: view.key }, await levelInTx(tx, view.taskId, view.key), { publicPreviewLinks: await publicLinksInTx(tx, view.organizationId) }, now);
    if (!access.allowed) {
      return { ok: false, reason: access.reason };
    }
    if (!access.input) {
      return { ok: false, reason: "watch-only" };
    }
    const box = await previewBoxInTx(tx, view.organizationId, view.taskId);
    const sessionId = box?.sessionId ?? null;
    if (box === null || sessionId === null || box.leaseId !== view.leaseId) {
      return { ok: true, view, box: null };
    }
    return { ok: true, view, box: { runnerId: box.runnerId, sessionId, minor: box.minor, carrier: box.carrier } };
  });

/**
 * A viewer's input, or one of the pane's controls (the width preset, a path, a reload), on the
 * HTTP carrier (Q306): `preview.input` down the long poll, since there's no preview connection to
 * carry it. `false` when the runner can't take it there.
 */
export const enqueueViewInput = async (
  deps: Pick<ViewPorts, "db" | "outbox" | "clock">,
  view: PreviewViewRow,
  box: { readonly runnerId: RunnerId; readonly sessionId: SessionId; readonly minor: number; readonly carrier: PreviewCarrier },
  input: PanelPreviewInputBody,
): Promise<boolean> => {
  if (!commandKindSupportedOn("preview.input", box.minor, box.carrier)) {
    return false;
  }
  const now = deps.clock.now();
  const at = { sessionId: box.sessionId, viewId: view.id };
  await deps.db.$transaction(async (tx) => {
    await deps.outbox.enqueueInTx(tx, view.organizationId, box.runnerId, {
      kind: "preview.input",
      body: "events" in input ? { ...at, events: [...input.events] } : { ...at, control: input.control },
      notAfter: now + runnerLimits.offerTimeoutMs,
      task: { taskId: view.taskId, projectId: view.projectId },
    });
  });
  return true;
};

// ---------- the views' sweep (`preview.views-sweep`, once a minute) ----------

/** What one pass closed, by why. */
export type ViewSweepResult = Partial<Readonly<Record<PreviewViewCloseReason, number>>>;

const SWEEP_BATCH = 200;

/**
 * `preview.views-sweep` (ADR 0068): closes each view that had no heartbeat for 2 minutes, whose
 * box's lease ended, or whose link ended; and every view of a box past the warm cap, which then
 * idles out as ADR 0039 says. A box in a turn is never past it. Times come from the `Clock`.
 */
export const sweepPreviewViews = async (deps: ViewSweepDeps): Promise<ViewSweepResult> => {
  const now = deps.clock.now();
  const result: Partial<Record<PreviewViewCloseReason, number>> = {};
  const close = async (viewId: PreviewViewId, reason: Exclude<PreviewViewCloseReason, "box-refused">): Promise<void> => {
    const closed = await deps.db.$transaction((tx) => closeViewInTx(deps, tx, { viewId, reason }));
    if (closed.ok && closed.closed) {
      result[reason] = (result[reason] ?? 0) + 1;
    }
  };
  // No heartbeat for 2 minutes (an `opening` view's clock starts when it opened).
  const lapsed = await deps.db.previewView.findMany({
    where: { state: { in: ["opening", "open"] }, lastHeartbeatAt: { lt: new Date(now - PREVIEW_VIEW_HEARTBEAT_LAPSE_MS) } },
    select: { id: true },
    orderBy: { lastHeartbeatAt: "asc" },
    take: SWEEP_BATCH,
  });
  for (const row of lapsed) {
    await close(previewViewIdSchema.parse(row.id), "no-heartbeat");
  }
  // The rest of the views still open: their lease, their link and their box's warm hold.
  const open = await deps.db.previewView.findMany({
    where: { state: { in: ["opening", "open"] } },
    select: { id: true, organizationId: true, taskId: true, leaseId: true, link: { select: { kind: true, expiresAt: true, revokedAt: true } } },
    orderBy: { openedAt: "asc" },
    take: SWEEP_BATCH * 5,
  });
  const boxes = new Map<string, PreviewBox | null>();
  for (const row of open) {
    const viewId = previewViewIdSchema.parse(row.id);
    const link = row.link;
    if (link !== null && (link.revokedAt !== null || (link.expiresAt !== null && link.expiresAt.getTime() <= now))) {
      await close(viewId, "link-ended");
      continue;
    }
    const taskKey = row.taskId;
    if (!boxes.has(taskKey)) {
      boxes.set(taskKey, await deps.db.$transaction((tx) => previewBoxInTx(tx, organizationIdSchema.parse(row.organizationId), taskIdSchema.parse(row.taskId))));
    }
    const box = boxes.get(taskKey) ?? null;
    if (box?.leaseId !== row.leaseId) {
      await close(viewId, "box-gone");
      continue;
    }
    const hold = boxWarmHold(box, now, deps.settings.warmMinutes);
    if (!hold.hold && hold.reason === "past-the-cap") {
      await close(viewId, "warm-cap");
    }
  }
  return result;
};

/** `preview.codes-sweep` (daily): removes the one-time codes and CLI tickets that were used or have expired. */
export const sweepPreviewCodes = async (deps: Pick<ViewPorts, "db" | "clock">): Promise<number> => {
  const removed = await deps.db.previewCode.deleteMany({ where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date(deps.clock.now()) } }] } });
  return removed.count;
};

/** A link's or a member's ID, for a log line: never a token. */
export const viewerLogId = (viewer: PreviewCodeViewer): MemberId | PreviewLinkId => (viewer.kind === "member" ? viewer.memberId : viewer.linkId);
