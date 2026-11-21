import type { PreviewCloseReason, PreviewOpenRefusal, PreviewRefusalReason } from "@ostra/protocol";
import type { PreviewRouteErrorCode } from "@ostra/api";

import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

// The words for every code a preview can end or be refused with (milestone 8, F-141, F-142): the
// box's refusals of a view, core's reasons for closing one, the routes' codes, and the pane's own
// refusals from the API. Each list is a full record of its union, so a new code fails the build until
// it has words. None names a runner, a version or a token: the viewer page shows these too.

/** Why the box refused a view (`previewOpenRefusalSchema`): the one a member can act on is `too-many-pages`. */
const boxRefusalKeys = {
  "not-a-preview": "previewWords.boxRefusal.not-a-preview",
  "too-many-pages": "previewWords.boxRefusal.too-many-pages",
  "session-ending": "previewWords.boxRefusal.session-ending",
  "unknown-session": "previewWords.boxRefusal.unknown-session",
  "tunnel-needs-websocket": "previewWords.boxRefusal.tunnel-needs-websocket",
  "past-not-after": "previewWords.boxRefusal.past-not-after",
  "not-servable": "previewWords.boxRefusal.not-servable",
  "no-browser": "previewWords.boxRefusal.no-browser",
  "browser-failed": "previewWords.boxRefusal.browser-failed",
  "connect-failed": "previewWords.boxRefusal.connect-failed",
  other: "previewWords.boxRefusal.other",
} as const satisfies Readonly<Record<PreviewOpenRefusal, MessageKey>>;

/** Why a view's stream ended, by core's reason. */
const closeKeys = {
  closed: "previewWords.close.closed",
  "page-crashed": "previewWords.close.page-crashed",
  "app-stopped": "previewWords.close.app-stopped",
  "box-stopping": "previewWords.close.box-stopping",
  "stale-lease": "previewWords.close.stale-lease",
  "protocol-violation": "previewWords.close.protocol-violation",
} as const satisfies Readonly<Record<PreviewCloseReason, MessageKey>>;

/** What a route's refusal means, in words a viewer can act on. */
const routeKeys = {
  unauthorized: "previewWords.route.unauthorized",
  forbidden: "previewWords.route.forbidden",
  "not-found": "previewWords.route.not-found",
  "view-closed": "previewWords.route.view-closed",
  "watch-only": "previewWords.route.watch-only",
  "not-allowed": "previewWords.route.not-allowed",
  "link-expired": "previewWords.route.link-expired",
  "link-revoked": "previewWords.route.link-revoked",
  "public-links-off": "previewWords.route.public-links-off",
  "level-unknown": "previewWords.route.level-unknown",
  "bad-request": "previewWords.route.bad-request",
  "too-many-tries": "previewWords.route.too-many-tries",
  "not-connected": "previewWords.route.not-connected",
  "core-unreachable": "previewWords.route.core-unreachable",
} as const satisfies Readonly<Record<PreviewRouteErrorCode, MessageKey>>;

/** Why a runner can't show a task's previews at all (`isPreviewable`). */
const previewabilityKeys = {
  "runner-needs-upgrade": "previewWords.runner.runner-needs-upgrade",
  "runner-cannot-preview": "previewWords.runner.runner-cannot-preview",
} as const satisfies Readonly<Record<PreviewRefusalReason, MessageKey>>;

export const boxRefusalWords = (refusal: PreviewOpenRefusal): string => t(boxRefusalKeys[refusal]);

/** Why a view ended: the box's refusal when it refused, else core's reason. */
export const closeWords = (close: { readonly reason: PreviewCloseReason } | { readonly reason: "refused"; readonly refusal: PreviewOpenRefusal }): string =>
  "refusal" in close ? boxRefusalWords(close.refusal) : t(closeKeys[close.reason]);

/** A route's refusal; `null` (a code the panel doesn't know) is core's or the network's. */
export const routeWords = (code: PreviewRouteErrorCode | null): string => t(code === null ? "previewWords.route.core-unreachable" : routeKeys[code]);

/** Why the task's runner can't show a preview, with the runner's name for a member. */
export const previewabilityWords = (reason: PreviewRefusalReason, runner: string | null): string =>
  runner === null ? t(previewabilityKeys[reason], { runner: t("previewWords.runner.theRunner") }) : t(previewabilityKeys[reason], { runner });

/** Whether a member can do something about a box's refusal themselves: close another pane, or start the app. */
export const refusalActionable = (refusal: PreviewOpenRefusal): "close-another" | "start-again" | "try-again" | null => {
  switch (refusal) {
    case "too-many-pages":
      return "close-another";
    case "not-servable":
      return "start-again";
    case "browser-failed":
    case "connect-failed":
    case "past-not-after":
    case "other":
      return "try-again";
    case "not-a-preview":
    case "session-ending":
    case "unknown-session":
    case "tunnel-needs-websocket":
    case "no-browser":
      return null;
    default:
      return refusal satisfies never;
  }
};
