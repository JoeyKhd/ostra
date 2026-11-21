# 02: Adapter SDK: reading a repo at a commit

Status: done
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

- [x] Tests named for `F-145`: the suite's cases pass on GitHub against the fake and on the fake itself. A tree read at a commit doesn't change when the branch moves (break-it: read the branch's head instead, and the case fails).
- [x] The tiny adapter's absence is declared, and an install through it would be refused (the capability check).
- [x] Checks for the touched packages pass (spec section 10).
- [x] Committed as `✨ read a repo's files at a commit`.

## Comments

- 2026-11-21, adapters: committed as `✨ read a repo's files at a commit`. Built. `CodeHostAdapter` gains the capability `readTree` with `resolveRef` and `readTree` (`packages/adapter-sdk/src/code-host/base.ts`), each `unsupported` by default with the words `readTreeRefusal(host)` returns, which is the capability check ticket 27 calls before an install. The rules every host shares are in the SDK, so a later GitLab reads alike: `createTreeCollector` (`code-host/tree.ts`: the folder, the caps while reading, symlinks) and a streaming tar reader, `readTar` (`code-host/tar.ts`: ustar, pax and GNU long names, the global comment). GitHub (`adapter-github`) resolves a ref through the commits API (422 is `null`) and reads a tree from the commit's tarball: the redirect's download is fetched with no token, gunzipped and unpacked as it streams, with only the folder's files within the caps held. Nothing is written to disk at all, so no temporary folder is needed; an archive past 1 GiB unpacked or 120 s is refused. An archive whose `git archive` comment names another commit is refused. Anonymous reads share one budget key, which also learns from GitHub's 403, and its refusals get the panel's words: `rate-limited` with the reset ("GitHub's limit for reading public repos without an installation is used up …") and `not-found` naming the GitHub App for a repo that isn't public. The fake code host (the tiny host with `trees`, from `testing/fake-repo-trees.ts`) and the fake GitHub (commits, tarball and codeload routes, anonymous and through the installation) serve the same repos: `<owner>/skills`, public, with `SKILL.md` folders 1, 2, 4 and 5 deep, a script with its executable bit, a link inside a skill and one leaving it, a 64 KiB file over the suite's cap, a tag that stays, and a branch the suite moves; `<owner>/private-skills` behind the installation. The tiny host, core's and the API's fakes declare `readTree: false`. Tests: the suite's six `F-145/c1` and `F-145/c2` cases in `packages/adapter-sdk/src/testing/code-host-suite.ts`, passing on GitHub against the fake GitHub and on the fake code host, the absence case on the tiny host; GitHub's own cases (the anonymous limit's words and its budget, a private repo's words, read-only tokens narrowed to the repo and no token at the download, a missing download URL and a non-gzip archive); unit tests of the collector and the tar reader. Decisions: `maxBytes` caps the files' bytes in all, and a file over what's left is left out with a note while later ones still come, so a big asset doesn't hide the skills after it; reading stops at the first file past `maxFiles`. The result carries `notes` beside `files` and `truncated` (`symlink-outside`, `symlink-dangling`, `over-max-bytes`, `over-max-files`, at most 100), so ticket 27's refusal can name what was left out; a link that loops back to a folder holding it counts as leaving. A link to a folder inside is followed, its files under the link's path. `readTree` takes a full SHA only: a branch's name is `invalid-input`, so what's read is what was pinned. `mode` is `regular` or `executable`. No break-it pass, under the maintainer's 2026-11-21 change. The agent parity table (`parity.ts`) is agent-only, so spec section 6's `readTree` line is the code host suite's absence case rather than a table row. Checks: typecheck and lint of `packages/adapter-sdk`, `packages/adapters/adapter-github`, `packages/api` and `apps/core`; tests of the first two.
