import type { DbEnum } from "@ostra/db";
import type { MemberId, PreviewKey, PreviewLinkId, TaskId } from "@ostra/protocol";

import { previewLinkFromRow } from "../lifecycles/m8-previews.ts";

// Who may open a preview (milestone 8, F-142, ADR 0068): a member who can open the task, a named
// person of the preview's level, or someone with a link that's still good. It fails closed: a
// level it doesn't know, a link for another preview, a public link where the organization forbids
// them, or anything it can't read gives no view, with the reason the page shows.

/** A preview's level below its links, as its row has it: no row means `members`. */
export type PreviewLevelRow = {
  readonly level: DbEnum.PreviewLevel;
  /** The named people, for `named`. */
  readonly memberIds: readonly MemberId[];
};

/** A link as the check reads it. Never its token: only the row the token's hash found. */
export type PreviewLinkFacts = {
  readonly linkId: PreviewLinkId;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly kind: DbEnum.PreviewLinkKind;
  readonly allowInput: boolean;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedByMemberId: MemberId | null;
};

/** Who asks to open the preview. */
export type PreviewViewerFacts =
  | {
      readonly kind: "member";
      readonly memberId: MemberId;
      /** Whether the member can open the task, by the project's access rule (ADR 0026): members, or the organization's admins on a restricted project. */
      readonly canOpenTask: boolean;
    }
  | { readonly kind: "link"; readonly link: PreviewLinkFacts };

/** The preview asked for. */
export type PreviewAsked = { readonly taskId: TaskId; readonly key: PreviewKey };

/** The organization's switches the check reads. */
export type PreviewOrganizationSettings = { readonly publicPreviewLinks: boolean };

/** Why a view is refused: what the page says (`previewAccessWords`). Never anything of the task. */
export type PreviewAccessRefusal =
  /** Not a member of the project, nor named on the preview. */
  | "not-allowed"
  | "link-expired"
  | "link-revoked"
  /** A public link, and the organization doesn't allow public links. */
  | "public-links-off"
  /** The link is for another preview or task: refused as if it weren't one. */
  | "link-unknown"
  /** The level isn't one this build knows. */
  | "level-unknown";

export type PreviewAccess =
  /** `input`: the viewer may click and type in the shared page. */
  | { readonly allowed: true; readonly input: boolean; readonly as: "member" | "named" | "link" }
  | { readonly allowed: false; readonly reason: PreviewAccessRefusal };

const refused = (reason: PreviewAccessRefusal): PreviewAccess => ({ allowed: false, reason });

/**
 * Whether `viewer` may open the preview `asked`, at `now` (ADR 0068, "Who can open a preview"):
 * - a member who can open the task may, and may give input (Q314);
 * - a member named on the preview's `named` level may watch it, and nothing else of the task;
 * - a link may while it's neither revoked nor expired, and a public one only where the
 *   organization allows public links; it's watch-only unless it allows input (Q301).
 * Anything else, and anything it doesn't know, is refused.
 */
export const previewAccess = (
  viewer: PreviewViewerFacts,
  asked: PreviewAsked,
  level: PreviewLevelRow | null,
  organization: PreviewOrganizationSettings,
  now: number,
): PreviewAccess => {
  switch (viewer.kind) {
    case "member": {
      if (viewer.canOpenTask) {
        return { allowed: true, input: true, as: "member" };
      }
      const current = level ?? { level: "members", memberIds: [] };
      switch (current.level) {
        case "members":
          return refused("not-allowed");
        case "named":
          return current.memberIds.includes(viewer.memberId) ? { allowed: true, input: false, as: "named" } : refused("not-allowed");
        default:
          // A level this build doesn't know, from a newer row: fail closed.
          current.level satisfies never;
          return refused("level-unknown");
      }
    }
    case "link": {
      const { link } = viewer;
      if (link.taskId !== asked.taskId || link.key !== asked.key) {
        return refused("link-unknown");
      }
      const state = previewLinkFromRow(link, now);
      switch (state.state) {
        case "revoked":
          return refused("link-revoked");
        case "expired":
          return refused("link-expired");
        case "active":
          break;
        default:
          return state satisfies never;
      }
      switch (link.kind) {
        case "public":
          if (!organization.publicPreviewLinks) {
            return refused("public-links-off");
          }
          break;
        case "expiring":
          // An expiring link with no end can't be: read as expired.
          if (link.expiresAt === null) {
            return refused("link-expired");
          }
          break;
        default:
          // A kind this build doesn't know, from a newer row: fail closed.
          link.kind satisfies never;
          return refused("level-unknown");
      }
      return { allowed: true, input: link.allowInput, as: "link" };
    }
    default:
      return viewer satisfies never;
  }
};

/** The page's words for a refusal. Names nothing of the task. */
export const previewAccessWords = (reason: PreviewAccessRefusal): string => {
  switch (reason) {
    case "not-allowed":
      return "You can't open this preview. Ask a member of the project to share it with you.";
    case "link-expired":
      return "This link has expired. Ask whoever shared it for a new one.";
    case "link-revoked":
      return "This link was revoked.";
    case "public-links-off":
      return "This organization doesn't allow public preview links.";
    case "link-unknown":
      return "This link doesn't open this preview.";
    case "level-unknown":
      return "This preview's sharing can't be read. Ask a member of the project to set it again.";
    default:
      return reason satisfies never;
  }
};

/** The levels a member may pick for a preview: public only where the organization allows public links. */
export const previewLevelChoices = (organization: PreviewOrganizationSettings): readonly ("members" | "named" | "expiring" | "public")[] =>
  organization.publicPreviewLinks ? ["members", "named", "expiring", "public"] : ["members", "named", "expiring"];
