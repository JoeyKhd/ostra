import { createHash } from "node:crypto";

import { repoFullNameSchema } from "@ostra/protocol";
import type { GitSha, RepoFullName } from "@ostra/protocol";

import { createTreeCollector, treeFolderOf, treeLimitsProblem } from "../code-host/tree.ts";
import type { RepoTree, TreeLimits } from "../code-host/base.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult } from "../common/result.ts";

// Milestone 8 (ticket 02, F-145, ADR 0069): the repos a fake code host reads at a commit, in
// memory. The tiny code host and the fake GitHub serve the same ones, so the contract suite reads
// the same trees through both: a public repo and a private one behind the installation, commits
// that move on a branch and a tag that stays, and a skill tree with `SKILL.md` folders at several
// depths, an executable script, a symlink that stays inside a skill and one that leaves it, and a
// file over the suite's byte cap.

/** A file or a symlink in a tree at a commit. */
export type FakeTreeEntry =
  | { readonly kind: "file"; readonly content: string | Uint8Array; readonly executable?: boolean }
  | { readonly kind: "symlink"; readonly target: string };

/** A tree at a commit, by repo-relative path. Folders are implied by the paths. */
export type FakeTree = Readonly<Record<string, FakeTreeEntry>>;

export type FakeTreeRepo = { readonly fullName: RepoFullName; readonly private: boolean; readonly defaultBranch: string };

export type FakeRepoTrees = {
  readonly repos: readonly FakeTreeRepo[];
  readonly repo: (fullName: string) => FakeTreeRepo | undefined;
  /** The commit a branch, a tag, a full SHA or `HEAD` (the default branch) names now, or `undefined`. */
  readonly resolve: (repo: RepoFullName, ref: string) => GitSha | undefined;
  readonly tree: (repo: RepoFullName, commit: string) => FakeTree | undefined;
  /** Makes `tree` a new commit on `branch`, moving the branch on, as a push does: its SHA. */
  readonly commit: (repo: RepoFullName, branch: string, tree: FakeTree) => GitSha;
};

const file = (content: string | Uint8Array, executable = false): FakeTreeEntry => ({ kind: "file", content, ...(executable ? { executable } : {}) });
const symlink = (target: string): FakeTreeEntry => ({ kind: "symlink", target });

/** A file's bytes as a host serves them. */
export const fakeTreeBytes = (entry: Extract<FakeTreeEntry, { readonly kind: "file" }>): Uint8Array =>
  typeof entry.content === "string" ? new TextEncoder().encode(entry.content) : entry.content;

/** The suite's byte cap: under the skill's PDF, over everything else in its folder. */
export const SKILL_TREE_BYTE_CAP = 16 * 1024;

/** The skill whose folder the suite reads. */
export const SKILL_FOLDER = "skills/pdf";

/**
 * The public repo's first commit. `SKILL.md` folders sit 1, 2, 4 and 5 folders deep; the PDF
 * skill has a script with its executable bit, a link to a file in its own folder (followed) and
 * one to a file outside it (left out), and a file over `SKILL_TREE_BYTE_CAP`.
 */
export const skillTree: FakeTree = {
  "README.md": file("# Skills\n"),
  "writer/SKILL.md": file("---\nname: writer\ndescription: Writes release notes.\n---\n# Writer\n"),
  "skills/pdf/SKILL.md": file("---\nname: pdf\ndescription: Reads and fills PDF forms.\n---\n# PDF\n\nSee reference.md.\n"),
  "skills/pdf/reference.md": file("# Reference\n\nFields are named by their labels.\n"),
  "skills/pdf/forms.md": symlink("reference.md"),
  "skills/pdf/style.md": symlink("../shared/style.md"),
  "skills/pdf/scripts/extract.py": file("#!/usr/bin/env python3\nprint('fields')\n", true),
  "skills/pdf/assets/sample.pdf": file(new Uint8Array(64 * 1024).fill(0x25)),
  "skills/shared/style.md": file("# Style\n"),
  "skills/team/web/review/SKILL.md": file("---\nname: review\ndescription: Reviews a web change.\n---\n# Review\n"),
  "skills/archive/old/v1/legacy/SKILL.md": file("---\nname: legacy\ndescription: Too deep to be found.\n---\n"),
};

/** What `skillTree`'s PDF skill reads as, with the caps wide open: its link inside followed, as its target's bytes. */
export const skillFolderFiles = ["skills/pdf/SKILL.md", "skills/pdf/assets/sample.pdf", "skills/pdf/forms.md", "skills/pdf/reference.md", "skills/pdf/scripts/extract.py"] as const;

/** The public repo's second commit, which the suite's push makes: the PDF skill changed, and a file added. */
export const movedSkillTree: FakeTree = {
  ...skillTree,
  "skills/pdf/SKILL.md": file("---\nname: pdf\ndescription: Reads, fills and signs PDF forms.\n---\n# PDF\n"),
  "skills/pdf/signing.md": file("# Signing\n"),
};

/** The private repo's one commit. */
export const privateSkillTree: FakeTree = {
  "skills/internal/SKILL.md": file("---\nname: internal\ndescription: Knows the internal deploy.\n---\n# Internal\n"),
};

/** A tag on the public repo's first commit, which stays when the branch moves. */
export const SKILL_TREE_TAG = "v1";

const commitShaOf = (repo: RepoFullName, branch: string, count: number, tree: FakeTree): GitSha => {
  const hash = createHash("sha1").update(`${repo}\0${branch}\0${String(count)}\0`);
  for (const [path, entry] of Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${path}\0${entry.kind === "symlink" ? `->${entry.target}` : Buffer.from(fakeTreeBytes(entry)).toString("base64")}\0`);
  }
  return hash.digest("hex");
};

/**
 * Two repos on `owner`'s account: `<owner>/skills`, public, holding `skillTree` on `main` with the
 * tag `v1`, and `<owner>/private-skills`, private, holding `privateSkillTree`.
 */
export const createFakeRepoTrees = (owner: string): FakeRepoTrees => {
  const repos: FakeTreeRepo[] = [
    { fullName: repoFullNameSchema.parse(`${owner}/skills`), private: false, defaultBranch: "main" },
    { fullName: repoFullNameSchema.parse(`${owner}/private-skills`), private: true, defaultBranch: "main" },
  ];
  const commits = new Map<string, Map<string, FakeTree>>();
  const refs = new Map<string, Map<string, GitSha>>();
  let count = 0;
  const commit = (repo: RepoFullName, branch: string, tree: FakeTree): GitSha => {
    count += 1;
    const sha = commitShaOf(repo, branch, count, tree);
    const byRepo = commits.get(repo) ?? new Map<string, FakeTree>();
    byRepo.set(sha, tree);
    commits.set(repo, byRepo);
    const refsOf = refs.get(repo) ?? new Map<string, GitSha>();
    refsOf.set(branch, sha);
    refs.set(repo, refsOf);
    return sha;
  };
  const [publicRepo, privateRepo] = repos;
  if (publicRepo === undefined || privateRepo === undefined) throw new Error("the fake has its two repos");
  const first = commit(publicRepo.fullName, "main", skillTree);
  refs.get(publicRepo.fullName)?.set(SKILL_TREE_TAG, first);
  commit(privateRepo.fullName, "main", privateSkillTree);
  return {
    repos,
    repo: (fullName) => repos.find((candidate) => candidate.fullName === fullName),
    // `HEAD` names the default branch's head, as GitHub's commits API reads it (ticket 27's look with no ref).
    resolve: (repo, ref) =>
      refs.get(repo)?.get(ref === "HEAD" ? (repos.find((candidate) => candidate.fullName === repo)?.defaultBranch ?? ref) : ref) ?? (commits.get(repo)?.has(ref) === true ? ref : undefined),
    tree: (repo, sha) => commits.get(repo)?.get(sha),
    commit,
  };
};

/**
 * Reads a fake tree as a host would, through the shared collector, its entries offered in path
 * order as `git archive` writes them. The caller found the tree at its commit and checked access.
 */
export const readFakeTree = (tree: FakeTree, path: string, limits: TreeLimits): AdapterResult<RepoTree> => {
  const folder = treeFolderOf(path);
  if (folder === null) {
    return adapterError("invalid-input", "a folder to read is repo-relative, with no `..`");
  }
  const problem = treeLimitsProblem(limits);
  if (problem !== null) {
    return adapterError("invalid-input", problem);
  }
  const collector = createTreeCollector(folder, limits);
  for (const [entryPath, entry] of Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.kind === "symlink") {
      collector.symlink(entryPath, entry.target);
      continue;
    }
    const bytes = fakeTreeBytes(entry);
    if (collector.wants(entryPath, bytes.length)) {
      collector.file(entryPath, entry.executable === true ? "executable" : "regular", bytes);
    }
    if (collector.full()) {
      break;
    }
  }
  return ok(collector.finish());
};
