import type { PreviewViewId } from "@ostra/protocol";

import type { PreviewViewerData } from "@/app/p/[token]/viewer-data";
import { t } from "@/lib/messages";

// The viewer page's state (milestone 8, F-142; preview-viewer.md, "Every state"): the server's
// answer for a link, and what the page learns while it's open, as one union with an exhaustive
// switch. Pure, so each rule is tested alone.

export type { PreviewViewerData };

/** Why the page shows no app. */
export type ViewerEnd =
  | { readonly kind: "expired"; readonly label: string; readonly port: number | null; readonly organizationName: string; readonly at: number }
  | { readonly kind: "revoked"; readonly organizationName: string; readonly at: number }
  | { readonly kind: "not-allowed"; readonly organizationName: string }
  | { readonly kind: "runner-too-old" }
  | { readonly kind: "unknown" }
  | { readonly kind: "too-many-tries" };

/** What the page shows of the preview: its label and port, the organization, the expiry and the mode. */
export type Shown = { readonly label: string; readonly port: number | null; readonly organizationName: string; readonly expiresAt: number | null; readonly input: boolean };

export type Viewer =
  | { readonly kind: "live"; readonly viewId: PreviewViewId; readonly shown: Shown }
  /**
   * Ticket 26 (F-142, F-144): a link that allows input, framed on the preview's own host. `url` is
   * the host's one-time `/.ostra/enter`; `attempt` counts the codes the page asked for, and a new
   * one remounts the frame.
   */
  | { readonly kind: "native"; readonly url: string; readonly host: string; readonly attempt: number; readonly shown: Shown }
  | { readonly kind: "not-running"; readonly shown: Shown }
  | { readonly kind: "ended"; readonly end: ViewerEnd; readonly shown: Shown | null };

/** The page's state from the server's answer (`loadPreviewViewer`, or `previews.link.open` again). */
export const viewerOf = (data: PreviewViewerData, before: Shown | null = null): Viewer => {
  switch (data.state) {
    case "live":
      return { kind: "live", viewId: data.viewId, shown: { label: data.label, port: data.port, organizationName: data.organizationName, expiresAt: data.expiresAt, input: data.input } };
    case "native":
      return { kind: "native", url: data.url, host: data.host, attempt: 0, shown: { label: data.label, port: data.port, organizationName: data.organizationName, expiresAt: data.expiresAt, input: data.input } };
    case "not-running":
      return { kind: "not-running", shown: { label: data.label, port: data.port, organizationName: data.organizationName, expiresAt: data.expiresAt, input: data.input } };
    case "expired":
      return { kind: "ended", end: { kind: "expired", label: data.label, port: data.port, organizationName: data.organizationName, at: data.at }, shown: before };
    case "revoked":
      return { kind: "ended", end: { kind: "revoked", organizationName: data.organizationName, at: data.at }, shown: before };
    case "not-allowed":
      return { kind: "ended", end: { kind: "not-allowed", organizationName: data.organizationName }, shown: before };
    case "runner-too-old":
      return { kind: "ended", end: { kind: "runner-too-old" }, shown: before };
    case "unknown":
      return { kind: "ended", end: { kind: "unknown" }, shown: before };
    case "too-many-tries":
      return { kind: "ended", end: { kind: "too-many-tries" }, shown: before };
    default:
      return data satisfies never;
  }
};

/** The ending the heartbeat reports, as the page words it. */
export const learnedEnd = (state: "expired" | "revoked" | "not-allowed" | "unknown", shown: Shown, now: number): ViewerEnd => {
  switch (state) {
    case "expired":
      return { kind: "expired", label: shown.label, port: shown.port, organizationName: shown.organizationName, at: shown.expiresAt ?? now };
    case "revoked":
      return { kind: "revoked", organizationName: shown.organizationName, at: now };
    case "not-allowed":
      return { kind: "not-allowed", organizationName: shown.organizationName };
    case "unknown":
      return { kind: "unknown" };
    default:
      return state satisfies never;
  }
};

/** `Expires in 23 h`, `in 52 min`, `in 6 days`. */
export const expiryWords = (expiresAt: number, now: number): string => {
  const ms = Math.max(0, expiresAt - now);
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return t("previewViewer.expiresIn.minutes", { n: Math.max(1, minutes) });
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return t("previewViewer.expiresIn.hours", { n: hours });
  return t("previewViewer.expiresIn.days", { n: Math.floor(ms / 86_400_000) });
};

