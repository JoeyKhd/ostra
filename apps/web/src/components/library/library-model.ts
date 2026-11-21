import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The library's screens as data (F-145, F-146; milestone 8, ticket 31; app-targets/m8/library*.md
// and agent-profile-library.md): what each row, band, chip and refusal says, computed from the
// API's answers. Pure, so its rules are unit tests (`library-model.test.ts`); the components only
// draw what these return. Every text a source served (a name, a description, a file) is data.

export type LibraryItem = RouterOutputs["library"]["list"][number];
export type LibraryItemDetail = RouterOutputs["library"]["get"];
export type LibrarySourceView = LibraryItem["source"];
export type Suggestion = RouterOutputs["library"]["suggestions"]["list"][number];
export type MySuggestion = RouterOutputs["library"]["suggestions"]["mine"][number];
export type Look = RouterOutputs["library"]["resolve"];
export type Resolved = Look["resolved"];
export type SkillLook = Extract<Resolved, { readonly kind: "skills" }>;
export type ServerLook = Extract<Resolved, { readonly kind: "server" }>;
export type ResolvedSkill = SkillLook["skills"][number];
export type SearchState = RouterOutputs["library"]["searchState"];
export type SearchSource = RouterOutputs["library"]["search"]["sources"][number];
export type SearchResult = Extract<SearchSource, { readonly state: "ok" }>["results"][number];
export type SourceEntry = RouterOutputs["library"]["sources"]["list"][number];
export type ProfileLibrary = RouterOutputs["agentProfiles"]["get"]["library"];
export type ItemKind = LibraryItem["kind"];

// ---------- words of one item ----------

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/** The source as the table shows it: `owner/repo@skill`, `host@skill`, a registry's server name. */
export const sourceText = (item: { readonly source: LibrarySourceView; readonly name: string }): string => {
  const source = item.source;
  switch (source.kind) {
    case "github": {
      const at = source.path === "" ? "" : `@${source.path.split("/").at(-1) ?? item.name}`;
      return `${source.owner}/${source.repo}${at}${source.ref === null ? "" : `#${source.ref}`}`;
    }
    case "well_known":
      return `${hostOf(source.url)}@${source.skill}`;
    case "registry":
      return source.name;
    case "unreadable":
      return t("library.source.unreadable");
    default:
      return source satisfies never;
  }
};

/** The whole source, for a `title`: the repo and its folder, the site's address, the registry and the name. */
export const sourceTitle = (source: LibrarySourceView): string => {
  switch (source.kind) {
    case "github":
      return `github.com/${source.owner}/${source.repo}${source.path === "" ? "" : `/${source.path}`}${source.ref === null ? "" : `#${source.ref}`}`;
    case "well_known":
      return `${source.url} · ${source.skill}`;
    case "registry":
      return `${source.name} · ${source.registryUrl}`;
    case "unreadable":
      return t("library.source.unreadable");
    default:
      return source satisfies never;
  }
};

/** Where the source can be opened on its host, or `null` (a registry entry has no page of its own). */
export const sourceHref = (source: LibrarySourceView): string | null => {
  switch (source.kind) {
    case "github":
      return `https://github.com/${source.owner}/${source.repo}${source.path === "" ? "" : `/tree/${source.ref ?? "HEAD"}/${source.path}`}`;
    case "well_known":
      return source.url;
    case "registry":
    case "unreadable":
      return null;
    default:
      return source satisfies never;
  }
};

/** A version's mark: `v1.8.2` as written, prefixed when the registry wrote a bare number. */
export const versionText = (version: string): string => (/^v/i.test(version) ? version : `v${version}`);

type PinLike = { readonly commitSha: string | null; readonly computedHash: string | null; readonly registryVersion: string | null } | null;

/** The pin, mono: a skill's commit in 7, a site's skill by its hash in 7, a server's version. */
export const pinText = (pin: PinLike): string => {
  if (pin === null) return "—";
  if (pin.registryVersion !== null) return versionText(pin.registryVersion);
  if (pin.commitSha !== null) return pin.commitSha.slice(0, 7);
  if (pin.computedHash !== null) return pin.computedHash.slice(0, 7);
  return "—";
};

/** `sha256 7c1e…4b09`, the whole hash in a `title` beside it. */
export const hashText = (hash: string): string => `sha256 ${hash.slice(0, 4)}…${hash.slice(-4)}`;

/** A file's size, 1024-based: `912 B`, `14.2 KB`, `1.1 MB`. */
export const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? t("library.size.mb", { n: (bytes / (1024 * 1024)).toFixed(1) })
    : bytes >= 1024
      ? t("library.size.kb", { n: (bytes / 1024).toFixed(1) })
      : t("library.size.bytes", { n: bytes });

/** Who gets it: every profile, the profiles it's on, or none yet. */
export type UsedBy = { readonly kind: "every-profile" } | { readonly kind: "profiles"; readonly count: number } | { readonly kind: "none" };

export const usedByOf = (item: Pick<LibraryItem, "everyProfile" | "profiles">): UsedBy =>
  item.everyProfile ? { kind: "every-profile" } : item.profiles.length === 0 ? { kind: "none" } : { kind: "profiles", count: item.profiles.length };

export const usedByText = (usedBy: UsedBy): string => {
  switch (usedBy.kind) {
    case "every-profile":
      return t("library.row.everyProfile");
    case "profiles":
      return plural(usedBy.count, "library.row.profilesOne", "library.row.profilesMany");
    case "none":
      return "—";
    default:
      return usedBy satisfies never;
  }
};

/**
 * The row's last cell (library.md, "Every state"): a server that asks for a sign-in ostra doesn't
 * do yet, a source the list no longer allows (its updates refused), an update waiting for an admin
 * (never amber), or up to date.
 */
export type ItemStatus =
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "source-not-allowed" }
  | { readonly kind: "update"; readonly text: string }
  | { readonly kind: "up-to-date" };

export const statusOf = (item: Pick<LibraryItem, "kind" | "server" | "sourceAllowed" | "update">): ItemStatus => {
  if (item.kind === "mcp_server" && item.server?.needsOAuth === true) return { kind: "needs-sign-in" };
  if (!item.sourceAllowed) return { kind: "source-not-allowed" };
  const update = item.update;
  if (update !== null) {
    return {
      kind: "update",
      text:
        item.kind === "mcp_server" && update.registryVersion !== null
          ? versionText(update.registryVersion)
          : plural(update.files.length, "library.row.updateFilesOne", "library.row.updateFilesMany"),
    };
  }
  return { kind: "up-to-date" };
};

/** A server's second line ends with ` · remote` and its secrets (library.md, the row). */
export const descriptionOf = (item: Pick<LibraryItem, "kind" | "server" | "files">, skillDescription: string | null): string => {
  if (item.kind === "skill") return skillDescription ?? plural(item.files.length, "library.row.filesOne", "library.row.filesMany");
  const server = item.server;
  if (server === null) return t("library.row.remote");
  const secrets = server.inputs.filter((input) => input.secret).length;
  return [server.description ?? "", t("library.row.remote"), ...(secrets === 0 ? [] : [plural(secrets, "library.row.secretsOne", "library.row.secretsMany")])].filter((part) => part !== "").join(" · ");
};

// ---------- the list: tabs, the filter, bands ----------

export const libraryTabs = ["all", "skills", "mcp", "updates"] as const;
export type LibraryTab = (typeof libraryTabs)[number];

export const tabOf = (value: string | null): LibraryTab => libraryTabs.find((tab) => tab === value) ?? "all";

export const tabCounts = (items: readonly LibraryItem[]): Readonly<Record<LibraryTab, number>> => ({
  all: items.length,
  skills: items.filter((item) => item.kind === "skill").length,
  mcp: items.filter((item) => item.kind === "mcp_server").length,
  updates: items.filter((item) => item.update !== null).length,
});

/** Name, source and a server's description match the filter's words, without case. */
export const matchesFilter = (item: LibraryItem, query: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = `${item.name} ${sourceText(item)} ${sourceTitle(item.source)} ${item.server?.description ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/** What one profile gets (the `Profile:` menu): attached to it, or on every profile. */
export const onProfile = (item: LibraryItem, profileId: string | null): boolean => profileId === null || item.everyProfile || item.profiles.some((profile) => profile.profileId === profileId);

export type Band = { readonly kind: "skills" | "mcp"; readonly items: readonly LibraryItem[]; readonly shown: number };

/** The `All` tab's first rows of each band (library.md, item 6); the other tabs show every row. */
export const BAND_FIRST_ROWS = { skills: 4, mcp: 3 } as const;

/** The table's bands for a tab: `Skills` then `MCP servers`, each cut to its first rows on `All` unless opened. */
export const bandsOf = (items: readonly LibraryItem[], tab: LibraryTab, opened: ReadonlySet<"skills" | "mcp">): readonly Band[] => {
  const inTab = tab === "updates" ? items.filter((item) => item.update !== null) : items;
  const bands: Band[] = [];
  for (const kind of ["skills", "mcp"] as const) {
    if (tab === "skills" && kind === "mcp") continue;
    if (tab === "mcp" && kind === "skills") continue;
    const rows = inTab.filter((item) => (kind === "skills" ? item.kind === "skill" : item.kind === "mcp_server"));
    if (rows.length === 0) continue;
    const first = tab === "all" && !opened.has(kind) ? BAND_FIRST_ROWS[kind] : rows.length;
    bands.push({ kind, items: rows, shown: Math.min(first, rows.length) });
  }
  return bands;
};

/** The hosts the server calls for this organization (library.md, Policy's `Calls out to`). */
export const callsOutTo = (state: SearchState, sources: readonly SourceEntry[]): readonly string[] => {
  const hosts = [state.sendsTo.skills, ...state.sendsTo.registries.map(hostOf), ...sources.filter((entry) => entry.kind === "well_known_host").map((entry) => entry.value)];
  if (sources.some((entry) => entry.kind === "github_owner" || entry.kind === "github_repo")) hosts.push("github.com");
  return [...new Set(hosts.map((host) => hostOf(host.includes("://") ? host : `https://${host}`)))];
};

/** One entry of the allowlist as the policy lists it: `github.com/acme/*`, `registry io.sentry/*`. */
export const sourceEntryText = (entry: Pick<SourceEntry, "kind" | "value" | "namespace">): string => {
  switch (entry.kind) {
    case "github_owner":
      return `github.com/${entry.value}/*`;
    case "github_repo":
      return `github.com/${entry.value}`;
    case "well_known_host":
      return `${entry.value}/*`;
    case "registry":
      return `${t("library.policy.registryWord")} ${hostOf(entry.value)}${entry.namespace === null ? "" : ` ${entry.namespace.replace(/\/\*?$/, "")}/*`}`;
    default:
      return entry.kind satisfies never;
  }
};

// ---------- install by reference (library-install.md) ----------

/** The reference the look reads: the source as typed, with `#ref` when a ref was given. */
export const skillReference = (source: string, ref: string): string => {
  const typed = source.trim();
  const named = ref.trim();
  return named === "" || typed.includes("#") ? typed : `${typed}#${named}`;
};

/** A server's reference: its name in the registry, read from the registry picked (or each on the list). */
export const serverReference = (name: string, registryUrl: string | null): string => `registry:${name.trim()}${registryUrl === null ? "" : `@${registryUrl}`}`;

/** Why a file looks like a script, as its chip says. */
export const scriptChip = (reasons: readonly ("scripts-folder" | "shebang" | "executable")[]): string => {
  const words = reasons.map((reason) => {
    switch (reason) {
      case "scripts-folder":
        return t("library.install.scriptInScripts");
      case "shebang":
        return t("library.install.scriptShebang");
      case "executable":
        return t("library.install.scriptExecutable");
      default:
        return reason satisfies never;
    }
  });
  return t("library.install.scriptChip", { why: words.join(", ") });
};

/** One skill the look found, as its row draws it. */
export type SkillRow = {
  readonly folder: string;
  readonly name: string;
  readonly description: string | null;
  readonly files: number;
  readonly size: number;
  /** `null`: it can be installed. Else the first rule it breaks, in words. */
  readonly problem: string | null;
  /** Already in the library from this source, at its pin: shown, not offered again. */
  readonly inLibrary: string | null;
  readonly skill: ResolvedSkill;
};

const folderName = (folder: string): string => folder.split("/").at(-1) ?? folder;

/** The look's skills as rows: each one's name, description, files and size, and whether it can be installed. */
export const skillRowsOf = (look: SkillLook, items: readonly LibraryItem[]): readonly SkillRow[] =>
  look.skills.map((skill) => {
    const name = skill.check.ok ? skill.check.name : folderName(skill.folder) || t("library.install.rootSkill");
    const installed = items.find((item) => item.kind === "skill" && item.name === name && sameSource(item.source, look.source, skill.folder));
    const [first] = skill.check.ok ? [] : skill.check.problems;
    return {
      folder: skill.folder,
      name,
      description: skill.check.ok ? skill.check.description : null,
      files: skill.files.length,
      size: skill.files.reduce((total, file) => total + file.size, 0),
      problem: first === undefined ? null : t("library.install.cantInstall", { reason: first.message }),
      inLibrary: installed === undefined ? null : pinText(installed.pin),
      skill,
    };
  });

const sameSource = (source: LibrarySourceView, looked: SkillLook["source"], folder: string): boolean => {
  if (source.kind === "github" && looked.kind === "github") return source.owner.toLowerCase() === looked.owner.toLowerCase() && source.repo.toLowerCase() === looked.repo.toLowerCase() && source.path === folder;
  if (source.kind === "well_known" && looked.kind === "well_known") return source.url === looked.url;
  return false;
};

/** What the source line says about where it was read: a public repo, the GitHub App, a site. */
export const lookOrigin = (look: SkillLook): string => (look.source.kind === "github" ? t("library.install.fromGitHub") : t("library.install.fromSite", { host: hostOf(look.source.url) }));

/** The allowlist note's subject: `github.com/owner/repo`, the site's host, a registry's namespace. */
export const lookSubject = (look: Resolved): string => {
  if (look.kind === "server") return t("library.install.namespaceIn", { namespace: `${look.name.split("/")[0] ?? look.name}/*`, registry: hostOf(look.registryUrl) });
  return look.source.kind === "github" ? `github.com/${look.source.owner}/${look.source.repo}` : hostOf(look.source.url);
};

/** The entry `the whole owner instead` adds; `null` for anything but a GitHub repo. */
export const ownerEntryOf = (look: Resolved): { readonly kind: "github_owner"; readonly value: string } | null =>
  look.kind === "skills" && look.source.kind === "github" ? { kind: "github_owner", value: look.source.owner } : null;

/** Why a registry entry can't be installed (library-install.md, "What can't be installed"), as a refusal's words. */
export type ServerRefusalView = { readonly kind: "packages-only" | "sse-only" | "inactive" | "no-remote"; readonly title: string; readonly body: string };

export const serverRefusalOf = (look: ServerLook): ServerRefusalView | null => {
  const refusal = look.refusal;
  if (refusal === null) return null;
  const name = look.name.split("/").at(-1) ?? look.name;
  switch (refusal) {
    case "packages-only":
      return { kind: refusal, title: t("library.refusal.packagesTitle", { name }), body: t("library.refusal.packagesBody") };
    case "sse-only":
      return { kind: refusal, title: t("library.refusal.sseTitle"), body: t("library.refusal.sseBody", { name }) };
    case "inactive":
      return { kind: refusal, title: t("library.refusal.inactiveTitle", { name }), body: t("library.refusal.inactiveBody") };
    case "no-remote":
      return { kind: refusal, title: t("library.refusal.noRemoteTitle", { name }), body: t("library.refusal.noRemoteBody") };
    default:
      return refusal satisfies never;
  }
};

/** A server's name in the library: the registry name after its namespace, slugged as the install names it. */
export const libraryNameOf = (registryName: string): string =>
  (registryName.split("/").at(-1) ?? registryName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** An input's kind under its name: `in the URL`, `header`, `header · secret`. */
export const inputKindText = (input: { readonly kind: "variable" | "header"; readonly isSecret: boolean }): string =>
  input.kind === "variable" ? t("library.install.inUrl") : input.isSecret ? t("library.install.headerSecret") : t("library.install.header");

/**
 * A server install's inputs as the API takes them: each typed value by name, a secret one as a
 * secret (to the secret store), an empty one left out so the entry's default fills it.
 */
export const serverInputsOf = (
  inputs: readonly { readonly kind: "variable" | "header"; readonly name: string; readonly isSecret: boolean }[],
  values: Readonly<Record<string, string>>,
): { readonly variables: Record<string, { readonly kind: "plain" | "secret"; readonly value: string }>; readonly headers: Record<string, { readonly kind: "plain" | "secret"; readonly value: string }> } => {
  const variables: Record<string, { readonly kind: "plain" | "secret"; readonly value: string }> = {};
  const headers: Record<string, { readonly kind: "plain" | "secret"; readonly value: string }> = {};
  for (const input of inputs) {
    const value = values[`${input.kind}:${input.name}`] ?? "";
    if (value === "") continue;
    (input.kind === "variable" ? variables : headers)[input.name] = { kind: input.isSecret ? "secret" : "plain", value };
  }
  return { variables, headers };
};

/** The required inputs left empty, by name: Install waits for them. */
export const missingInputs = (inputs: readonly { readonly kind: "variable" | "header"; readonly name: string; readonly isRequired: boolean }[], values: Readonly<Record<string, string>>): readonly string[] =>
  inputs.filter((input) => input.isRequired && (values[`${input.kind}:${input.name}`] ?? "") === "").map((input) => input.name);

// ---------- the profile editor's library items (agent-profile-library.md) ----------

export const PROFILE_LIMITS = { skills: 50, servers: 20 } as const;

/** A row's origin: its own, attached from the library, or on every profile. */
export type RowOrigin = "own" | "attached" | "every-profile";

/** What the profile holds of each kind, by origin, as an editor's draft would save it. */
export type ProfileCounts = {
  readonly skills: { readonly own: number; readonly library: number; readonly every: number; readonly total: number };
  readonly servers: { readonly own: number; readonly library: number; readonly every: number; readonly total: number };
};

/** The library items a draft holds: those attached (the saved ones, with pending changes) and those inherited. */
export type DraftLibrary = {
  /** Attached in the draft, in the order they were attached. */
  readonly attached: readonly string[];
  /** On every profile, and not attached here. */
  readonly inherited: readonly string[];
};

export const profileCounts = (own: { readonly skills: number; readonly servers: number }, draft: DraftLibrary, kindOf: (itemId: string) => ItemKind | null): ProfileCounts => {
  const count = (ids: readonly string[], kind: ItemKind): number => ids.filter((id) => kindOf(id) === kind).length;
  const skills = { own: own.skills, library: count(draft.attached, "skill"), every: count(draft.inherited, "skill") };
  const servers = { own: own.servers, library: count(draft.attached, "mcp_server"), every: count(draft.inherited, "mcp_server") };
  return {
    skills: { ...skills, total: skills.own + skills.library + skills.every },
    servers: { ...servers, total: servers.own + servers.library + servers.every },
  };
};

/** Whether an item can be picked for this profile now, and why not (agent-profile-library.md, "The items' states"). */
export type Pickability =
  | { readonly kind: "attachable" }
  | { readonly kind: "attached" }
  | { readonly kind: "every-profile" }
  | { readonly kind: "name-taken" }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "source-not-allowed" }
  | { readonly kind: "at-limit" };

export type ProfileForPicker = {
  readonly ownSkillNames: readonly string[];
  readonly ownServerNames: readonly string[];
  readonly draft: DraftLibrary;
  readonly counts: ProfileCounts;
};

export const pickabilityOf = (item: Pick<LibraryItem, "itemId" | "kind" | "name" | "everyProfile" | "sourceAllowed" | "server">, profile: ProfileForPicker): Pickability => {
  if (profile.draft.attached.includes(item.itemId)) return { kind: "attached" };
  if (item.everyProfile) return { kind: "every-profile" };
  if (item.kind === "mcp_server" && item.server?.needsOAuth === true) return { kind: "needs-sign-in" };
  if (!item.sourceAllowed) return { kind: "source-not-allowed" };
  const own = item.kind === "skill" ? profile.ownSkillNames : profile.ownServerNames;
  if (own.includes(item.name)) return { kind: "name-taken" };
  const full = item.kind === "skill" ? profile.counts.skills.total >= PROFILE_LIMITS.skills : profile.counts.servers.total >= PROFILE_LIMITS.servers;
  if (full) return { kind: "at-limit" };
  return { kind: "attachable" };
};

/** Selectable in the picker: an attachable item attaches, an attached one detaches. */
export const selectable = (pickability: Pickability): boolean => pickability.kind === "attachable" || pickability.kind === "attached";

/** The picker's second line for an item it refuses, naming the profile. */
export const pickReason = (pickability: Pickability, profileName: string, itemName: string, kind: ItemKind): string | null => {
  switch (pickability.kind) {
    case "attachable":
    case "attached":
    case "every-profile":
      return null;
    case "name-taken":
      return t("agentProfiles.library.nameTaken", { profile: profileName, name: itemName });
    case "needs-sign-in":
      return t("agentProfiles.library.needsSignInLine");
    case "source-not-allowed":
      return t("agentProfiles.library.notAllowedLine");
    case "at-limit":
      return kind === "skill" ? t("agentProfiles.library.atSkillLimit", { profile: profileName, n: PROFILE_LIMITS.skills }) : t("agentProfiles.library.atServerLimit", { profile: profileName, n: PROFILE_LIMITS.servers });
    default:
      return pickability satisfies never;
  }
};

/** The refusal at a limit (agent-profile-library-limit.webp), naming the profile and the counts by origin. */
export const limitRefusal = (kind: ItemKind, itemName: string, profileName: string, counts: ProfileCounts): string => {
  const of = kind === "skill" ? counts.skills : counts.servers;
  return t(kind === "skill" ? "agentProfiles.library.refusedSkills" : "agentProfiles.library.refusedServers", {
    name: itemName,
    profile: profileName,
    n: kind === "skill" ? PROFILE_LIMITS.skills : PROFILE_LIMITS.servers,
    own: of.own,
    library: of.library,
    every: of.every,
  });
};

/** Attaching applies on Save: the library items the draft attaches and detaches against what's saved. */
export const libraryChanges = (saved: readonly string[], draft: readonly string[]): { readonly attach: readonly string[]; readonly detach: readonly string[] } => ({
  attach: draft.filter((id) => !saved.includes(id)),
  detach: saved.filter((id) => !draft.includes(id)),
});

// ---------- the marketplace (library-browse.md) ----------

/** A result's last cell: in the library already, its source not allowed, a server ostra can't install yet, or Install. */
export type ResultState =
  | { readonly kind: "in-library"; readonly item: LibraryItem }
  | { readonly kind: "not-allowed" }
  | { readonly kind: "refused"; readonly refusal: "inactive" | "packages-only" | "sse-only" | "no-remote" }
  | { readonly kind: "installable" };

export const resultStateOf = (result: SearchResult, items: readonly LibraryItem[]): ResultState => {
  const item = items.find((candidate) => {
    if (result.kind === "skill") {
      const [owner = "", repo = ""] = result.source.toLowerCase().split("/");
      return candidate.kind === "skill" && candidate.source.kind === "github" && candidate.source.owner.toLowerCase() === owner && candidate.source.repo.toLowerCase() === repo && candidate.name === result.skill;
    }
    return candidate.kind === "mcp_server" && candidate.source.kind === "registry" && candidate.source.name === result.name;
  });
  if (item !== undefined) return { kind: "in-library", item };
  if (result.kind === "server" && result.refusal !== null) return { kind: "refused", refusal: result.refusal };
  if (!result.sourceAllowed) return { kind: "not-allowed" };
  return { kind: "installable" };
};

/** A result's key in the list and the address (`?selected=`). */
export const resultKey = (result: SearchResult): string => result.reference;

/** Install counts as skills.sh shows them: `41.2k`, `212`. */
export const installsText = (n: number | null): string => (n === null ? "—" : n >= 1000 ? `${String(Number((n / 1000).toFixed(1)))}k` : String(n));

/** Where a source is: skills.sh's host, or a registry's. */
export const searchSourceHost = (source: SearchSource["source"]): string => (source.kind === "skills-search" ? source.host : hostOf(source.registryUrl));

// ---------- suggestions (library-suggestions.md) ----------

export const suggestionTabs = ["open", "decided"] as const;
export type SuggestionTab = (typeof suggestionTabs)[number];

/** A suggestion's kind, by its reference: a registry name is an MCP server, anything else a skill. */
export const suggestionKind = (reference: string): ItemKind => (reference.startsWith("registry:") ? "mcp_server" : "skill");

/** A suggestion's answer as the member reads it (`Your suggestions`). */
export const suggestionAnswer = (suggestion: Pick<MySuggestion, "state" | "createdAt" | "decidedAt" | "decidedBy">, now: number): string => {
  switch (suggestion.state) {
    case "open":
      return t("library.suggest.openSent", { age: ageWords(suggestion.createdAt, now) });
    case "installed":
      return t("library.suggest.installedBy", { name: suggestion.decidedBy?.name ?? t("library.someone"), date: dayText(suggestion.decidedAt ?? now) });
    case "dismissed":
      return t("library.suggest.dismissedBy", { name: suggestion.decidedBy?.name ?? t("library.someone"), date: dayText(suggestion.decidedAt ?? now) });
    default:
      return suggestion.state satisfies never;
  }
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** `4 Nov`, or `4 Nov 2025` in another year. */
export const dayText = (at: number, now: number = Date.now()): string => {
  const date = new Date(at);
  const month = t(`library.months.${MONTHS[date.getMonth()] ?? "jan"}`);
  return date.getFullYear() === new Date(now).getFullYear() ? `${String(date.getDate())} ${month}` : `${String(date.getDate())} ${month} ${String(date.getFullYear())}`;
};

/** `just now`, `3 hours ago`, `2 days ago`. */
export const ageWords = (at: number, now: number = Date.now()): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return t("library.age.justNow");
  if (minutes < 60) return plural(minutes, "library.age.minutesOne", "library.age.minutesMany");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "library.age.hoursOne", "library.age.hoursMany");
  return plural(Math.round(hours / 24), "library.age.daysOne", "library.age.daysMany");
};

// ---------- one item's page (library-update.md) ----------

/** A `SKILL.md`'s front matter as key/value rows, and its body: plain text, never HTML. */
export const frontMatterOf = (text: string): { readonly fields: readonly { readonly key: string; readonly value: string }[]; readonly body: string } => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { fields: [], body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { fields: [], body: text };
  const fields: { key: string; value: string }[] = [];
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) fields.push({ key: match[1], value: match[2] ?? "" });
    else if (fields.length > 0 && /^\s+/.test(line)) {
      const last = fields.at(-1);
      if (last !== undefined) last.value = `${last.value} ${line.trim()}`.trim();
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
};

/** The item page's tabs: a skill's `SKILL.md`, files and profiles, a server's remote and tools; `Update` only while one waits. */
export type ItemTab = "skill" | "files" | "server" | "tools" | "used-by" | "update";

export const itemTabsOf = (item: Pick<LibraryItem, "kind" | "update">): readonly ItemTab[] => [
  ...(item.kind === "skill" ? (["skill", "files"] as const) : (["server", "tools"] as const)),
  "used-by",
  ...(item.update === null ? [] : (["update"] as const)),
];

/** The tab a page opens on: the one asked for if it's there, else `Update` while one waits, else the first. */
export const itemTabOf = (item: Pick<LibraryItem, "kind" | "update">, asked: string | null): ItemTab => {
  const tabs = itemTabsOf(item);
  const found = tabs.find((tab) => tab === asked);
  if (found !== undefined) return found;
  return item.update === null ? (tabs[0] ?? "used-by") : "update";
};

/** Why an update can't be accepted, in words; `null` when an admin can. */
export const updateRefusalText = (refusal: NonNullable<LibraryItem["update"]>["refusal"], source: string): string | null => {
  switch (refusal) {
    case null:
      return null;
    case "not-allowed":
      return t("library.item.notAllowed", { source });
    case "needs-oauth":
      return t("library.item.updateNeedsOAuth");
    case "needs-input":
      return t("library.item.updateNeedsInput");
    default:
      return refusal satisfies never;
  }
};
