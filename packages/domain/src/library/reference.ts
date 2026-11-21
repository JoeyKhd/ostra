import { treeFolderOf } from "@ostra/adapter-sdk";
import type { DbEnum } from "@ostra/db";
import { gitShaSchema } from "@ostra/protocol";
import type { GitSha } from "@ostra/protocol";
import { z } from "zod";

// F-145 (ADR 0069, spec section 5.4, ticket 06): what an admin types to install a skill or an MCP
// server, read the way the `skills` CLI's `src/source-parser.ts` reads a source (research §2.2),
// in its order, for the forms ostra takes:
// - a GitHub repo: `owner/repo`, `owner/repo@skill`, `owner/repo/path`, `github:` before any of
//   them, or a github.com URL, `/tree/<ref>/<path>` included; any of them with `#ref` (or
//   `#ref@skill`); `@v1.2.3` or `@<40-hex>` is a pin, as the CLI reads it, not a skill's name;
// - a site that serves the well-known index: `https://<site>[/<path>]`, its index found by the fetch;
// - an MCP server's name in a registry: `registry:<server name>`, optionally `@<registry URL>`.
// A form the CLI takes that ostra doesn't (GitLab, another git host, a local path, an archive or a
// file's URL) is refused in words that say which sources ostra takes. Pure: no fetch, no log.

/** What a reference pins: a commit, or a branch or a tag resolved when it's read. */
export type LibraryRef = { readonly kind: "commit"; readonly sha: GitSha } | { readonly kind: "ref"; readonly name: string };

export type LibraryReference =
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      /** The folder the skills are under, repo-relative; `null` for the whole repo. */
      readonly path: string | null;
      /** The one skill asked for, by its name; `null` lists the repo's skills to pick from. */
      readonly skill: string | null;
      /** `null`: the repo's default branch, at its head when it's read. */
      readonly ref: LibraryRef | null;
    }
  | {
      readonly kind: "well_known";
      /** The site's address, `https://<host>[/<path>]`, with no slash at the end; the index is found under it. */
      readonly url: string;
      /** Its host, lowercase, which the allowlist matches. */
      readonly host: string;
    }
  | {
      readonly kind: "registry";
      /** The server's name, `<namespace>/<name>`. */
      readonly name: string;
      /** The registry it's in; `null`: each registry on the organization's list, in order. */
      readonly registryUrl: string | null;
    };

/** The sources ostra takes, for every refusal. */
export const LIBRARY_SOURCES_WORDS =
  "ostra installs from a GitHub repo (owner/repo, owner/repo@skill, owner/repo/path or a github.com URL, each with an optional #ref), a site's https address that serves the well-known skills index, or registry:<server name>";

/** A GitHub login: letters, digits and single dashes, at most 39. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** The Agent Skills spec's name: lowercase letters, digits and dashes, at most 64. */
export const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
/** An MCP server's name in a registry: `<namespace>/<name>`, exactly one slash (server.json's schema). */
export const SERVER_NAME = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;
/** The CLI's version pin: `v1.2.3`, `1.2`, with a pre-release or build part. A full SHA is a pin too. */
const VERSION_PIN = /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const refuse = (form: string): { readonly ok: false; readonly error: string } => ({ ok: false, error: `ostra doesn't install from ${form}: ${LIBRARY_SOURCES_WORDS}.` });
const malformed = (what: string): { readonly ok: false; readonly error: string } => ({ ok: false, error: `${what}: ${LIBRARY_SOURCES_WORDS}.` });

type Parsed = { readonly ok: true; readonly value: LibraryReference } | { readonly ok: false; readonly error: string };

/** A ref's text as git would take it: no space, `..`, `~^:?*[\` or control character, at most 255. */
const isRefName = (name: string): boolean =>
  name.length > 0 && name.length <= 255 && !name.includes("..") && !name.startsWith("/") && !name.endsWith("/") && !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name);

const refOf = (name: string): LibraryRef | null => {
  if (!isRefName(name)) {
    return null;
  }
  const sha = gitShaSchema.safeParse(name);
  return sha.success ? { kind: "commit", sha: sha.data } : { kind: "ref", name };
};

/** A `#` fragment, split as the CLI splits it: `#ref`, `#ref@skill` or `#@skill`. */
const splitFragment = (input: string): { readonly before: string; readonly ref: string | null; readonly skill: string | null } => {
  const hash = input.indexOf("#");
  if (hash === -1 || hash === input.length - 1) {
    return { before: hash === -1 ? input : input.slice(0, hash), ref: null, skill: null };
  }
  const fragment = safeDecode(input.slice(hash + 1));
  const at = fragment.indexOf("@");
  const ref = at === -1 ? fragment : fragment.slice(0, at);
  const skill = at === -1 ? "" : fragment.slice(at + 1);
  return { before: input.slice(0, hash), ref: ref === "" ? null : ref, skill: skill === "" ? null : skill };
};

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** A GitHub reference's parts checked, or why they aren't a repo. */
const github = (input: {
  readonly owner: string;
  readonly repo: string;
  readonly path: string | null;
  readonly skill: string | null;
  readonly ref: string | null;
}): Parsed => {
  const repo = input.repo.endsWith(".git") ? input.repo.slice(0, -4) : input.repo;
  if (!GITHUB_OWNER.test(input.owner) || !GITHUB_REPO.test(repo) || repo === "." || repo === "..") {
    return malformed("That isn't a GitHub owner and repo");
  }
  const path = input.path === null || input.path === "" ? null : treeFolderOf(input.path);
  if (path === null && input.path !== null && input.path !== "") {
    return malformed("A repo's folder is a path inside it, with no `..`");
  }
  if (input.skill !== null && !SKILL_NAME.test(input.skill)) {
    return malformed("A skill's name is lowercase letters, digits and dashes, at most 64");
  }
  const ref = input.ref === null ? null : refOf(input.ref);
  if (input.ref !== null && ref === null) {
    return malformed("That ref isn't a branch, a tag or a commit");
  }
  return { ok: true, value: { kind: "github", owner: input.owner, repo, path: path === "" ? null : path, skill: input.skill, ref } };
};

/** A URL's path in parts, each decoded, with empty ones dropped. */
const segmentsOf = (pathname: string): string[] => pathname.split("/").filter((part) => part !== "").map(safeDecode);

const parseUrl = (input: string, fragment: { readonly ref: string | null; readonly skill: string | null }): Parsed => {
  if (!URL.canParse(input)) {
    return malformed("That address doesn't read as a URL");
  }
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  const segments = segmentsOf(url.pathname);
  // Archives and files on GitHub's hosts (the CLI's direct downloads).
  if (host === "raw.githubusercontent.com" || host === "codeload.github.com" || host === "objects.githubusercontent.com") {
    return refuse("an archive's or a file's URL");
  }
  if (host === "github.com" || host === "www.github.com") {
    const [owner = "", repo = "", marker, ref, ...rest] = segments;
    if (marker === "archive" || marker === "raw" || marker === "releases") {
      return refuse("an archive's or a file's URL");
    }
    if (marker === "tree" && ref !== undefined) {
      return github({ owner, repo, path: rest.join("/"), skill: fragment.skill, ref });
    }
    if (marker !== undefined) {
      return malformed("A GitHub URL names a repo, or a folder in it as /tree/<ref>/<path>");
    }
    return github({ owner, repo, path: null, skill: fragment.skill, ref: fragment.ref });
  }
  if (host === "gitlab.com" || url.pathname.includes("/-/tree/") || url.pathname.includes("/-/archive/") || url.pathname.includes("/-/raw/")) {
    return refuse("GitLab");
  }
  if (segments.includes("_git") || url.pathname.endsWith(".git")) {
    return refuse("another git host");
  }
  if (url.protocol === "http:") {
    return refuse("a site over plain http");
  }
  if (url.protocol !== "https:") {
    return refuse("that kind of address");
  }
  if (url.username !== "" || url.password !== "") {
    return malformed("A site's address carries no user or password");
  }
  if (url.search !== "" || url.hash !== "") {
    return malformed("A site's address has no query and no #");
  }
  const last = (segments.at(-1) ?? "").toLowerCase();
  if (/\.(?:zip|tar|tgz|gz)$/.test(last)) {
    return refuse("an archive's URL");
  }
  if (last.endsWith(".md")) {
    return refuse("a file's URL");
  }
  // The index's own path names its site: the fetch finds the index under it.
  const wellKnown = url.pathname.replace(/\/\.well-known\/(?:agent-)?skills\/index\.json$/, "").replace(/\/+$/, "");
  return { ok: true, value: { kind: "well_known", url: `${url.origin}${wellKnown}`, host } };
};

const parseRegistry = (rest: string): Parsed => {
  const at = rest.indexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  const registry = at === -1 ? null : rest.slice(at + 1);
  if (!SERVER_NAME.test(name)) {
    return malformed("A server's name in a registry is <namespace>/<name>, such as io.github.github/github-mcp-server");
  }
  if (registry === null) {
    return { ok: true, value: { kind: "registry", name, registryUrl: null } };
  }
  const url = registryUrlOf(registry);
  return url === null
    ? malformed("A registry is named by its https address, such as https://api.mcp.github.com")
    : { ok: true, value: { kind: "registry", name, registryUrl: url } };
};

/** A registry's address, normalized: https, its host lowercase, no query, no slash at the end; `null` when it isn't one. */
export const registryUrlOf = (input: string): string | null => {
  if (!URL.canParse(input)) {
    return null;
  }
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

/** Whether the text looks like a local path, as the CLI's `isLocalPath` reads one. */
const isLocalPath = (input: string): boolean =>
  input.startsWith("/") || input.startsWith("\\") || input.startsWith("./") || input.startsWith("../") || input === "." || input === ".." || /^[a-zA-Z]:[/\\]/.test(input) || input.startsWith("~/");

/** Reads what an admin typed into the reference it names, or the words of why ostra doesn't take it. */
export const parseLibraryReference = (typed: string): Parsed => {
  const input = typed.trim();
  if (input === "") {
    return malformed("Name a source");
  }
  if (input.length > 2048) {
    return malformed("That reference is too long");
  }
  if (isLocalPath(input)) {
    return refuse("a local path");
  }
  if (input.startsWith("registry:")) {
    return parseRegistry(input.slice("registry:".length));
  }
  const fragment = splitFragment(input);
  const before = fragment.before;
  if (before.startsWith("github:")) {
    return parseLibraryReference(`${before.slice("github:".length)}${input.slice(before.length)}`);
  }
  if (before.startsWith("gitlab:")) {
    return refuse("GitLab");
  }
  if (before.startsWith("git@") || before.startsWith("ssh://") || before.startsWith("git://")) {
    return refuse("a git URL");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(before)) {
    // A site's address keeps its `#`, which is then refused: only a repo takes a ref.
    return parseUrl(/^https?:\/\/(?:www\.)?github\.com\//i.test(before) ? before : input, fragment);
  }
  if (before.includes(":")) {
    return refuse("that kind of address");
  }
  const pinned = /^([^/]+)\/([^/@]+)@(.+)$/.exec(before);
  if (pinned !== null) {
    const [, owner = "", repo = "", after = ""] = pinned;
    // `@v1.2.3` and `@<sha>` pin a version, as the CLI reads them, unless the `#` already said so.
    if (fragment.ref === null && fragment.skill === null && (VERSION_PIN.test(after) || gitShaSchema.safeParse(after).success)) {
      return github({ owner, repo, path: null, skill: null, ref: after });
    }
    return github({ owner, repo, path: null, skill: fragment.skill ?? after, ref: fragment.ref });
  }
  const plain = /^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/.exec(before);
  if (plain !== null) {
    const [, owner = "", repo = "", path = null] = plain;
    return github({ owner, repo, path, skill: fragment.skill, ref: fragment.ref });
  }
  return malformed("That doesn't name a source");
};

/** The reference schema: the CLI's forms in, a `LibraryReference` out, or an issue in words. */
export const libraryReferenceSchema = z.string().transform((value, context): LibraryReference => {
  const parsed = parseLibraryReference(value);
  if (!parsed.ok) {
    context.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.value;
});

// ---------- an installed item's source, as `LibraryItem.source` stores it (ostra's format: strict) ----------

const httpsUrlSchema = z.string().refine((value) => registryUrlOf(value) === value, "an https address, normalized");

/**
 * Where an installed item comes from, and what its update check reads again. A GitHub skill keeps
 * its folder and the ref the admin asked for (`null`: the default branch); the commit it's pinned
 * to is on its version. A well-known skill keeps its site and its name in the index. A server keeps
 * its registry and its name.
 */
export const librarySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github"),
    owner: z.string().regex(GITHUB_OWNER),
    repo: z.string().regex(GITHUB_REPO),
    /** The skill's folder, repo-relative; `""` for a skill at the repo's root. */
    path: z.string().refine((value) => value === "" || treeFolderOf(value) === value, "a repo-relative folder"),
    ref: z.string().refine(isRefName, "a ref").nullable(),
  }),
  z.strictObject({
    kind: z.literal("well_known"),
    url: httpsUrlSchema,
    skill: z.string().regex(SKILL_NAME),
  }),
  z.strictObject({
    kind: z.literal("registry"),
    registryUrl: httpsUrlSchema,
    name: z.string().regex(SERVER_NAME),
  }),
]);
export type LibrarySource = z.infer<typeof librarySourceSchema>;

/** The `LibraryItem.sourceKind` column for a source: the schema's enum names the same three kinds. */
export const librarySourceKindOf = (source: LibrarySource): DbEnum.LibraryItemSourceKind => {
  switch (source.kind) {
    case "github":
    case "well_known":
    case "registry":
      return source.kind;
    default:
      return source satisfies never;
  }
};
