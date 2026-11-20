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

type Disambiguable = Searchable & {
  readonly name: { readonly kind: "catalog" | "custom" };
  readonly providers: readonly { readonly providerId: string; readonly endpointModelId: string }[];
};

/** What the picker shows as an option's name: a custom model's endpoint ID, else its display name. */
const labelOf = (option: Disambiguable): string => (option.name.kind === "custom" ? option.text : option.displayName);

/**
 * F-088: for each option that one key lists beside another option of the same name, that key's
 * endpoint model ID, which the picker shows after the name, muted, so the two can be told apart.
 * Keyed by the option's `text`; an option whose name no other option on its keys shares has none.
 */
export const disambiguatorsOf = (options: readonly Disambiguable[]): ReadonlyMap<string, string> => {
  const byLabel = new Map<string, Disambiguable[]>();
  for (const option of options) {
    byLabel.set(labelOf(option), [...(byLabel.get(labelOf(option)) ?? []), option]);
  }
  const found = new Map<string, string>();
  for (const same of byLabel.values()) {
    for (const option of same) {
      const shared = option.providers.find((provider) =>
        same.some((other) => other !== option && other.providers.some((theirs) => theirs.providerId === provider.providerId)),
      );
      if (shared !== undefined) found.set(option.text, shared.endpointModelId);
    }
  }
  return found;
};

/** `No key in globex-shop`, `No key in a, b`, or `No key in 3 projects`; null when every project is served. */
export const noKeyText = (projects: readonly string[]): string | null => {
  if (projects.length === 0) return null;
  if (projects.length <= 2) return t("agentProfiles.editor.modelPicker.noKeyIn", { projects: projects.join(", ") });
  return t("agentProfiles.editor.modelPicker.noKeyInMany", { n: projects.length });
};
