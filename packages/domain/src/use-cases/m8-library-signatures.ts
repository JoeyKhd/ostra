import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type {
  AgentProfileId,
  BlobId,
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
 * Writes a library file as one of the organization's blobs, with no task, purpose `library-file`
 * (spec section 5.3). Core writes through its blob service; the panel through core's blob endpoint.
 */
export type LibraryBlobs = {
  readonly put: (
    organizationId: OrganizationId,
    bytes: Uint8Array,
  ) => Promise<{ readonly ok: true; readonly blobId: BlobId } | { readonly ok: false; /** Words, never content. */ readonly message: string }>;
};

/**
 * What a library use case takes: the database, the ports (the code host reads a repo at a commit,
 * the secret store keeps a server's secret inputs), the outbound fetch for well-known hosts,
 * registries, the test call and the search, and the library's settings.
 */
export type LibraryDeps = { readonly db: Db } & Ports & {
    /** Calls only the source an admin named, with ostra's `User-Agent` and nothing that identifies the install. */
    readonly fetch: typeof fetch;
    readonly settings: LibrarySettings;
    // ---- ticket 27 ----
    /** Where an install writes a skill's files. */
    readonly blobs: LibraryBlobs;
    /** The server's version: every call out carries `User-Agent: ostra/<version>` and nothing else of the install's. */
    readonly serverVersion: string;
    /** Lines carry the item's ID, kind and source kind: never a file's content, a header's value or a secret. */
    readonly logger: Logger;
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

/**
 * A refusal `profileItems` gave, naming the profile; a server that needs a sign-in ostra doesn't do
 * yet; or (ticket 28) a server whose version lists no tools, tested first, that didn't answer.
 */
export type AttachError = "forbidden" | "not-found" | "needs-oauth" | "unavailable" | ProfileItemsRefusal["code"];

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

/** Ticket 28: an admin marks a library server read-only (plan mode may call it, and "Reaching the network" doesn't ask), or not. */
export type SetReadOnly = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly itemId: LibraryItemId; readonly readOnly: boolean },
) => Promise<UseCaseResult<{ readonly readOnly: boolean }, "forbidden" | "not-found">>;

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
  /** `commit` is `null` for a site's well-known skill, which has none. */
  | { readonly kind: "skill"; readonly versionId: LibraryItemVersionId; readonly commit: GitSha | null; readonly diff: SkillDiff }
  | { readonly kind: "server"; readonly versionId: LibraryItemVersionId; readonly registryVersion: string; readonly diff: ServerDiff };

/** Reads a library file's bytes back: the update check diffs the current version's files (ticket 28). */
export type LibraryBlobRead = (
  organizationId: OrganizationId,
  blobId: BlobId,
) => Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; /** Words, never content. */ readonly message: string }>;

/** What the update check takes beyond the library's deps: core's reader of the organization's blobs. */
export type LibraryCheckDeps = LibraryDeps & { readonly readBlob: LibraryBlobRead };

/**
 * `library.check-updates`: each item of an organization (or one item, on demand) read again at its
 * source; an `available` version with its diff when the pin moved and the content changed. An
 * update whose source was taken off the allowlist is stored and can't be accepted (`refused`
 * counts them). `found` holds each item whose check ran to the end, `none` included; `failed`
 * counts those whose source couldn't be read, or whose new version ostra can't take.
 */
export type CheckUpdates = (
  deps: LibraryCheckDeps,
  input: { readonly organizationId: OrganizationId; readonly itemId: LibraryItemId | null },
) => Promise<{
  readonly checked: number;
  readonly found: readonly { readonly itemId: LibraryItemId; readonly update: UpdateFound }[];
  readonly refused: number;
  readonly failed: number;
}>;

/** An admin's "Check for updates" on one item: `library.check-updates` for it, keyed by the item. */
export type RequestUpdateCheck = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly itemId: LibraryItemId },
) => Promise<UseCaseResult<{ readonly requested: true }, "forbidden" | "not-found">>;

/**
 * The available version becomes current, and the old one superseded; the next dispatch of every
 * attached profile's tasks takes it. Refused when its source is off the list (`not-allowed`), and
 * for a server that now asks for a sign-in (`needs-oauth`) or for an input the item lacks
 * (`needs-input`, which a new install gives).
 */
export type AcceptUpdate = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly versionId: LibraryItemVersionId },
) => Promise<
  UseCaseResult<{ readonly currentVersionId: LibraryItemVersionId }, "forbidden" | "not-found" | "not-allowed-in-state" | "not-allowed" | "needs-oauth" | "needs-input">
>;

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

/** The admins' quiet counts on the library: open suggestions, and items with an update waiting. */
export type LibraryCounts = (
  deps: Pick<LibraryDeps, "db">,
  scope: MemberScope,
) => Promise<UseCaseResult<{ readonly openSuggestions: number; readonly updatesWaiting: number }, "forbidden">>;

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

/** Where a search goes: the skills search (`OSTRA_SKILLS_SEARCH_URL`, named by its host) or a registry on the organization's list. */
export type MarketplaceSource = { readonly kind: "skills-search"; readonly host: string } | { readonly kind: "registry"; readonly registryUrl: string };

/**
 * A result, with whether its source is on the list. It installs through `resolveReference` and
 * `installItem` with its `reference`, never a shortcut, so a source that isn't allowed is refused
 * until an admin allows it. Its text is the source's, shown as data. No third-party audit verdict (Q319).
 */
export type MarketplaceResult =
  | {
      readonly kind: "skill";
      /** `<owner>/<repo>@<skill>`. */
      readonly reference: string;
      /** The GitHub repo, `owner/repo`. */
      readonly source: string;
      readonly skill: string;
      readonly name: string;
      /** skills.sh's count, from the `skills` CLI's telemetry; `null` when it gave none. */
      readonly installs: number | null;
      readonly sourceAllowed: boolean;
    }
  | {
      readonly kind: "server";
      /** `registry:<name>@<registry URL>`: the install reads the same registry. */
      readonly reference: string;
      readonly registryUrl: string;
      readonly name: string;
      readonly title: string | null;
      readonly version: string;
      readonly description: string | null;
      /** `null`: it has a remote ostra installs; else why not, as the install would refuse it. */
      readonly refusal: ServerRefusal | null;
      readonly sourceAllowed: boolean;
    };

/** One source's search: its results (and how many entries didn't read), or that it's unavailable (a failed or malformed answer). */
export type MarketplaceSourceResults =
  | { readonly source: MarketplaceSource; readonly state: "ok"; readonly results: readonly MarketplaceResult[]; readonly dropped: number }
  | { readonly source: MarketplaceSource; readonly state: "unavailable"; /** For a person: never the source's own text. */ readonly message: string };

/** Which switch keeps search off: the install's (`OSTRA_MARKETPLACE_SEARCH=false`), which wins, or the organization's own. */
export type MarketplaceSearchOff = "instance" | "organization";

/** The switch as the library shows it: whether search is on, which setting keeps it off, and where a search sends the admin's words. */
export type MarketplaceSearchState = {
  readonly enabled: boolean;
  /** The organization admin's switch. */
  readonly organizationOn: boolean;
  /** `OSTRA_MARKETPLACE_SEARCH`. */
  readonly instanceAllows: boolean;
  /** `null` while search is on. */
  readonly off: MarketplaceSearchOff | null;
  /** What a search sends where: the words, to the skills search's host and to each registry on the list. */
  readonly sendsTo: { readonly skills: string; readonly registries: readonly string[] };
};

/** Behind the organization's switch and the instance's setting; sends the admin's words and nothing else. An organization admin's. */
export type SearchMarketplace = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly kind: "skills" | "servers"; /** Never logged. */ readonly words: string },
) => Promise<UseCaseResult<{ readonly sources: readonly MarketplaceSourceResults[] }, "forbidden" | "instance-search-off" | "organization-search-off" | "invalid-input">>;

/** The switch's state, for the library's page. An organization admin's. */
export type ReadMarketplaceSearch = (deps: LibraryDeps, scope: MemberScope) => Promise<UseCaseResult<{ readonly state: MarketplaceSearchState }, "forbidden">>;

/** The organization admin's switch, audited; refused on while `OSTRA_MARKETPLACE_SEARCH=false`. */
export type SetMarketplaceSearch = (
  deps: LibraryDeps,
  scope: MemberScope,
  input: { readonly enabled: boolean },
) => Promise<UseCaseResult<{ readonly state: MarketplaceSearchState }, "forbidden" | "instance-search-off">>;
