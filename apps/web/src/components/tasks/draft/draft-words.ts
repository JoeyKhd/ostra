import type { RefineDraft } from "@ostra/protocol";

import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The refine draft's words and its pure parts (app-targets/m6/refine-draft.md; F-099, ticket 34):
// whose words each item is, the version chips, the footnote under the buttons and the On Linear rows.

export type DraftView = RouterOutputs["drafts"]["get"];
export type DraftVersion = DraftView["versions"][number];
export type ListField = "acceptanceCriteria" | "edgeCases" | "openQuestions";

/** Whose words an item is, against the agent's newest version. */
export type ItemMark = { readonly kind: "same" } | { readonly kind: "edited"; readonly agent: string } | { readonly kind: "added" };

/**
 * Each item's mark, and the agent's items no longer there (`removed`, with their place). An item
 * equal to one of the agent's is the agent's, wherever it moved; one that differs from the agent's
 * item at its place, when that one is gone, is an edit of it; any other is added.
 */
export const markItems = (items: readonly string[], agent: readonly string[] | null): { readonly marks: readonly ItemMark[]; readonly removed: readonly { readonly index: number; readonly text: string }[] } => {
  if (agent === null) return { marks: items.map(() => ({ kind: "same" })), removed: [] };
  const used = new Set<number>();
  const first: (ItemMark | null)[] = items.map((text) => {
    const at = agent.findIndex((one, index) => !used.has(index) && one === text);
    if (at < 0) return null;
    used.add(at);
    return { kind: "same" };
  });
  const marks = first.map((mark, index): ItemMark => {
    if (mark !== null) return mark;
    const was = agent[index];
    if (was !== undefined && !used.has(index) && !items.includes(was)) {
      used.add(index);
      return { kind: "edited", agent: was };
    }
    return { kind: "added" };
  });
  const removed = agent.flatMap((text, index) => (used.has(index) ? [] : [{ index, text }]));
  return { marks, removed };
};

/** The list with the item at `from` moved one place up or down; the same list at an end. */
export const moveItem = <T,>(items: readonly T[], from: number, by: -1 | 1): readonly T[] => {
  const to = from + by;
  const moving = items[from];
  if (moving === undefined || to < 0 || to >= items.length) return items;
  const next = items.filter((_, index) => index !== from);
  next.splice(to, 0, moving);
  return next;
};

/** A field of the draft replaced. */
export const withList = (draft: RefineDraft, field: ListField, items: readonly string[]): RefineDraft => ({ ...draft, [field]: [...items] });

/** Who made a version, for its chip and the panel. */
export const versionWho = (version: Pick<DraftVersion, "source" | "editedBy">, meId: string | null): { readonly kind: "agent" } | { readonly kind: "you" } | { readonly kind: "member"; readonly name: string } =>
  version.source === "agent" ? { kind: "agent" } : version.editedBy !== null && version.editedBy.memberId === meId ? { kind: "you" } : { kind: "member", name: version.editedBy?.name ?? t("taskPage.someone") };

/** A version's chip: `v2 · agent`, `v3 · your edit`, `v3 · Sam Rivera`, `v3 · applied`. */
export const versionChip = (version: Pick<DraftVersion, "version" | "source" | "editedBy" | "appliedAt">, meId: string | null): string => {
  if (version.appliedAt !== null) return t("draft.chipApplied", { n: version.version });
  const who = versionWho(version, meId);
  switch (who.kind) {
    case "agent":
      return t("draft.chipAgent", { n: version.version });
    case "you":
      return t("draft.chipYou", { n: version.version });
    case "member":
      return t("draft.chipMember", { n: version.version, name: who.name });
    default:
      return who satisfies never;
  }
};

/** The chips the version line shows: all of them up to 5, else the newest 4 (the rest in a menu). */
export const shownChips = <T,>(versions: readonly T[]): { readonly shown: readonly T[]; readonly more: readonly T[] } =>
  versions.length <= 5 ? { shown: versions, more: [] } : { shown: versions.slice(-4), more: versions.slice(0, -4) };

/** How many lines a sub-ticket's text has, for its row. */
export const lineCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split("\n").length);

/** The footnote under the buttons, naming what each button writes. */
export const footnote = (input: {
  readonly version: number;
  readonly ticketKey: string | null;
  readonly boardName: string | null;
  readonly subTickets: number;
  readonly subIssues: boolean;
  readonly readyStatus: string | null;
}): string => {
  const parts: string[] = [];
  if (input.ticketKey === null) {
    parts.push(
      input.subTickets === 0
        ? t("draft.footCreate", { board: input.boardName ?? "", n: input.version })
        : plural(input.subTickets, "draft.footCreateWith.one", "draft.footCreateWith.other", { board: input.boardName ?? "", version: input.version }),
    );
  } else {
    const head = t("draft.footUpdate", { n: input.version, key: input.ticketKey });
    parts.push(
      input.subTickets === 0
        ? `${head}.`
        : input.subIssues
          ? plural(input.subTickets, "draft.footSubIssues.one", "draft.footSubIssues.other", { head })
          : plural(input.subTickets, "draft.footLinked.one", "draft.footLinked.other", { head }),
    );
  }
  if (input.readyStatus !== null) parts.push(t("draft.footReady", { status: input.readyStatus }));
  return parts.join(" ");
};

export type WriteState = "done" | "pending" | "failed";

/** The On Linear group's rows once a version was applied: what was written, and where each write stands. */
export const onLinearRows = (input: {
  readonly appliedAt: number | null;
  readonly written: DraftView["written"];
  readonly images: readonly { readonly attachedAt: number | null }[];
  readonly subTickets: number;
  readonly createdTicket: boolean;
  readonly move: { readonly state: WriteState; readonly status: string } | null;
}): readonly { readonly id: string; readonly label: string; readonly state: WriteState }[] => {
  const rows: { id: string; label: string; state: WriteState }[] = [];
  if (input.appliedAt !== null) {
    const state: WriteState = input.written === null ? "pending" : "done";
    if (input.createdTicket) rows.push({ id: "created", label: t("draft.rowCreated"), state });
    else rows.push({ id: "description", label: t("draft.rowDescription"), state });
    if (input.images.length > 0) {
      const attached = input.images.every((image) => image.attachedAt !== null);
      rows.push({ id: "images", label: plural(input.images.length, "draft.rowImages.one", "draft.rowImages.other"), state: attached ? "done" : "pending" });
    }
    if (input.subTickets > 0) {
      rows.push({ id: "sub-issues", label: plural(input.subTickets, "draft.rowSubIssues.one", "draft.rowSubIssues.other"), state });
    }
  }
  if (input.move !== null) rows.push({ id: "move", label: t("draft.rowMoved", { status: input.move.status }), state: input.move.state });
  return rows;
};

/** A sub-issue's address beside its parent's: Linear's `/issue/<key>` path, else none. */
export const siblingUrl = (parent: { readonly key: string; readonly url: string } | null, key: string): string | null => {
  if (parent === null) return null;
  const marker = `/issue/${parent.key}`;
  const at = parent.url.indexOf(marker);
  return at < 0 ? null : `${parent.url.slice(0, at)}/issue/${key}`;
};
