import type { DbEnum } from "@ostra/db";

import { registryUrlOf } from "./reference.ts";

// F-145 (ADR 0069, Q322, ticket 06): the organization's allowlist of sources, matched by source and
// never by name, since a name "is not a security control" (research §1, summary 8). An entry is a
// GitHub owner, a GitHub repo, a well-known host, or a registry's URL narrowed, or not, to a
// namespace. Every install, update and suggestion is matched against it. Each kind is matched
// exactly: an owner isn't a prefix of another (`acme` never allows `acme-tools`), a host never
// allows its subdomain, and a namespace never allows its sibling. Pure.

/** An entry of the list, as a `LibrarySource` row holds it. */
export type AllowlistEntry =
  | { readonly kind: "github_owner"; readonly value: string }
  /** `owner/repo`. */
  | { readonly kind: "github_repo"; readonly value: string }
  /** A host, such as `skills.acme.dev`. */
  | { readonly kind: "well_known_host"; readonly value: string }
  /** A registry's address, and the namespace it's narrowed to (`io.github.github`), or `null` for all of it. */
  | { readonly kind: "registry"; readonly value: string; readonly namespace: string | null };

/** What's matched: where an item, or a reference to one, comes from. A server's registry is the concrete one it's read from. */
export type AllowlistSubject =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string }
  | { readonly kind: "well_known"; readonly url: string }
  | { readonly kind: "registry"; readonly registryUrl: string; readonly name: string };

export type AllowlistMatch<Entry extends AllowlistEntry = AllowlistEntry> = { readonly allowed: true; readonly entry: Entry } | { readonly allowed: false };

/** GitHub's logins and repo names are matched without case, as GitHub matches them. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A namespace as an entry may write it: `io.github.github`, or `io.github.github/*`. */
const namespaceOf = (value: string): string => value.replace(/\/\*?$/, "");

const hostOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).hostname.toLowerCase() : null);

const matches = (subject: AllowlistSubject, entry: AllowlistEntry): boolean => {
  switch (subject.kind) {
    case "github":
      return (entry.kind === "github_owner" && same(entry.value, subject.owner)) || (entry.kind === "github_repo" && same(entry.value, `${subject.owner}/${subject.repo}`));
    case "well_known": {
      const host = hostOf(subject.url);
      return entry.kind === "well_known_host" && host !== null && host === entry.value.toLowerCase();
    }
    case "registry": {
      if (entry.kind !== "registry") {
        return false;
      }
      const registry = registryUrlOf(subject.registryUrl);
      if (registry === null || registry !== registryUrlOf(entry.value)) {
        return false;
      }
      const slash = subject.name.indexOf("/");
      return entry.namespace === null || (slash > 0 && subject.name.slice(0, slash) === namespaceOf(entry.namespace));
    }
    default:
      return subject satisfies never;
  }
};

/** Whether the list allows the source, and by which entry (the list says who added each one). */
export const allowed = <Entry extends AllowlistEntry>(subject: AllowlistSubject, sources: readonly Entry[]): AllowlistMatch<Entry> => {
  const entry = sources.find((candidate) => matches(subject, candidate));
  return entry === undefined ? { allowed: false } : { allowed: true, entry };
};

/** What `library.seed-sources` puts on every organization's list (Q324): GitHub's curated MCP registry, all of it. */
export const SEEDED_REGISTRY_SOURCE = { kind: "registry", value: "https://api.mcp.github.com", namespace: null } as const satisfies AllowlistEntry;

/** A `LibrarySource` row as an entry of the list. */
export const allowlistEntryFromRow = (row: { readonly kind: DbEnum.LibrarySourceKind; readonly value: string; readonly namespace: string | null }): AllowlistEntry => {
  switch (row.kind) {
    case "github_owner":
    case "github_repo":
    case "well_known_host":
      return { kind: row.kind, value: row.value };
    case "registry":
      return { kind: "registry", value: row.value, namespace: row.namespace };
    default:
      return row.kind satisfies never;
  }
};

/** The entry an admin adds, in the same dialog, to allow a source that isn't on the list: its repo, its host, or its registry's namespace. */
export const allowlistEntryFor = (subject: AllowlistSubject): AllowlistEntry => {
  switch (subject.kind) {
    case "github":
      return { kind: "github_repo", value: `${subject.owner}/${subject.repo}` };
    case "well_known":
      return { kind: "well_known_host", value: hostOf(subject.url) ?? subject.url };
    case "registry": {
      const slash = subject.name.indexOf("/");
      return { kind: "registry", value: registryUrlOf(subject.registryUrl) ?? subject.registryUrl, namespace: slash > 0 ? subject.name.slice(0, slash) : null };
    }
    default:
      return subject satisfies never;
  }
};
