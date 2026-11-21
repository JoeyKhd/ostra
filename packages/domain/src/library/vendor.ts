import { z } from "zod";

import { SERVER_NAME, SKILL_NAME } from "./reference.ts";

// F-145, F-146 (ADR 0069, ticket 06): the formats a vendor owns that the library reads, each
// tolerant of unknown fields (AGENTS.md, Code): an MCP registry's `server.json` subset and its
// entries (`v0.1`, research §3.1), the well-known skills index v0.2.0 with its digest (research
// §2.2), and skills.sh's search answer (research §2.6). A list keeps the entries that read and
// counts the rest, so one odd entry never hides the others. Nothing here is logged: a server's
// headers name secrets, and a search holds an admin's words.

// ---------- an MCP registry (`GET <registry>/v0.1/servers…`) ----------

/** An input a remote asks for, a header or a URL variable: whether it's a secret, and its words. */
const inputSchema = z.looseObject({
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  /** A value the entry fixes itself; a plain one, never a secret. */
  value: z.string().optional(),
  choices: z.array(z.string()).optional(),
  format: z.string().optional(),
});

export const registryHeaderSchema = inputSchema.extend({ name: z.string().min(1) });
export type RegistryHeader = z.infer<typeof registryHeaderSchema>;

/** A remote endpoint: `streamable-http`, or the deprecated `sse`, or a type a later schema adds. */
export const registryRemoteSchema = z.looseObject({
  type: z.string(),
  /** May hold `{variables}`, which the admin fills. */
  url: z.string().min(1),
  headers: z.array(registryHeaderSchema).optional(),
  variables: z.record(z.string(), inputSchema).optional(),
});
export type RegistryRemote = z.infer<typeof registryRemoteSchema>;

/** A package run over stdio (npm, PyPI, OCI and the rest): listed, not installable in milestone 8. */
export const registryPackageSchema = z.looseObject({
  registryType: z.string(),
  identifier: z.string().optional(),
  version: z.string().optional(),
});

/** `server.json`, as far as the library reads it (schema `2025-12-11`). */
export const registryServerSchema = z.looseObject({
  name: z.string().regex(SERVER_NAME),
  version: z.string().min(1),
  description: z.string().optional(),
  title: z.string().optional(),
  remotes: z.array(registryRemoteSchema).optional(),
  packages: z.array(registryPackageSchema).optional(),
});
export type RegistryServer = z.infer<typeof registryServerSchema>;

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

/** One entry: `{ server, _meta }`, the registry's own status under its official key. */
export const registryEntrySchema = z.looseObject({
  server: registryServerSchema,
  _meta: z
    .looseObject({
      [OFFICIAL_META]: z
        .looseObject({
          status: z.string(),
          isLatest: z.boolean().optional(),
          publishedAt: z.string().optional(),
          updatedAt: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** An entry's status. "Deprecation doesn't clear `isLatest`", so a client checks this; one it doesn't know isn't active. */
export const registryStatusOf = (entry: RegistryEntry): "active" | "deprecated" | "deleted" | "unknown" => {
  const status = entry._meta?.[OFFICIAL_META]?.status;
  return status === "active" || status === "deprecated" || status === "deleted" ? status : "unknown";
};

/** A list's page: the servers and the cursor of the next. */
const registryListSchema = z.looseObject({
  servers: z.array(z.unknown()),
  metadata: z.looseObject({ nextCursor: z.string().nullish() }).optional(),
});

/** What a list or a search reads into: the entries that read, how many didn't, and the next page's cursor. */
export type RegistryList = { readonly entries: readonly RegistryEntry[]; readonly dropped: number; readonly nextCursor: string | null };

export const parseRegistryList = (data: unknown): RegistryList | null => {
  const list = registryListSchema.safeParse(data);
  if (!list.success) {
    return null;
  }
  const entries: RegistryEntry[] = [];
  let dropped = 0;
  for (const item of list.data.servers) {
    const entry = registryEntrySchema.safeParse(item);
    if (entry.success) {
      entries.push(entry.data);
    } else {
      dropped += 1;
    }
  }
  return { entries, dropped, nextCursor: list.data.metadata?.nextCursor ?? null };
};

// ---------- the well-known skills index, v0.2.0 ----------

/** The draft's schema URL: an index with another `$schema` isn't read, as the CLI doesn't read one. */
export const WELL_KNOWN_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Where a site serves its index, in the order the fetch tries them (the second is the legacy path). */
export const WELL_KNOWN_INDEX_PATHS = ["/.well-known/agent-skills/index.json", "/.well-known/skills/index.json"] as const;

export const wellKnownEntrySchema = z.looseObject({
  name: z.string().regex(SKILL_NAME).refine((name) => !name.startsWith("-") && !name.endsWith("-") && !name.includes("--"), "a skill's name"),
  type: z.enum(["skill-md", "archive"]),
  description: z.string().min(1).max(1024),
  /** Relative to the index's URL, or absolute. */
  url: z.string().min(1),
  /** `sha256:<hex>` of the bytes `url` answers: a mismatch is an error, never a fallback. */
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type WellKnownEntry = z.infer<typeof wellKnownEntrySchema>;

const wellKnownIndexSchema = z.looseObject({ $schema: z.literal(WELL_KNOWN_SCHEMA_V2), skills: z.array(z.unknown()) });

export type WellKnownIndex = { readonly entries: readonly WellKnownEntry[]; readonly dropped: number };

/**
 * An index v0.2.0: its entries that read, each skipped one counted, as the CLI skips them. `null`
 * for another schema (the legacy index has no digest, so ostra doesn't install from it) or when no
 * entry reads.
 */
export const parseWellKnownIndex = (data: unknown): WellKnownIndex | null => {
  const index = wellKnownIndexSchema.safeParse(data);
  if (!index.success) {
    return null;
  }
  const entries: WellKnownEntry[] = [];
  let dropped = 0;
  for (const item of index.data.skills) {
    const entry = wellKnownEntrySchema.safeParse(item);
    if (entry.success) {
      entries.push(entry.data);
    } else {
      dropped += 1;
    }
  }
  return entries.length === 0 ? null : { entries, dropped };
};

// ---------- skills.sh's search (`GET <OSTRA_SKILLS_SEARCH_URL>?q=…`) ----------

const skillsSearchSchema = z.looseObject({ skills: z.array(z.unknown()) });

const skillsSearchItemSchema = z.looseObject({
  /** `owner/repo`: the result is dropped without one. */
  source: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  skillId: z.string().min(1).optional(),
  /** The CLI's slug: `<source>/<skill>`. */
  id: z.string().optional(),
  name: z.string().min(1),
  installs: z.number().int().nonnegative().optional(),
});

/** A result, ready to install through the library's own flow: `reference` is `<source>@<skill>`. */
export type SkillsSearchResult = {
  readonly source: string;
  readonly skillId: string;
  readonly name: string;
  readonly installs: number | null;
  readonly reference: string;
};

export type SkillsSearch = { readonly results: readonly SkillsSearchResult[]; readonly dropped: number };

/**
 * skills.sh's answer: each result with its source, its skill and its install count. One missing its
 * source (or with one that isn't `owner/repo`, or a skill that isn't a skill's name) is dropped and
 * counted. `null` when the answer isn't a search's at all, which the page words as "unavailable".
 */
export const parseSkillsSearch = (data: unknown): SkillsSearch | null => {
  const search = skillsSearchSchema.safeParse(data);
  if (!search.success) {
    return null;
  }
  const results: SkillsSearchResult[] = [];
  let dropped = 0;
  for (const item of search.data.skills) {
    const parsed = skillsSearchItemSchema.safeParse(item);
    const skillId = parsed.success ? (parsed.data.skillId ?? slugTail(parsed.data.id, parsed.data.source) ?? parsed.data.name) : "";
    if (!parsed.success || !SKILL_NAME.test(skillId)) {
      dropped += 1;
      continue;
    }
    results.push({
      source: parsed.data.source,
      skillId,
      name: parsed.data.name,
      installs: parsed.data.installs ?? null,
      reference: `${parsed.data.source}@${skillId}`,
    });
  }
  return { results, dropped };
};

/** The skill's part of a slug `<source>/<skill>`, or `undefined`. */
const slugTail = (id: string | undefined, source: string): string | undefined => (id?.startsWith(`${source}/`) === true ? id.slice(source.length + 1) : undefined);
