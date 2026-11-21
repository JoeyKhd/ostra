import type { Db } from "@ostra/db";
import type {
  AgentProfileId,
  GitSha,
  LibraryItemId,
  LibraryItemVersionId,
  LibrarySourceId,
  LibrarySuggestionId,
  OrganizationId,
} from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { AllowlistEntry, AllowlistMatch } from "../library/allowed.ts";
import type { ScriptFile, SkillProblem } from "../library/check-skill.ts";
import type { ServerDiff, SkillDiff } from "../library/diffs.ts";
import type { ProfileItemsRefusal } from "../library/profile-items.ts";
import type { LibraryReference } from "../library/reference.ts";
import type { Ports } from "../ports.ts";
import type { LibrarySettings } from "../settings.ts";
import type { UseCaseResult } from "./common.ts";

// Milestone 8's library use cases (spec section 5.4, ticket 06's list; ADR 0069): each one's
// input, result and signature. The signature is the contract core's library (tickets 27 to 29),
// the API's router (ticket 30) and the tests are written against; the bodies come with tickets 27,
// 28 and 29. The pure parts have their bodies in `../library/`. Every write is one transaction
// with its change notice and its audit entry (ADR 0011, ADR 0054). Never logged: a skill's files,
// a header's value, a secret input, a suggestion's note and a search's words.

/**
 * What a library use case takes: the database, the ports (the code host reads a repo at a commit,
 * the secret store keeps a server's secret inputs), the outbound fetch for well-known hosts,
 * registries, the test call and the search, and the library's settings.
 */
export type LibraryDeps = { readonly db: Db } & Ports & {
    /** Calls only the source an admin named, with ostra's `User-Agent` and nothing that identifies the install. */
    readonly fetch: typeof fetch;
    readonly settings: LibrarySettings;
  };

// ---------- resolving a reference: an admin's look before installing (ticket 27) ----------

/** One file of a skill found at a source, as the install dialog lists it. Its bytes stay in core. */
export type ResolvedSkillFile = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
};

/** A skill found at a source: its folder, its check against the spec and ostra's limits, its files and hash. */
export type ResolvedSkill = {
  /** The skill's folder: repo-relative for GitHub (`""` at the root), its name for a well-known index. */
  readonly folder: string;
  readonly check: { readonly ok: true; readonly name: string; readonly description: string } | { readonly ok: false; readonly problems: readonly SkillProblem[] };
  readonly scripts: readonly ScriptFile[];
  readonly files: readonly ResolvedSkillFile[];
  /** The `skills` CLI's `computedHash`, which the install checks again at the same commit. */
  readonly computedHash: string;
};

/** An input a server's remote asks for: a URL variable or a header. A secret one goes to the secret store. */
export type ServerInputSpec = {
  readonly kind: "variable" | "header";
  readonly name: string;
  readonly isSecret: boolean;
  readonly isRequired: boolean;
  /** The entry's words for it. Untrusted text, shown as data. */
  readonly description: string | null;
};

/** Why a registry entry can't be installed in milestone 8. */
export type ServerRefusal = "inactive" | "packages-only" | "sse-only" | "no-remote";

export type ResolvedReference =
  | {
      readonly kind: "skills";
      readonly source: { readonly kind: "github"; readonly owner: string; readonly repo: string } | { readonly kind: "well_known"; readonly url: string };
      /** The commit the ref named; `null` for a well-known site. */
      readonly commit: GitSha | null;
      /** Each folder holding a `SKILL.md`, at most four folders deep, or the one `@skill` named. */
      readonly skills: readonly ResolvedSkill[];
      /** Folders deeper than four with a `SKILL.md`, not offered. */
      readonly tooDeep: number;
      readonly allowed: AllowlistMatch;
      /** What an admin adds, in the same dialog, to allow it. */
      readonly entryToAllow: AllowlistEntry;
    }
  | {
      readonly kind: "server";
      readonly registryUrl: string;
      readonly name: string;
      readonly version: string;
      readonly description: string | null;
      /** The `streamable-http` remote's URL template, or `null` when there's none. */
      readonly remoteUrl: string | null;
      readonly inputs: readonly ServerInputSpec[];
      /** `null`: installable. */
      readonly refusal: ServerRefusal | null;
      readonly allowed: AllowlistMatch;
      readonly entryToAllow: AllowlistEntry;
    };

export type ResolveReferenceError =
  | "forbidden"
  | "invalid-reference"
  | "not-found"
  /** The code host lacks `readTree` (`readTreeRefusal`'s words). */
  | "unsupported-host"
  | "rate-limited"
  | "unavailable"
  /** A well-known entry's bytes didn't match its digest: never a fallback. */
  | "digest-mismatch"
  | "too-large";

/** Writes nothing. An organization admin's. */
export type ResolveReference = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly reference: string },
) => Promise<UseCaseResult<{ readonly reference: LibraryReference; readonly resolved: ResolvedReference }, ResolveReferenceError>>;

// ---------- installing (ticket 27) ----------

/** A server input's value as the admin typed it. A secret one is written to the secret store and kept as a reference. Never logged. */
export type ServerInputValue = { readonly kind: "plain"; readonly value: string } | { readonly kind: "secret"; readonly value: string };

export type InstallItemInput =
  | {
      readonly kind: "skill";
      readonly reference: string;
      /** The folder picked from the look. */
      readonly folder: string;
      /** The look's commit and hash: a source that changed since is refused (`hash-changed`). */
      readonly commit: GitSha | null;
      readonly computedHash: string;
      /** Add the source to the allowlist in the same call, with its own audit entry. */
      readonly allowSource: boolean;
    }
  | {
      readonly kind: "server";
      readonly reference: string;
      readonly version: string;
      /** By input name: every required one, and no other. */
      readonly variables: Readonly<Record<string, ServerInputValue>>;
      readonly headers: Readonly<Record<string, ServerInputValue>>;
      readonly allowSource: boolean;
    };

export type InstallItem = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: InstallItemInput,
) => Promise<
  UseCaseResult<
    { readonly itemId: LibraryItemId; readonly versionId: LibraryItemVersionId },
    ResolveReferenceError | "not-allowed" | "hash-changed" | "skill-refused" | "server-refused" | "name-taken" | "invalid-input"
  >
>;

/** The test call: `tools/list` with the item's headers, under 10 s. Stores the tools' names, or marks `needsOAuth`. */
export type TestServer = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly itemId: LibraryItemId },
) => Promise<UseCaseResult<{ readonly toolNames: readonly string[]; readonly needsOAuth: boolean }, "forbidden" | "not-found" | "unavailable" | "invalid-response">>;

// ---------- attaching, every profile, removing (ticket 28) ----------

/** A refusal `profileItems` gave, naming the profile; or a server that needs a sign-in ostra doesn't do yet. */
export type AttachError = "forbidden" | "not-found" | "needs-oauth" | ProfileItemsRefusal["code"];

export type AttachItem = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly profileId: AgentProfileId; readonly itemId: LibraryItemId },
) => Promise<UseCaseResult<{ readonly attachedAt: number }, AttachError>>;

export type DetachItem = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly profileId: AgentProfileId; readonly itemId: LibraryItemId },
) => Promise<UseCaseResult<{ readonly detached: boolean }, "forbidden" | "not-found">>;

/** On or off every profile, the built-in ones included: refused when it would break a profile's limits, naming it. */
export type SetEveryProfile = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly itemId: LibraryItemId; readonly everyProfile: boolean },
) => Promise<UseCaseResult<{ readonly everyProfile: boolean }, AttachError>>;

/** Detaches it everywhere; tasks lose it at their next session. */
export type RemoveItem = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly itemId: LibraryItemId },
) => Promise<UseCaseResult<{ readonly removedAt: number }, "forbidden" | "not-found">>;

// ---------- updates (ticket 28) ----------

/** What one item's check found. */
export type UpdateFound =
  | { readonly kind: "none" }
  | { readonly kind: "skill"; readonly versionId: LibraryItemVersionId; readonly commit: GitSha; readonly diff: SkillDiff }
  | { readonly kind: "server"; readonly versionId: LibraryItemVersionId; readonly registryVersion: string; readonly diff: ServerDiff };

/**
 * `library.check-updates`: each item of an organization (or one item, on demand) read again at its
 * source; an `available` version with its diff when the pin moved and the content changed. A
 * source taken off the allowlist refuses its items' updates.
 */
export type CheckUpdates = (
  deps: LibraryDeps,
  input: { readonly organizationId: OrganizationId; readonly itemId: LibraryItemId | null },
) => Promise<{ readonly checked: number; readonly found: readonly { readonly itemId: LibraryItemId; readonly update: UpdateFound }[]; readonly refused: number }>;

/** The available version becomes current, and the old one superseded; the next dispatch of every attached profile's tasks takes it. */
export type AcceptUpdate = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly versionId: LibraryItemVersionId },
) => Promise<UseCaseResult<{ readonly currentVersionId: LibraryItemVersionId }, "forbidden" | "not-found" | "not-allowed-in-state" | "not-allowed">>;

/** The item stays where it is; a newer version shows again. */
export type DismissUpdate = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly versionId: LibraryItemVersionId },
) => Promise<UseCaseResult<{ readonly dismissedAt: number }, "forbidden" | "not-found" | "not-allowed-in-state">>;

// ---------- suggestions (ticket 28) ----------

/** A member's suggestion: a reference and a note, never logged. Says when its source isn't on the list. */
export type SuggestItem = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly reference: string; readonly note: string },
) => Promise<UseCaseResult<{ readonly suggestionId: LibrarySuggestionId; readonly sourceAllowed: boolean }, "invalid-reference" | "invalid-input">>;

export type DecideSuggestion = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly suggestionId: LibrarySuggestionId; readonly decision: { readonly kind: "installed"; readonly itemId: LibraryItemId } | { readonly kind: "dismissed" } },
) => Promise<UseCaseResult<{ readonly decidedAt: number }, "forbidden" | "not-found" | "not-allowed-in-state">>;

// ---------- the allowlist (ticket 27) ----------

export type AddSource = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly entry: AllowlistEntry },
) => Promise<UseCaseResult<{ readonly sourceId: LibrarySourceId }, "forbidden" | "invalid-input" | "conflict">>;

/** Its items stay installed, marked, and their updates are refused. */
export type RemoveSource = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly sourceId: LibrarySourceId },
) => Promise<UseCaseResult<{ readonly itemsMarked: number }, "forbidden" | "not-found">>;

/** `library.seed-sources`: GitHub's MCP registry on the organization's list (Q324), once. */
export type SeedSources = (deps: LibraryDeps, input: { readonly organizationId: OrganizationId }) => Promise<{ readonly added: boolean }>;

// ---------- the marketplace (ticket 29) ----------

/** A result, with whether its source is on the list; it installs through `resolveReference` and `installItem`, never a shortcut. */
export type MarketplaceResult =
  | { readonly kind: "skill"; readonly reference: string; readonly source: string; readonly name: string; readonly installs: number | null; readonly sourceAllowed: boolean }
  | { readonly kind: "server"; readonly reference: string; readonly registryUrl: string; readonly name: string; readonly version: string; readonly description: string | null; readonly sourceAllowed: boolean };

/** One source's search: its results, or that it's unavailable (a failed or malformed answer). */
export type MarketplaceSourceResults =
  | { readonly source: "skills.sh" | { readonly registryUrl: string }; readonly state: "ok"; readonly results: readonly MarketplaceResult[]; readonly dropped: number }
  | { readonly source: "skills.sh" | { readonly registryUrl: string }; readonly state: "unavailable" };

/** Behind the organization's switch and the instance's setting; sends the admin's words and nothing else. */
export type SearchMarketplace = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly query: string; readonly kind: "skills" | "servers" },
) => Promise<UseCaseResult<{ readonly sources: readonly MarketplaceSourceResults[] }, "forbidden" | "search-off" | "invalid-input">>;

/** The organization admin's switch; refused on while `OSTRA_MARKETPLACE_SEARCH=false`. */
export type SetMarketplaceSearch = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly enabled: boolean },
) => Promise<UseCaseResult<{ readonly enabled: boolean }, "forbidden" | "search-off">>;

