import type { Db } from "@ostra/db";
import type {
  AttachmentId,
  AttachmentKind,
  AttachmentSource,
  BlobId,
  BoxBrowser,
  CliSessionId,
  DraftId,
  DraftImageId,
  EnvironmentProposalId,
  MemberId,
  PreviewCarrier,
  PreviewId,
  PreviewKey,
  PreviewLinkId,
  PreviewListItem,
  PreviewRefusalReason,
  PreviewTarget,
  PreviewViewId,
  PreviewViewport,
  ProjectId,
  ScreenshotRequestId,
  TaskId,
  TurnId,
  ViewportPreset,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { Clock, Ports } from "../ports.ts";
import type { PreviewAccessRefusal } from "../previews/access.ts";
import type { AppProcessForm, AppProcessListIssue, ScreenshotSettings } from "../previews/app-processes.ts";
import type { PanelPreviewTokens, PreviewCodeCheck } from "../previews/tokens.ts";
import type { PreviewSettings } from "../settings.ts";
import type { UseCaseResult } from "./common.ts";

// Milestone 8's preview use cases (spec section 5.4, ticket 05's list; ADR 0068): each one's input,
// result and signature, with its ports. The signature is the contract core (tickets 15, 19, 23,
// 25), the API's routers (tickets 16, 20, 26) and the tests are written against; the bodies come
// with those tickets. The pure parts have their bodies in `../previews/` and
// `../lifecycles/m8-previews.ts`. Every write is one transaction with its change notice, its audit
// entry and the jobs it sends (ADR 0011, ADR 0037, ADR 0054). Never logged: a process's command, a
// caption, a link's token, a code and a ticket.

/** What a preview use case takes: the database, the ports and the previews' settings. */
export type PreviewDeps = { readonly db: Db } & Ports & { readonly settings: PreviewSettings };

// ---------- app processes (F-140; tickets 15, 16) ----------

/**
 * A project admin saves the environment's app processes and screenshot settings, as a whole list in
 * order. A part left out is kept as it is (ticket 16: the App tab saves its processes, its
 * screenshots and a service's label apart).
 */
export type SaveAppProcesses = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: {
    readonly projectId: ProjectId;
    readonly processes?: readonly AppProcessForm[];
    readonly screenshots?: ScreenshotSettings;
    /** Each service's preview label, by name; a service left out keeps its own. */
    readonly servicePreviews?: Readonly<Record<string, string | null>>;
  },
) => Promise<
  | UseCaseResult<{ readonly saved: number }, "forbidden" | "not-found" | "invalid-input">
  /** The rules the list breaks, for the form (`appProcessListWords`). */
  | { readonly ok: false; readonly error: "rule-broken"; readonly message: string; readonly issues: readonly AppProcessListIssue[] }
>;

/** "Keep it" (F-140): a port the agent announced becomes an environment proposal for a project admin. */
export type ProposeAppProcess = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey },
) => Promise<UseCaseResult<{ readonly proposalId: EnvironmentProposalId }, "forbidden" | "not-found" | "already-kept" | "not-announced">>;

// ---------- screenshots and recordings (F-121; tickets 15, 16, 17) ----------

/** The runner's `attachment.added`, saved before it's shown: once per task and `attachmentId`. */
export type RecordAttachment = (
  deps: PreviewDeps,
  input: {
    readonly taskId: TaskId;
    readonly turnId: TurnId | null;
    readonly attachmentId: AttachmentId;
    readonly kind: AttachmentKind;
    readonly blobId: BlobId;
    readonly source: AttachmentSource;
    readonly target: PreviewTarget;
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly durationMs: number | null;
    readonly frameCount: number | null;
    /** Never logged. */
    readonly caption: string | null;
    readonly browser: BoxBrowser;
    readonly memberId: MemberId | null;
  },
  /** `invalid` (ticket 15): a recording without its length and frames, or a member's screenshot without its member. */
) => Promise<UseCaseResult<{ readonly stored: boolean }, "not-found" | "blob-not-the-task-s" | "limit-reached" | "invalid">>;

/** "Add to draft" (F-099, F-121): a screenshot among a refine draft's images. */
export type AddAttachmentToDraft = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly attachmentId: AttachmentId; readonly draftId: DraftId },
  /** A draft's images, at most (`OSTRA_DRAFT_IMAGES_MAX`, as `addDraftImage` takes it; 10 without it). */
  limits?: { readonly max: number },
  /** `task-done` (ticket 15): the refine task's draft went to the tracker, as `addDraftImage` refuses. */
) => Promise<UseCaseResult<{ readonly draftImageId: DraftImageId }, "forbidden" | "not-found" | "not-a-screenshot" | "draft-full" | "task-done">>;

/** A member's screenshot from the pane: `screenshot.take` to the box's runner. */
export type TakeMemberScreenshot = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly path: string; readonly width: ViewportPreset },
) => Promise<UseCaseResult<{ readonly requestId: ScreenshotRequestId }, "forbidden" | "not-found" | "no-box" | "port-not-allowed" | PreviewRefusalReason>>;

// ---------- previews and views (F-141; tickets 19, 20) ----------

/** A link as the share menu lists it: its state and its uses, never its token. */
export type PreviewLinkView = {
  readonly linkId: PreviewLinkId;
  readonly kind: "expiring" | "public";
  readonly allowInput: boolean;
  readonly state: "active" | "expired" | "revoked";
  /** Epoch ms; `null` for a public link. */
  readonly expiresAt: number | null;
  readonly createdByMemberId: MemberId;
  readonly createdAt: number;
  readonly firstUsedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  /** How many views it opened. */
  readonly opens: number;
};

/** Who may open one preview (F-142): its level below its links, the people it names, and its links, newest first. */
export type PreviewSharing = {
  readonly level: "members" | "named";
  readonly memberIds: readonly MemberId[];
  readonly links: readonly PreviewLinkView[];
};

/** What the pane shows for a task: its previews, primary first, and whether a view can open, or why not. */
export type ListPreviews = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<
  UseCaseResult<
    {
      /** Each with who may open it and how many watch it now (its open views). */
      readonly previews: readonly (PreviewListItem & { readonly sharing: PreviewSharing; readonly watchers: number })[];
      readonly box: "running" | "starting" | "stopped" | "none";
      readonly can: { readonly stream: boolean; readonly tunnel: boolean; readonly native: boolean } | { readonly refused: PreviewRefusalReason };
      readonly carrier: PreviewCarrier | null;
      /** The latest screenshot, for the stopped pane. */
      readonly lastScreenshot: { readonly attachmentId: AttachmentId; readonly blobId: BlobId } | null;
      /** Whether the organization allows public links: the share menu greys `Public` out without it. */
      readonly publicLinks: boolean;
      /** `OSTRA_PREVIEW_LINK_MAX_DAYS`: the longest an expiring link may last. */
      readonly linkMaxDays: number;
    },
    "forbidden" | "not-found"
  >
>;

/** Who opens a view: a member (their scope), or someone with a link (its token, never logged). */
export type ViewOpener = { readonly kind: "member"; readonly scope: MemberScope } | { readonly kind: "link"; readonly token: string };

/**
 * Opens a view: the access check, the `PreviewView` row with its event, and `preview.open` to the
 * box's runner. `panelTokens` signs the answer's token for core's stream and input (ticket 19).
 */
export type OpenView = (
  deps: PreviewDeps & { readonly panelTokens: PanelPreviewTokens },
  opener: ViewOpener,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly mode: "stream" | "native"; readonly viewport: PreviewViewport | null },
) => Promise<
  UseCaseResult<
    { readonly viewId: PreviewViewId; readonly input: boolean; readonly panelToken: string },
    "not-found" | "no-box" | "port-not-allowed" | PreviewAccessRefusal | PreviewRefusalReason
  >
>;

export type CloseView = (
  deps: PreviewDeps,
  input: { readonly viewId: PreviewViewId; readonly reason: "closed" | "no-heartbeat" | "link-ended" | "box-gone" | "warm-cap" },
) => Promise<UseCaseResult<{ readonly closed: boolean }, "not-found">>;

/** The pane's or the viewer page's heartbeat (30 s): the view's `lastHeartbeatAt` and the box's `previewWatchedAt`. */
export type HeartbeatView = (deps: PreviewDeps, input: { readonly viewId: PreviewViewId }) => Promise<UseCaseResult<{ readonly open: boolean }, "not-found" | "closed">>;

/** "Start the app" (Q300): a lease with the purpose `app`, admitted like any box, with its audit entry and `app.started_by`. */
export type StartApp = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly state: "starting" | "running" }, "forbidden" | "not-found" | "no-app-processes" | "no-runner" | PreviewRefusalReason>>;

// ---------- sharing (F-142; tickets 19, 20) ----------

/**
 * A preview's level below its links (F-142): the project's members, or named people. Choosing one
 * narrows the preview away from links, so its active links end, and every view of someone who no
 * longer qualifies closes ("Narrowing it ends every viewer who no longer qualifies").
 */
export type SetPreviewLevel = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly level: "members" | "named"; readonly memberIds: readonly MemberId[] },
) => Promise<
  UseCaseResult<{ readonly level: "members" | "named"; readonly linksEnded: number; readonly viewsClosed: number }, "forbidden" | "not-found" | "not-a-member">
>;

/** A new link, with its audit entry. Its token is in the answer once, and never stored or logged. */
export type CreatePreviewLink = (
  deps: PreviewDeps,
  scope: MemberScope,
  /** `expiresInHours`: an expiring link's life, 24 hours when `null`; a public link takes `null`. */
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly kind: "expiring" | "public"; readonly allowInput: boolean; readonly expiresInHours: number | null },
) => Promise<UseCaseResult<{ readonly linkId: PreviewLinkId; readonly token: string; readonly expiresAt: number | null }, "forbidden" | "not-found" | "public-links-off" | "too-long">>;

/** Ends a link, with its audit entry; its open views close at once. */
export type RevokePreviewLink = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly linkId: PreviewLinkId },
) => Promise<UseCaseResult<{ readonly revoked: boolean; readonly viewsClosed: number }, "forbidden" | "not-found">>;

/**
 * What a link's token opens, as the viewer page may show it (ADR 0068): only the preview's label and
 * port, the organization's name, the expiry and whether input is allowed, never anything else of the
 * task. An unknown token says nothing of whether it existed; an expired or revoked one says which,
 * since its holder knows it did.
 */
export type PreviewLinkResolution =
  | {
      readonly state: "active";
      readonly linkId: PreviewLinkId;
      readonly taskId: TaskId;
      readonly key: PreviewKey;
      readonly label: string;
      readonly port: number | null;
      readonly organizationName: string;
      readonly input: boolean;
      readonly expiresAt: number | null;
    }
  | { readonly state: "expired" | "revoked"; readonly label: string; readonly port: number | null; readonly organizationName: string; readonly at: number }
  /** A public link where the organization no longer allows them. */
  | { readonly state: "not-allowed"; readonly organizationName: string }
  | { readonly state: "unknown" };

/** A link's use from the viewer page: the check, its first use's audit entry once, and `lastUsedAt`. */
export type UsePreviewLink = (deps: PreviewDeps, input: { readonly token: string }) => Promise<PreviewLinkResolution>;

/** An organization admin allows public preview links, or stops them: a public link's open views close at once. */
export type SetPublicPreviewLinks = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly enabled: boolean },
) => Promise<UseCaseResult<{ readonly enabled: boolean; readonly viewsClosed: number }, "forbidden">>;

// ---------- the native preview and the tunnel (F-143, F-144; tickets 23, 25, 26) ----------

/** The native preview's handshake (F-144): a one-time code for the preview host, after the same check a view makes. */
export type EnterNativePreview = (
  deps: PreviewDeps,
  opener: ViewOpener,
  input: { readonly taskId: TaskId; readonly key: PreviewKey },
) => Promise<
  UseCaseResult<
    { readonly url: string; readonly previewId: PreviewId },
    "not-found" | "no-preview-domain" | "no-box" | "port-not-allowed" | PreviewAccessRefusal | PreviewRefusalReason
  >
>;

/**
 * `ostra preview`'s ticket (F-143): a member's CLI session, a task they can open, one of its
 * previews' ports (the primary's when none is given). The ticket is bound to the CLI session too,
 * so core checks that session again while the tunnel lasts (ticket 23). `coreUrl` is core's public
 * address (`OSTRA_CORE_PUBLIC_URL`), which the CLI opens the tunnel on; `label` is the preview's,
 * which the CLI prints with its address (ticket 24).
 */
export type IssueCliTicket = (
  deps: { readonly db: Db; readonly clock: Clock; readonly coreUrl: string },
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly port: number | null; readonly cliSessionId: CliSessionId },
) => Promise<
  UseCaseResult<{ readonly ticket: string; readonly port: number; readonly label: string; readonly coreUrl: string }, "not-found" | "port-not-allowed" | "runner-cannot-tunnel" | "no-box">
>;

/** A code's or a ticket's one use: the check (`checkPreviewCode`) and `usedAt`, in one statement. */
export type RedeemCode = (
  deps: { readonly db: Db; readonly clock: Clock },
  input: { readonly code: string; readonly kind: "enter" | "cli_ticket"; readonly taskId?: TaskId; readonly port?: number },
) => Promise<PreviewCodeCheck>;
