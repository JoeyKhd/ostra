import { t } from "@/lib/messages";

// The words of the profile's model picker (app-targets/m4/agent-profile-model.md, F-135). Pure.

type Searchable = { readonly displayName: string; readonly text: string };
type Sortable = Searchable & { readonly projectsWithout: readonly unknown[] };

/** Whether an option matches the search, by its display name or its ID (catalog or endpoint), ignoring case. */
export const matchesQuery = (option: Searchable, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [option.displayName, option.text].some((text) => text.toLowerCase().includes(q));
};

/** Models every project can use first, then by name. */
export const sortOptions = <T extends Sortable,>(options: readonly T[]): readonly T[] =>
  [...options].sort((a, b) => {
    const served = Number(a.projectsWithout.length > 0) - Number(b.projectsWithout.length > 0);
    return served !== 0 ? served : a.displayName.localeCompare(b.displayName);
  });

/** The keys that list a model, comma-joined; past two, the first two and `+{n}`. */
export const keysText = (names: readonly string[]): string =>
  names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${String(names.length - 2)}`;

/** `No key in globex-shop`, `No key in a, b`, or `No key in 3 projects`; null when every project is served. */
export const noKeyText = (projects: readonly string[]): string | null => {
  if (projects.length === 0) return null;
  if (projects.length <= 2) return t("agentProfiles.editor.modelPicker.noKeyIn", { projects: projects.join(", ") });
  return t("agentProfiles.editor.modelPicker.noKeyInMany", { n: projects.length });
};
