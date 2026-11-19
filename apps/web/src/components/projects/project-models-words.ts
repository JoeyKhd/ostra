import { plural, t } from "@/lib/messages";

// The words of a project's "Models and keys" (app-targets/m4/project-models-keys.md, F-135). Pure.

/** A list's saved and draft provider IDs, as the checkbox rows compare them. */
export type ListMark = "added" | "removed" | null;

/** Whether a provider was ticked or unticked against the saved list. */
export const listMark = (providerId: string, saved: ReadonlySet<string>, draft: ReadonlySet<string>): ListMark =>
  draft.has(providerId) && !saved.has(providerId) ? "added" : !draft.has(providerId) && saved.has(providerId) ? "removed" : null;

/** Whether the draft differs from what's saved: the mode, or the ticked providers. */
export const listChanged = (saved: { readonly own: boolean; readonly ids: ReadonlySet<string> }, draft: { readonly own: boolean; readonly ids: ReadonlySet<string> }): boolean =>
  saved.own !== draft.own || (draft.own && (saved.ids.size !== draft.ids.size || [...draft.ids].some((id) => !saved.ids.has(id))));

/** `Today: acme-anthropic.` or `Today: no key.`: the follow row's description. */
export const followDescription = (names: readonly string[]): string =>
  names.length === 0 ? t("projectModels.follow.none") : t("projectModels.follow.today", { names: names.join(", ") });

/** `What happens`: each clause only when its count isn't 0; null when nothing happens. */
export const whatHappens = (released: { readonly boxes: number; readonly providerNames: readonly string[] }, waiting: readonly { readonly model: string; readonly tasks: number }[]): string | null => {
  const parts: string[] = [];
  if (released.boxes > 0) {
    parts.push(
      plural(released.boxes, "projectModels.preview.releasedOne", "projectModels.preview.releasedMany", { keys: released.providerNames.join(", ") }),
    );
  }
  for (const row of waiting) {
    if (row.tasks > 0) parts.push(plural(row.tasks, "projectModels.preview.waitingOne", "projectModels.preview.waitingMany", { model: row.model }));
  }
  return parts.length === 0 ? null : parts.join(" ");
};

/** The status line after a save: `Saved. 1 model moved, 1 has no key.` */
export const savedLine = (moved: number, lost: number): string => {
  const parts = [t("projectModels.saved.lead")];
  const details: string[] = [];
  if (moved > 0) details.push(plural(moved, "projectModels.saved.movedOne", "projectModels.saved.movedMany"));
  if (lost > 0) details.push(plural(lost, "projectModels.saved.lostOne", "projectModels.saved.lostMany"));
  return details.length === 0 ? parts.join("") : `${parts.join("")} ${details.join(", ")}.`;
};
