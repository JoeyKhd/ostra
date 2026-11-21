import type { Db, Tx } from "@ostra/db";
import type { OrganizationId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type {
  LibraryDeps,
  MarketplaceResult,
  MarketplaceSearchState,
  MarketplaceSource,
  MarketplaceSourceResults,
  ReadMarketplaceSearch,
  SearchMarketplace,
  SetMarketplaceSearch,
} from "../use-cases/m8-library-signatures.ts";
import { allowed } from "./allowed.ts";
import type { AllowlistEntry } from "./allowed.ts";
import { callOut, jsonOf, outboundFailureWords } from "./outbound.ts";
import type { OutboundDeps, OutboundFailure } from "./outbound.ts";
import { listedRegistries, serverOfferOf } from "./registry-source.ts";
import { allowlistOf } from "./sources.ts";
import { parseRegistryList, parseSkillsSearch, registryStatusOf } from "./vendor.ts";
import type { RegistryEntry, SkillsSearchResult } from "./vendor.ts";

// F-146 (ADR 0069, "The marketplace browser"; ADR 0021 amended; Q316, Q317, Q319, Q324; ticket 29):
// an organization admin's search of skills.sh and the organization's MCP registries, from the
// server and never from the browser, and only while both the organization's switch and the
// install's `OSTRA_MARKETPLACE_SEARCH` allow it.
// - Skills: `GET <OSTRA_SKILLS_SEARCH_URL>?q=<words>`, the `skills` CLI's endpoint, which isn't a
//   documented public API (Q317), read by ticket 06's tolerant reader.
// - MCP servers: `GET <registry>/v0.1/servers?search=<words>&version=latest` for each registry on
//   the list, at once. An entry that isn't `active` is dropped.
// - What's sent: the admin's words, and `User-Agent: ostra/<version>` (`callOut`); no member,
//   organization or install identifier, no cookie and no credential.
// - Each call has 8 s and a capped body. A source that fails or answers what isn't a search's is
//   "unavailable" on its own, never an error for the page, and its line carries its host and
//   status: never the words, nor the URL that holds them.
// - Each result says whether its source is on the allowlist, and installs through
//   `resolveReference` and `installItem` with its reference, as any other install.

/** A search's limits *(working values, but the 8 s, which is ticket 29's)*. */
export type MarketplaceSearchLimits = {
  /** Each call's deadline, the body's read included. */
  readonly deadlineMs: number;
  readonly skillsMaxBytes: number;
  /** One page of a registry's list. */
  readonly registryMaxBytes: number;
  /** The most results kept from one source. */
  readonly resultsMax: number;
};

export const MARKETPLACE_SEARCH_LIMITS = {
  deadlineMs: 8_000,
  skillsMaxBytes: 1024 * 1024,
  registryMaxBytes: 2 * 1024 * 1024,
  resultsMax: 50,
} as const satisfies MarketplaceSearchLimits;

/** The longest words a search sends. */
export const MARKETPLACE_WORDS_MAX = 100;
/** The fewest: a registry's `search` takes at least 3 characters (research §3.1). */
const WORDS_MIN = { skills: 2, servers: 3 } as const;

/** Why search is off on the whole install, for the switch and the refusal. */
export const INSTANCE_SEARCH_OFF_WORDS =
  "Marketplace search is off for this whole install (OSTRA_MARKETPLACE_SEARCH=false), so an organization admin can't turn it on. Installing by reference still works";
/** Why search is off in this organization. */
export const ORGANIZATION_SEARCH_OFF_WORDS =
  "Marketplace search is off in this organization until an organization admin turns it on in the library. Installing by reference still works";

/** What the switch says a search sends where (ADR 0069: "the switch says so"). */
export const marketplaceSearchSendsWords = (sendsTo: MarketplaceSearchState["sendsTo"]): string => {
  const registries = sendsTo.registries.map((url) => new URL(url).host);
  const servers = registries.length === 0 ? "no registry yet, since the list has none" : `each registry on the list (${registries.join(", ")})`;
  return `A search sends the words you type, and nothing else about you or this install, to ${sendsTo.skills} for skills and to ${servers} for MCP servers`;
};

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const loggerOf = (deps: LibraryDeps) => deps.logger.child({ component: "library" });
const outbound = (deps: LibraryDeps): OutboundDeps => ({ fetch: deps.fetch, serverVersion: deps.serverVersion });

/** The words as sent: trimmed, runs of space as one; `null` when too short, too long or holding a control character. */
const wordsOf = (kind: "skills" | "servers", typed: string): string | null => {
  const words = typed.trim().replace(/\s+/g, " ");
  return words.length < WORDS_MIN[kind] || words.length > MARKETPLACE_WORDS_MAX || /\p{Cc}/u.test(words) ? null : words;
};

// ---------- one source's call ----------

/** Why a source's search is unavailable: the call's own failure, an HTTP status that isn't 2xx, or an answer that isn't a search's. */
export type SearchFailureReason = Extract<OutboundFailure, { readonly kind: "unavailable" }>["reason"] | "too-large" | "http-status" | "malformed";

export type SourceSearch<T> =
  | { readonly ok: true; readonly results: readonly T[]; readonly dropped: number }
  | {
      readonly ok: false;
      readonly host: string;
      /** The HTTP status, when there was an answer. */
      readonly status: number | null;
      readonly reason: SearchFailureReason;
      readonly message: string;
    };

const unavailable = (host: string, status: number | null, reason: SearchFailureReason, why: string): Extract<SourceSearch<never>, { readonly ok: false }> => ({
  ok: false,
  host,
  status,
  reason,
  message: `Search at ${host} is unavailable: ${why}. Installing by reference still works`,
});

/** One GET of a search, under its deadline and cap: the body read as JSON, or why the source is unavailable. */
const searchCall = async (
  deps: OutboundDeps,
  url: URL,
  maxBytes: number,
  deadlineMs: number,
): Promise<{ readonly ok: true; readonly status: number; readonly data: unknown } | Extract<SourceSearch<never>, { readonly ok: false }>> => {
  const host = url.host;
  // Same-origin redirects only (`callOut`): a search never follows one to another host.
  const answer = await callOut(deps, url.toString(), { headers: { accept: "application/json" }, maxBytes, signal: AbortSignal.timeout(deadlineMs), followRedirects: true });
  if (!answer.ok) {
    return unavailable(host, null, answer.failure.kind === "too-large" ? "too-large" : answer.failure.reason, outboundFailureWords(host, answer.failure));
  }
  const status = answer.answer.status;
  if (status < 200 || status >= 300) {
    return unavailable(host, status, "http-status", `${host} answered HTTP ${String(status)}`);
  }
  return { ok: true, status, data: jsonOf(answer.answer.bytes) };
};

/** Each item whose key no earlier one had, in order. */
const firstOfEach = <T>(items: readonly T[], keyOf: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** skills.sh's search (or `OSTRA_SKILLS_SEARCH_URL`'s): each result with its source, its skill, its name and its install count. */
export const searchSkillsAt = async (
  deps: OutboundDeps,
  searchUrl: string,
  words: string,
  limits: MarketplaceSearchLimits = MARKETPLACE_SEARCH_LIMITS,
): Promise<SourceSearch<SkillsSearchResult>> => {
  const url = new URL(searchUrl);
  url.searchParams.set("q", words);
  const called = await searchCall(deps, url, limits.skillsMaxBytes, limits.deadlineMs);
  if (!called.ok) {
    return called;
  }
  const search = parseSkillsSearch(called.data);
  if (search === null) {
    return unavailable(url.host, called.status, "malformed", `${url.host}'s answer isn't a search's`);
  }
  const results = firstOfEach(search.results, (result) => result.reference);
  return { ok: true, results: results.slice(0, limits.resultsMax), dropped: search.dropped };
};

/** One registry's search, latest versions only: its active entries, one a server, in the registry's order. */
export const searchRegistryAt = async (
  deps: OutboundDeps,
  registryUrl: string,
  words: string,
  limits: MarketplaceSearchLimits = MARKETPLACE_SEARCH_LIMITS,
): Promise<SourceSearch<RegistryEntry>> => {
  const url = new URL(`${registryUrl}/v0.1/servers`);
  url.searchParams.set("search", words);
  url.searchParams.set("version", "latest");
  const called = await searchCall(deps, url, limits.registryMaxBytes, limits.deadlineMs);
  if (!called.ok) {
    return called;
  }
  const list = parseRegistryList(called.data);
  if (list === null) {
    return unavailable(url.host, called.status, "malformed", `${url.host}'s answer isn't a list of servers`);
  }
  // Deprecation doesn't clear `isLatest`, so the status is checked; an inactive entry isn't offered.
  const entries = firstOfEach(
    list.entries.filter((entry) => registryStatusOf(entry) === "active"),
    (entry) => entry.server.name,
  );
  return { ok: true, results: entries.slice(0, limits.resultsMax), dropped: list.dropped };
};

// ---------- the switch ----------

const organizationSearchOn = async (db: Db | Tx, organizationId: OrganizationId): Promise<boolean> =>
  (await db.organizationSetting.findUnique({ where: { organizationId }, select: { marketplaceSearch: true } }))?.marketplaceSearch ?? false;

const stateOf = async (deps: LibraryDeps, db: Db | Tx, organizationId: OrganizationId): Promise<MarketplaceSearchState> => {
  const organizationOn = await organizationSearchOn(db, organizationId);
  const instanceAllows = deps.settings.marketplaceSearch;
  return {
    enabled: instanceAllows && organizationOn,
    organizationOn,
    instanceAllows,
    // The install's setting wins: an admin can't change it, so it's the reason shown first.
    off: !instanceAllows ? "instance" : organizationOn ? null : "organization",
    sendsTo: { skills: new URL(deps.settings.skillsSearchUrl).host, registries: await listedRegistries(db, organizationId) },
  };
};

/** The switch's state: on or off, which setting keeps it off, and where a search sends the words. */
export const readMarketplaceSearch: ReadMarketplaceSearch = async (deps, scope) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin sees the marketplace search's switch");
  }
  return { ok: true, state: await stateOf(deps, deps.db, organizationId) };
};

/** An organization admin turns search on or off, with the audit entry. On is refused while the install keeps it off. */
export const setMarketplaceSearch: SetMarketplaceSearch = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin turns marketplace search on or off");
  }
  if (input.enabled && !deps.settings.marketplaceSearch) {
    return refuse("instance-search-off", INSTANCE_SEARCH_OFF_WORDS);
  }
  const changed = await deps.db.$transaction(async (tx) => {
    if ((await organizationSearchOn(tx, organizationId)) === input.enabled) {
      return false;
    }
    await tx.organizationSetting.upsert({ where: { organizationId }, create: { organizationId, marketplaceSearch: input.enabled }, update: { marketplaceSearch: input.enabled } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "organization.marketplace_search_changed",
      entity: "organization",
      entityId: organizationId,
      data: { enabled: input.enabled },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return true;
  });
  if (changed) {
    loggerOf(deps).info("library.marketplace-search.changed", { organizationId, enabled: input.enabled });
  }
  return { ok: true, state: await stateOf(deps, deps.db, organizationId) };
};

// ---------- the search ----------

const skillResultOf = (result: SkillsSearchResult, sources: readonly AllowlistEntry[]): MarketplaceResult => {
  const [owner = "", repo = ""] = result.source.split("/");
  return {
    kind: "skill",
    reference: result.reference,
    source: result.source,
    skill: result.skillId,
    name: result.name,
    installs: result.installs,
    sourceAllowed: allowed({ kind: "github", owner, repo }, sources).allowed,
  };
};

const serverResultOf = (registryUrl: string, entry: RegistryEntry, sources: readonly AllowlistEntry[]): MarketplaceResult => ({
  kind: "server",
  reference: `registry:${entry.server.name}@${registryUrl}`,
  registryUrl,
  name: entry.server.name,
  title: entry.server.title?.slice(0, 200) ?? null,
  version: entry.server.version,
  description: entry.server.description?.slice(0, 4096) ?? null,
  refusal: serverOfferOf(entry).refusal,
  sourceAllowed: allowed({ kind: "registry", registryUrl, name: entry.server.name }, sources).allowed,
});

/** The search, with its limits: `searchMarketplace` is it at ticket 29's. */
export const searchMarketplaceWithin =
  (limits: MarketplaceSearchLimits): SearchMarketplace =>
  async (deps, scope, input) => {
    const organizationId = scope.organizationId;
    if (!requireOrganizationAdmin(scope, organizationId).ok) {
      return refuse("forbidden", "Only an organization admin searches the marketplace");
    }
    if (!deps.settings.marketplaceSearch) {
      return refuse("instance-search-off", INSTANCE_SEARCH_OFF_WORDS);
    }
    if (!(await organizationSearchOn(deps.db, organizationId))) {
      return refuse("organization-search-off", ORGANIZATION_SEARCH_OFF_WORDS);
    }
    const words = wordsOf(input.kind, input.words);
    if (words === null) {
      return refuse("invalid-input", `A search takes ${String(WORDS_MIN[input.kind])} to ${String(MARKETPLACE_WORDS_MAX)} characters of text`);
    }
    const logger = loggerOf(deps);
    const allowlist = await allowlistOf(deps.db, organizationId);
    /** A source's answer as the page shows it; an unavailable one logged with its host and status, never the words. */
    const answerOf = <T>(source: MarketplaceSource, search: SourceSearch<T>, resultOf: (result: T) => MarketplaceResult): MarketplaceSourceResults => {
      if (!search.ok) {
        logger.warn("library.search.unavailable", { organizationId, kind: input.kind, host: search.host, status: search.status, reason: search.reason });
        return { source, state: "unavailable", message: search.message };
      }
      return { source, state: "ok", results: search.results.map(resultOf), dropped: search.dropped };
    };
    let sources: MarketplaceSourceResults[];
    switch (input.kind) {
      case "skills": {
        const source: MarketplaceSource = { kind: "skills-search", host: new URL(deps.settings.skillsSearchUrl).host };
        const search = await searchSkillsAt(outbound(deps), deps.settings.skillsSearchUrl, words, limits);
        sources = [answerOf(source, search, (result) => skillResultOf(result, allowlist))];
        break;
      }
      case "servers": {
        const registries = await listedRegistries(deps.db, organizationId);
        // Each registry at once, each under its own deadline: one that fails never hides the others.
        sources = await Promise.all(
          registries.map(async (registryUrl) =>
            answerOf({ kind: "registry", registryUrl }, await searchRegistryAt(outbound(deps), registryUrl, words, limits), (entry) => serverResultOf(registryUrl, entry, allowlist)),
          ),
        );
        break;
      }
      default:
        return input.kind satisfies never;
    }
    logger.info("library.searched", {
      organizationId,
      kind: input.kind,
      sources: sources.length,
      unavailable: sources.filter((source) => source.state === "unavailable").length,
      results: sources.reduce((total, source) => total + (source.state === "ok" ? source.results.length : 0), 0),
    });
    return { ok: true, sources };
  };

/** An organization admin's search of skills.sh or the organization's registries (F-146). */
export const searchMarketplace: SearchMarketplace = searchMarketplaceWithin(MARKETPLACE_SEARCH_LIMITS);
