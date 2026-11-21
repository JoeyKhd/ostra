# 02: Adapter SDK: reading a repo at a commit

Status: ready-for-agent
Builder: adapters
Blocked by: none
Features: F-145
Packages: `packages/adapter-sdk`, `packages/adapters/adapter-github`
Spec: `../spec.md`, section 5.2; ADR 0069 ("ADR 0025, amended")

## What to build

The library fetches a skill's folder at a commit through the code host, so a GitLab adapter later declares the same capability or says it lacks it (adapter parity).

- **`CodeHostAdapter`, capability `readTree`:**
  - `resolveRef(access | null, repo, ref)` → `{ commit }`, or `null` for a ref that doesn't exist.
  - `readTree(access | null, repo, commit, path, { maxFiles, maxBytes })` → `{ files: [{ path, size, mode, bytes }], truncated }`.
  - `access` is `null` for a public repo, read anonymously. With an installation's access, a private repo the installation covers.
  - Paths are repo-relative and stay inside `path`; a symlink is followed only when it stays inside the folder, and is otherwise left out with a note.
- **GitHub** (`adapter-github`):
  - `resolveRef` through the commits API;
  - `readTree` through the commit's tarball, unpacked as a stream with the caps applied while reading, never written to disk outside a temporary folder of its own, which is removed afterwards;
  - the anonymous path's rate limit reported as a refusal the panel can word.
- **The fake code host** gains public repos, one private repo behind an installation, commits that move on a branch, a skill tree with `SKILL.md` folders at several depths, a symlink that leaves the folder, and a file over the cap.
- **The tiny adapters** declare `readTree: false`.
- **The code host contract suite** gains:
  - a ref resolved, and a missing one;
  - a tree read at a commit, and the same tree after the branch moved still read at the old commit;
  - the caps truncating;
  - a private repo refused without access and read with it;
  - the outside symlink left out;
  - the capability's absence declared.

## Done when

- [ ] Tests named for `F-145`: the suite's cases pass on GitHub against the fake and on the fake itself. A tree read at a commit doesn't change when the branch moves (break-it: read the branch's head instead, and the case fails).
- [ ] The tiny adapter's absence is declared, and an install through it would be refused (the capability check).
- [ ] Checks for the touched packages pass (spec section 10).
- [ ] Committed as `✨ read a repo's files at a commit`.

## Comments
