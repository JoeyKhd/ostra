import type { Db } from "@ostra/db";
import type {
  AttachmentId,
  AttachmentKind,
  AttachmentSource,
  BlobId,
  BoxBrowser,
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
import type { Ports } from "../ports.ts";
import type { PreviewAccessRefusal } from "../previews/access.ts";
import type { AppProcessForm, AppProcessListIssue, ScreenshotSettings } from "../previews/app-processes.ts";
import type { PreviewCodeCheck } from "../previews/tokens.ts";
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

/** A project admin saves the environment's app processes and screenshot settings, as a whole list in order. */
export type SaveAppProcesses = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: {
    readonly projectId: ProjectId;
    readonly processes: readonly AppProcessForm[];
    readonly screenshots: ScreenshotSettings;
    /** Each service's preview label, by name; a service left out keeps its own. */
    readonly servicePreviews: Readonly<Record<string, string | null>>;
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
) => Promise<UseCaseResult<{ readonly stored: boolean }, "not-found" | "blob-not-the-task-s" | "limit-reached">>;

/** "Add to draft" (F-099, F-121): a screenshot among a refine draft's images. */
export type AddAttachmentToDraft = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly attachmentId: AttachmentId; readonly draftId: DraftId },
) => Promise<UseCaseResult<{ readonly draftImageId: DraftImageId }, "forbidden" | "not-found" | "not-a-screenshot" | "draft-full">>;

/** A member's screenshot from the pane: `screenshot.take` to the box's runner. */
export type TakeMemberScreenshot = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly path: string; readonly width: ViewportPreset },
) => Promise<UseCaseResult<{ readonly requestId: ScreenshotRequestId }, "forbidden" | "not-found" | "no-box" | PreviewRefusalReason>>;

// ---------- previews and views (F-141; tickets 19, 20) ----------

/** What the pane shows for a task: its previews, primary first, and whether a view can open, or why not. */
export type ListPreviews = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<
  UseCaseResult<
    {
      readonly previews: readonly PreviewListItem[];
      readonly box: "running" | "starting" | "stopped" | "none";
      readonly can: { readonly stream: boolean; readonly tunnel: boolean; readonly native: boolean } | { readonly refused: PreviewRefusalReason };
      readonly carrier: PreviewCarrier | null;
      /** The latest screenshot, for the stopped pane. */
      readonly lastScreenshot: { readonly attachmentId: AttachmentId; readonly blobId: BlobId } | null;
    },
    "forbidden" | "not-found"
  >
>;

/** Who opens a view: a member (their scope), or someone with a link (its token, never logged). */
export type ViewOpener = { readonly kind: "member"; readonly scope: MemberScope } | { readonly kind: "link"; readonly token: string };

/** Opens a view: the access check, the `PreviewView` row with its audit entry, and `preview.open` to the box's runner. */
export type OpenView = (
  deps: PreviewDeps,
  opener: ViewOpener,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly mode: "stream" | "native"; readonly viewport: PreviewViewport | null },
) => Promise<
  UseCaseResult<
    { readonly viewId: PreviewViewId; readonly input: boolean; readonly panelToken: string },
    "not-found" | "no-box" | "port-not-allowed" | PreviewAccessRefusal | PreviewRefusalReason
  >
>;

export type CloseView = (deps: PreviewDeps, input: { readonly viewId: PreviewViewId; readonly reason: "closed" | "no-heartbeat" | "link-ended" | "box-gone" }) => Promise<UseCaseResult<{ readonly closed: boolean }, "not-found">>;

/** The pane's or the viewer page's heartbeat (30 s): the view's `lastHeartbeatAt` and the box's `previewWatchedAt`. */
export type HeartbeatView = (deps: PreviewDeps, input: { readonly viewId: PreviewViewId }) => Promise<UseCaseResult<{ readonly open: boolean }, "not-found" | "closed">>;

/** "Start the app" (Q300): a lease with the purpose `app`, admitted like any box, with its audit entry and `app.started_by`. */
export type StartApp = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
) => Promise<UseCaseResult<{ readonly state: "starting" | "running" }, "forbidden" | "not-found" | "no-app-processes" | "no-runner" | PreviewRefusalReason>>;

// ---------- sharing (F-142; tickets 19, 20) ----------

export type SetPreviewLevel = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly level: "members" | "named"; readonly memberIds: readonly MemberId[] },
) => Promise<UseCaseResult<{ readonly level: "members" | "named" }, "forbidden" | "not-found" | "not-a-member">>;

/** A new link, with its audit entry. Its token is in the answer once, and never stored or logged. */
export type CreatePreviewLink = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly key: PreviewKey; readonly kind: "expiring" | "public"; readonly allowInput: boolean; readonly expiresInHours: number | null },
) => Promise<UseCaseResult<{ readonly linkId: PreviewLinkId; readonly token: string; readonly expiresAt: number | null }, "forbidden" | "not-found" | "public-links-off" | "too-long">>;

export type RevokePreviewLink = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly linkId: PreviewLinkId },
) => Promise<UseCaseResult<{ readonly revoked: boolean }, "forbidden" | "not-found">>;

/** A link's use from the viewer page: the check, its first use's audit entry once, and `lastUsedAt`. */
export type UsePreviewLink = (
  deps: PreviewDeps,
  input: { readonly token: string },
) => Promise<
  UseCaseResult<
    { readonly linkId: PreviewLinkId; readonly taskId: TaskId; readonly key: PreviewKey; readonly label: string; readonly input: boolean; readonly expiresAt: number | null },
    PreviewAccessRefusal
  >
>;

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

/** `ostra preview`'s ticket (F-143): a member's CLI session, a task they can open, one of its previews' ports. */
export type IssueCliTicket = (
  deps: PreviewDeps,
  scope: MemberScope,
  input: { readonly taskId: TaskId; readonly port: number | null },
) => Promise<UseCaseResult<{ readonly ticket: string; readonly port: number; readonly coreUrl: string }, "not-found" | "port-not-allowed" | "runner-cannot-tunnel" | "no-box">>;

/** A code's or a ticket's one use: the check (`checkPreviewCode`) and `usedAt`, in one statement. */
export type RedeemCode = (
  deps: PreviewDeps,
  input: { readonly code: string; readonly kind: "enter" | "cli_ticket"; readonly taskId?: TaskId; readonly port?: number },
) => Promise<PreviewCodeCheck>;
