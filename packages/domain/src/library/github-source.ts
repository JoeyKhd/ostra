import { createHash } from "node:crypto";

import { readTreeRefusal, secretRefSchema } from "@ostra/adapter-sdk";
import type { AdapterResult, CodeHostAdapter, InstallationAccess, RepoTree, SecretStoreAdapter, TreeLimits } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { repoFullNameSchema } from "@ostra/protocol";
import type { GitSha, OrganizationId, RepoFullName } from "@ostra/protocol";

import { checkSkill, skillFrontMatter, skillLimits } from "./check-skill.ts";
import type { CheckedSkillFile, SkillProblem } from "./check-skill.ts";
import { computedHash, skillFilesOf } from "./hash.ts";
import type { LibraryReference } from "./reference.ts";

// F-145 (ADR 0069, ticket 27): a skill read from a GitHub repo at a commit, through the code host's
// `readTree` (ticket 02). A public repo is read anonymously; a private one through the
// organization's own installation, when one it linked is on the repo's account and covers it (ADR
// 0040, ADR 0065). The look finds each folder with a `SKILL.md`, at most four folders below the
// reference's folder, then reads each skill's folder on its own: a symlink is followed only when it
// stays inside the skill, as the `skills` CLI's hash does, so the hash agrees with a lockfile's.
// A repo's paths and bytes are its content: none reaches a log line or an error's words.

/** How deep below the reference's folder a `SKILL.md` is looked for (ADR 0069). */
export const SKILL_DEPTH_MAX = 4;

/** The caps of the look that finds the skills *(working values)*: a repo bigger than this lists what was read. */
export const SKILL_DISCOVERY_LIMITS: TreeLimits = { maxFiles: 2000, maxBytes: 32 * 1024 * 1024 };

/**
 * One skill's read: a little over ostra's limits (`SKILL.md` and 20 more, 1 MiB each), so
 * `checkSkill` names what passes them rather than the read cutting it short.
 */
export const SKILL_READ_LIMITS: TreeLimits = {
  maxFiles: skillLimits.filesMax + 2,
  maxBytes: (skillLimits.filesMax + 2) * skillLimits.fileMaxBytes,
};

/** How many skills' folders are read at once in one look. */
const READS_AT_ONCE = 4;

export type GitHubReference = Extract<LibraryReference, { readonly kind: "github" }>;

export type SourceError = "not-found" | "unsupported-host" | "rate-limited" | "unavailable" | "invalid-reference" | "too-large";

export type SourceFailure = { readonly ok: false; readonly error: SourceError; readonly message: string };

/** A skill as read at its source: its files with their bytes (for the install), and what the look shows. */
export type SkillRead = {
  /** Repo-relative for GitHub (`""` at the root); the skill's name for a well-known index. */
  readonly folder: string;
  /** Relative to the skill's folder: the files the installer keeps, with their bytes. */
  readonly files: readonly CheckedSkillFile[];
  readonly check: { readonly ok: true; readonly name: string; readonly description: string } | { readonly ok: false; readonly problems: readonly SkillProblem[] };
  readonly scripts: ReturnType<typeof checkSkill>["scripts"];
  readonly computedHash: string;
};

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A skill's files as one read gave them, relative to its folder: checked, hashed, and what the read left out named. */
export const skillReadOf = (input: {
  readonly folder: string;
  /** The folder's name for the spec's name rule: its last part, or the repo's name at the root. */
  readonly folderName: string;
  readonly files: readonly CheckedSkillFile[];
  /** Problems of the read itself, beside `checkSkill`'s. */
  readonly readProblems: readonly SkillProblem[];
}): SkillRead => {
  const checked = checkSkill({ folder: input.folderName, files: input.files });
  const kept = skillFilesOf(input.files);
  const problems = [...(checked.ok ? [] : checked.problems), ...input.readProblems];
  return {
    folder: input.folder,
    files: kept,
    check: checked.ok && problems.length === 0 ? { ok: true, name: checked.name, description: checked.description } : { ok: false, problems },
    scripts: checked.scripts,
    computedHash: computedHash(kept),
  };
};

/** What the caps left out of one skill's read, as problems the install dialog shows. */
const capProblems = (tree: RepoTree, relative: (path: string) => string): SkillProblem[] => {
  const problems: SkillProblem[] = [];
  for (const note of tree.notes) {
    switch (note.reason) {
      case "over-max-files":
        problems.push({ code: "too-many-files", message: `The skill has more files than ostra takes: SKILL.md and at most ${String(skillLimits.filesMax)} more`, path: null });
        break;
      case "over-max-bytes":
        problems.push({ code: "file-too-large", message: `${relative(note.path)} is over what ostra reads of a skill`, path: relative(note.path) });
        break;
      case "symlink-outside":
      case "symlink-dangling":
        // Left out as the `skills` CLI leaves it out: a link that leaves the skill isn't the skill's.
        break;
      default:
        note.reason satisfies never;
    }
  }
  if (tree.truncated && problems.length === 0) {
    problems.push({ code: "unreadable", message: "The skill's folder couldn't be read whole within ostra's limits", path: null });
  }
  return problems;
};

const lastPart = (folder: string): string => folder.split("/").at(-1) ?? folder;

/** Whether `path` is `folder` or under it; `""` is the repo's root. */
const isUnder = (path: string, folder: string): boolean => folder === "" || path === folder || path.startsWith(`${folder}/`);

/** A folder's depth below `base`: `0` for `base` itself. */
const depthBelow = (folder: string, base: string): number => {
  const rest = base === "" ? folder : folder === base ? "" : folder.slice(base.length + 1);
  return rest === "" ? 0 : rest.split("/").length;
};

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// ---------- access: the organization's installation on the repo's account, else anonymous ----------

/** The organization's linked installations on `owner`'s account, each with its App's key from the secret store. */
const installationAccesses = async (db: Db | Tx, secretStore: SecretStoreAdapter, organizationId: OrganizationId, owner: string): Promise<InstallationAccess[]> => {
  const rows = await db.codeHostInstallation.findMany({
    where: { organizationId, state: "linked", removedAt: null, accountLogin: { equals: owner, mode: "insensitive" }, connection: { kind: "github" } },
    select: { installationId: true, connection: { select: { appId: true, privateKeySecretRef: true } } },
    orderBy: { linkedAt: "asc" },
  });
  const accesses: InstallationAccess[] = [];
  for (const row of rows) {
    const ref = secretRefSchema.safeParse(row.connection.privateKeySecretRef);
    const key = ref.success ? await secretStore.get(organizationId, ref.data) : null;
    if (key?.ok === true) {
      accesses.push({ app: { appId: row.connection.appId, privateKey: key.value }, installationId: row.installationId });
    }
  }
  return accesses;
};

/** An adapter's refusal in the library's words. */
const failureOf = (result: Extract<AdapterResult<unknown>, { readonly ok: false }>): SourceFailure => {
  switch (result.error.code) {
    case "not-found":
    case "unauthorized":
    case "forbidden":
      return { ok: false, error: "not-found", message: result.error.message };
    case "rate-limited":
      return { ok: false, error: "rate-limited", message: result.error.message };
    case "unsupported":
      return { ok: false, error: "unsupported-host", message: result.error.message };
    case "invalid-input":
      return { ok: false, error: "invalid-reference", message: result.error.message };
    case "unavailable":
    case "invalid-response":
    case "aborted":
    case "conflict":
      return { ok: false, error: "unavailable", message: result.error.message };
    default:
      return result.error.code satisfies never;
  }
};

export type GitHubSourceDeps = { readonly db: Db; readonly codeHost: CodeHostAdapter; readonly secretStore: SecretStoreAdapter };

export type ResolvedCommit = { readonly ok: true; readonly commit: GitSha; readonly access: InstallationAccess | null; readonly repo: RepoFullName };

/**
 * The commit a ref names now (`HEAD`, the default branch's head, for none), read through the
 * first of the organization's installations that covers the repo, else anonymously. A private
 * repo with none is `not-found`, in the code host's words, which name the GitHub App.
 */
export const resolveGitHubCommit = async (
  deps: GitHubSourceDeps,
  organizationId: OrganizationId,
  reference: { readonly owner: string; readonly repo: string },
  ref: string,
): Promise<ResolvedCommit | SourceFailure> => {
  const refusal = readTreeRefusal(deps.codeHost);
  if (refusal !== null) {
    return { ok: false, error: "unsupported-host", message: refusal };
  }
  const repo = repoFullNameSchema.safeParse(`${reference.owner}/${reference.repo}`);
  if (!repo.success) {
    return { ok: false, error: "invalid-reference", message: "That isn't a GitHub owner and repo" };
  }
  const candidates: (InstallationAccess | null)[] = [...(await installationAccesses(deps.db, deps.secretStore, organizationId, reference.owner)), null];
  for (const access of candidates) {
    const resolved = await deps.codeHost.resolveRef(access, repo.data, ref);
    if (resolved.ok) {
      return resolved.value === null
        ? { ok: false, error: "not-found", message: "The repo has no branch, tag or commit by that name" }
        : { ok: true, commit: resolved.value.commit, access, repo: repo.data };
    }
    // An installation that doesn't cover the repo: the next one, or the anonymous read.
    if (access !== null && (resolved.error.code === "not-found" || resolved.error.code === "forbidden" || resolved.error.code === "unauthorized")) {
      continue;
    }
    return failureOf(resolved);
  }
  return { ok: false, error: "not-found", message: "GitHub has no repo by that name that ostra can read" };
};

/** One skill's folder read on its own at the commit, a symlink followed only inside it. */
export const readGitHubSkill = async (
  deps: Pick<GitHubSourceDeps, "codeHost">,
  at: ResolvedCommit,
  folder: string,
): Promise<{ readonly ok: true; readonly skill: SkillRead } | SourceFailure> => {
  const tree = await deps.codeHost.readTree(at.access, at.repo, at.commit, folder, SKILL_READ_LIMITS);
  if (!tree.ok) {
    return failureOf(tree);
  }
  const relative = (path: string): string => (folder === "" ? path : path.slice(folder.length + 1));
  const files = tree.value.files.map((file) => ({ path: relative(file.path), bytes: file.bytes, executable: file.mode === "executable" }));
  return {
    ok: true,
    skill: skillReadOf({ folder, folderName: folder === "" ? at.repo.split("/").at(-1) ?? "" : lastPart(folder), files, readProblems: capProblems(tree.value, relative) }),
  };
};

/** The skills a GitHub reference names at its commit: one, or each found below its folder. */
export type GitHubSkills = { readonly ok: true; readonly at: ResolvedCommit; readonly skills: readonly SkillRead[]; readonly tooDeep: number };

/** The ref a reference resolves: its commit, its branch or tag, or the default branch's head. */
export const refOfReference = (reference: GitHubReference): string => {
  if (reference.ref === null) {
    return "HEAD";
  }
  switch (reference.ref.kind) {
    case "commit":
      return reference.ref.sha;
    case "ref":
      return reference.ref.name;
    default:
      return reference.ref satisfies never;
  }
};

/** Reads at most `READS_AT_ONCE` at a time, in order. */
const inBatches = async <T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += READS_AT_ONCE) {
    results.push(...(await Promise.all(items.slice(start, start + READS_AT_ONCE).map(read))));
  }
  return results;
};

/**
 * The look at a GitHub reference: the commit, then the skills. A folder that holds `SKILL.md`
 * itself is the one skill; otherwise each folder with a `SKILL.md` at most four below it, or the
 * one `@skill` names (by its front matter's name or its folder's).
 */
export const readGitHubSkills = async (deps: GitHubSourceDeps, organizationId: OrganizationId, reference: GitHubReference): Promise<GitHubSkills | SourceFailure> => {
  const at = await resolveGitHubCommit(deps, organizationId, reference, refOfReference(reference));
  if (!at.ok) {
    return at;
  }
  const base = reference.path ?? "";
  const look = await deps.codeHost.readTree(at.access, at.repo, at.commit, base, SKILL_DISCOVERY_LIMITS);
  if (!look.ok) {
    return failureOf(look);
  }
  // A `SKILL.md` the caps left out is still found by its note.
  const skillMds = [...look.value.files.map((file) => file.path), ...look.value.notes.map((note) => note.path)].filter((path) => path.split("/").at(-1) === "SKILL.md" && isUnder(path, base));
  const folders = [...new Set(skillMds.map(folderOf))].sort();
  let picked: string[];
  let tooDeep = 0;
  if (folders.includes(base)) {
    picked = [base];
  } else {
    picked = folders.filter((folder) => depthBelow(folder, base) <= SKILL_DEPTH_MAX);
    tooDeep = folders.length - picked.length;
  }
  if (reference.skill !== null) {
    const wanted = reference.skill;
    const nameOf = (folder: string): string | null => {
      const file = look.value.files.find((candidate) => candidate.path === (folder === "" ? "SKILL.md" : `${folder}/SKILL.md`));
      return file === undefined ? null : (skillFrontMatter(new TextDecoder().decode(file.bytes))?.name ?? null);
    };
    picked = picked.filter((folder) => lastPart(folder) === wanted || nameOf(folder) === wanted);
    tooDeep = 0;
    if (picked.length === 0) {
      return { ok: false, error: "not-found", message: `The repo has no skill named ${wanted} within four folders of where it was looked for` };
    }
  }
  const reads = await inBatches(picked, (folder) => readGitHubSkill(deps, at, folder));
  const skills: SkillRead[] = [];
  for (const read of reads) {
    if (!read.ok) {
      return read;
    }
    skills.push(read.skill);
  }
  if (skills.length === 0) {
    return { ok: false, error: "not-found", message: "The repo has no folder with a SKILL.md within four folders of where it was looked for" };
  }
  return { ok: true, at, skills, tooDeep };
};

/**
 * The install's read: the folder the admin picked, at the look's commit, through the same access.
 * The folder must be the reference's own or under it, at most four below.
 */
export const readGitHubSkillForInstall = async (
  deps: GitHubSourceDeps,
  organizationId: OrganizationId,
  reference: GitHubReference,
  folder: string,
  commit: GitSha,
): Promise<{ readonly ok: true; readonly at: ResolvedCommit; readonly skill: SkillRead } | SourceFailure> => {
  const base = reference.path ?? "";
  if (!isUnder(folder, base) || depthBelow(folder, base) > SKILL_DEPTH_MAX) {
    return { ok: false, error: "invalid-reference", message: "That folder isn't one the reference's look offered" };
  }
  const at = await resolveGitHubCommit(deps, organizationId, reference, commit);
  if (!at.ok) {
    return at;
  }
  if (at.commit !== commit) {
    return { ok: false, error: "invalid-reference", message: "The install reads the commit the look resolved" };
  }
  const read = await readGitHubSkill(deps, at, folder);
  return read.ok ? { ok: true, at, skill: read.skill } : read;
};
