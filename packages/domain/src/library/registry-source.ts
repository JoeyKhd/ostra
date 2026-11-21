import type { Db, Tx } from "@ostra/db";
import type { OrganizationId } from "@ostra/protocol";

import type { SourceFailure } from "./github-source.ts";
import { callOut, jsonOf, outboundFailureWords } from "./outbound.ts";
import type { OutboundDeps } from "./outbound.ts";
import { registryUrlOf } from "./reference.ts";
import type { StoredServerEntry, StoredServerInputSpec } from "./stored.ts";
import { registryEntrySchema, registryStatusOf } from "./vendor.ts";
import type { RegistryEntry, RegistryRemote } from "./vendor.ts";

// F-145 (ADR 0069, Q320, Q321, ticket 27): an MCP server's entry in a registry that speaks the
// official registry's `v0.1` API (`GET <registry>/v0.1/servers/{name}/versions/{version}`), read
// tolerant of unknown fields as every vendor format is. ostra installs only an `active` entry's
// `streamable-http` remote on https: an `sse` remote is deprecated, and an entry with only
// packages would need a download in the box (research §6). Each URL variable and header it asks
// for is listed with whether it's a secret. The entry's text is the registry's, shown as data.

/** One registry call's deadline *(working value)*. */
export const REGISTRY_DEADLINE_MS = 10_000;
const ENTRY_MAX_BYTES = 1024 * 1024;

/** Why an entry can't be installed in milestone 8 (the signatures' `ServerRefusal`). */
export type ServerRefusalCode = "inactive" | "packages-only" | "sse-only" | "no-remote";

/** Each refusal's words, for the install dialog. */
export const serverRefusalWords = (refusal: ServerRefusalCode): string => {
  switch (refusal) {
    case "inactive":
      return "The registry marks this version of the server deprecated or deleted, so ostra doesn't install it";
    case "packages-only":
      return "The server is published only as a package run on the machine (npm, PyPI, a container): running it would need a download inside the task's box, which ostra doesn't do yet. Only remote servers install";
    case "sse-only":
      return "The server's only remote speaks the deprecated SSE transport: ostra installs streamable-HTTP remotes";
    case "no-remote":
      return "The server has no streamable-HTTP remote on https that ostra can install";
    default:
      return refusal satisfies never;
  }
};

/** What an entry offers: the remote ostra would install and its inputs, or why there's none. */
export type ServerOffer = {
  readonly refusal: ServerRefusalCode | null;
  /** Ready to store on the version when `refusal` is `null`. */
  readonly entry: StoredServerEntry | null;
  /** Each input's default, by kind and name, for an input the admin leaves empty. Plain values only. */
  readonly defaults: { readonly variables: Readonly<Record<string, string>>; readonly headers: Readonly<Record<string, string>> };
};

/** An HTTP header's name (RFC 9110's token). */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]{1,256}$/;
/** Headers the call sets itself, or that only a transport sets. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "accept",
  "user-agent",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
]);

const isHttpsTemplate = (url: string): boolean => url.toLowerCase().startsWith("https://") && !/[\s<>"\\^`|]/.test(url);

/** The `{name}`s a URL template uses. */
export const templateVariables = (url: string): string[] => [...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "").filter((name) => name !== "");

const specOf = (name: string, input: { readonly isSecret?: boolean | undefined; readonly isRequired?: boolean | undefined; readonly description?: string | undefined }, required: boolean): StoredServerInputSpec => ({
  name,
  isSecret: input.isSecret === true,
  isRequired: input.isRequired ?? required,
  description: input.description?.slice(0, 4096) ?? null,
});

/** The entry's first `streamable-http` remote on https, and what it asks for. */
const offerOfRemote = (server: RegistryEntry["server"], remote: RegistryRemote): StoredServerEntry & { readonly defaults: ServerOffer["defaults"] } => {
  const used = new Set(templateVariables(remote.url));
  const variables: StoredServerInputSpec[] = [];
  const variableDefaults: Record<string, string> = {};
  for (const [name, input] of Object.entries(remote.variables ?? {})) {
    variables.push(specOf(name, input, used.has(name) && input.default === undefined));
    if (input.default !== undefined && input.isSecret !== true) variableDefaults[name] = input.default;
  }
  // A `{name}` with no description in `variables` is still asked for.
  for (const name of used) {
    if (!variables.some((variable) => variable.name === name)) variables.push({ name, isSecret: false, isRequired: true, description: null });
  }
  const headers: StoredServerInputSpec[] = [];
  const headerDefaults: Record<string, string> = {};
  const fixedHeaders: Record<string, string> = {};
  for (const header of remote.headers ?? []) {
    // A header the call itself sets, or that isn't a header's name, is never taken from the entry.
    if (!HEADER_NAME.test(header.name) || RESERVED_HEADERS.has(header.name.toLowerCase())) {
      continue;
    }
    // A plain value the entry fixes itself is sent as it is; one with `{…}` in it, or a secret, is asked for.
    if (header.value !== undefined && header.isSecret !== true && !header.value.includes("{")) {
      fixedHeaders[header.name] = header.value;
      continue;
    }
    headers.push(specOf(header.name, header, false));
    if (header.default !== undefined && header.isSecret !== true) headerDefaults[header.name] = header.default;
  }
  return {
    transport: "streamable-http",
    remoteUrl: remote.url,
    description: server.description?.slice(0, 4096) ?? null,
    variables: variables.slice(0, 50),
    headers: headers.slice(0, 50),
    fixedHeaders,
    defaults: { variables: variableDefaults, headers: headerDefaults },
  };
};

/** What an entry offers ostra: only an active entry's streamable-HTTP remote on https. */
export const serverOfferOf = (entry: RegistryEntry): ServerOffer => {
  const none = { variables: {}, headers: {} };
  if (registryStatusOf(entry) !== "active") {
    return { refusal: "inactive", entry: null, defaults: none };
  }
  const remotes = entry.server.remotes ?? [];
  const remote = remotes.find((candidate) => candidate.type === "streamable-http" && isHttpsTemplate(candidate.url));
  if (remote === undefined) {
    const refusal = remotes.some((candidate) => candidate.type === "sse") ? "sse-only" : (entry.server.packages ?? []).length > 0 && remotes.length === 0 ? "packages-only" : "no-remote";
    return { refusal, entry: null, defaults: none };
  }
  const { defaults, ...stored } = offerOfRemote(entry.server, remote);
  return { refusal: null, entry: stored, defaults };
};

/** An item's name for a server: its name in the registry after the namespace, as a profile's server is named. */
export const serverItemNameOf = (name: string): string => {
  const slug = (name.split("/").at(-1) ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "server" : slug;
};

export type RegistryRead = { readonly ok: true; readonly registryUrl: string; readonly entry: RegistryEntry };

/** One registry's entry for a server at a version (`latest`, or one the look read). */
const readEntryAt = async (deps: OutboundDeps, registryUrl: string, name: string, version: string, signal: AbortSignal): Promise<RegistryRead | SourceFailure> => {
  const url = `${registryUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const answer = await callOut(deps, url, { headers: { accept: "application/json" }, maxBytes: ENTRY_MAX_BYTES, signal, followRedirects: false });
  if (!answer.ok) {
    return { ok: false, error: "unavailable", message: outboundFailureWords("The registry", answer.failure) };
  }
  const status = answer.answer.status;
  if (status === 404) {
    return { ok: false, error: "not-found", message: "The registry has no server by that name at that version" };
  }
  if (status === 429) {
    return { ok: false, error: "rate-limited", message: "The registry is limiting how often it's read: try again later" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, error: "unavailable", message: `The registry answered HTTP ${String(status)}` };
  }
  const entry = registryEntrySchema.safeParse(jsonOf(answer.answer.bytes));
  if (!entry.success || entry.data.server.name !== name || (version !== "latest" && entry.data.server.version !== version)) {
    return { ok: false, error: "unavailable", message: "The registry's answer isn't the server's entry ostra asked for" };
  }
  return { ok: true, registryUrl, entry: entry.data };
};

/** The registries on the organization's list, in the order they were added: each at most once. */
export const listedRegistries = async (db: Db | Tx, organizationId: OrganizationId): Promise<string[]> => {
  const rows = await db.librarySource.findMany({ where: { organizationId, kind: "registry" }, orderBy: { createdAt: "asc" }, select: { value: true } });
  return [...new Set(rows.map((row) => registryUrlOf(row.value)).filter((url) => url !== null))];
};

/**
 * A server's entry, in the registry the reference names, or else in each registry on the
 * organization's list in order, the first that has it.
 */
export const readRegistryServer = async (
  deps: OutboundDeps & { readonly db: Db },
  organizationId: OrganizationId,
  reference: { readonly name: string; readonly registryUrl: string | null },
  version: string,
): Promise<RegistryRead | SourceFailure> => {
  const registries = reference.registryUrl === null ? await listedRegistries(deps.db, organizationId) : [reference.registryUrl];
  if (registries.length === 0) {
    return { ok: false, error: "not-found", message: "The organization's list has no registry to look the server up in: name one, as registry:<name>@<registry URL>" };
  }
  // One registry that doesn't answer doesn't hide the server in the next; its failure is said only when none has it.
  let failure: SourceFailure | null = null;
  for (const registryUrl of registries) {
    const read = await readEntryAt(deps, registryUrl, reference.name, version, AbortSignal.timeout(REGISTRY_DEADLINE_MS));
    if (read.ok) {
      return read;
    }
    if (read.error !== "not-found") {
      failure ??= read;
    }
  }
  return failure ?? { ok: false, error: "not-found", message: registries.length === 1 ? "The registry has no server by that name at that version" : "No registry on the organization's list has that server at that version" };
};
