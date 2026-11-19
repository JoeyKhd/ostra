# The diff, its comments, and taking a task local

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 3's spec: "continue working on everything throughout the night"). Settles Q175 to Q177. Covers F-027, F-072, F-028 and F-103, and builds on ADR 0027 (one branch per changed repo), ADR 0039 (after every turn the box pushes), ADR 0046 (one CLI) and ADR 0029 (a CLI session isn't a runner's key).

## The diff

- **It's the code host's compare of the pushed branch against its base** (Q175), fetched by core through the App and cached by repo, base SHA and head SHA, so many viewers cost one call and an unchanged head is never fetched again. Since milestone 2 the box pushes after every turn, so the diff is the task's work "as of the last turn". Work in a turn that's still running shows in the thread's edit rows, not in the diff.
- **The runner isn't asked for a diff.** A box that's stopped or released still has a diff, and the code host already computes it.
- **Over the code host's limits, or ostra's** (300 files, 1 MiB a file, *working values*), a file says "Too large to show here" and links to the code host. Nothing is cut silently.
- **ostra renders it itself:** a unified view from a small parser in `packages/domain`, monospace, with both line numbers, the palette's diff colours and list virtualization for long diffs. **No syntax highlighting in milestone 3.** A highlighter (Shiki or similar) is a dependency the maintainer hasn't approved, and the diff reads without it. Revisit when members ask, with the dependency's size and its WASM in the bundle measured.

## Diff comments

- **A comment is a draft until its member sends it** (Q176), private to that member, so one person's half-written review doesn't steer the agent.
- **Each is anchored by task repo, path, side, line and the head it was written on.** When a later head changes the line, the comment is marked outdated and stays readable; it isn't moved, because a moved comment can land on code it wasn't about.
- **"Send N comments to the agent" sends all of a member's drafts on the task as one prompt** (F-072): each comment with its file, line and the quoted lines, inside marked blocks, since the quoted code and the comment are both untrusted text.
- **Sending follows the composer's rule** (ADR 0036): the driver sends to a running or idle session; with no session going, sending reopens the task as a reopen does; a member who isn't the driver of a task with a session going takes over first.

## Taking a task local

- **`ostra login` makes a CLI session,** a credential of its own (Q177, ADR 0029): a device-code grant the member approves on the device page, a random token shown to the CLI once and stored hashed, valid 30 days *(working value)*, listed in the member's Account with its machine's name and last use, and revocable. It isn't a runner's key and can't become one, and a runner never shares its key with it.
- **A CLI session reads one thing:** a task's branches, base branches and clone URLs, for tasks in projects the member can open. Every other API refuses it.
- **`ostra checkout` uses the member's own git access.** ostra hands out no token: the member already clones the repo with their own credentials, and a GitHub token from ostra would be a second way into the repo for the CLI to keep safe. It finds the member's clones by their remote, clones the ones that are missing, refuses a clone with uncommitted changes, and checks the branch out tracking the remote.
- **A reopen starts from the branch as it is,** hand-made commits included (F-103): milestone 2's restore merges the branch's new commits onto the saved work (ADR 0039).

## Considered options

- **The runner computes and uploads the diff after each turn.** Rejected: a duplicate of what the code host does, and nothing for a released box.
- **Comments sent one at a time, as they're written.** Rejected: F-072 asks for one prompt, and each send is a turn and its tokens.
- **Comments moved to the line's new position.** Rejected, as above. GitHub itself marks review comments outdated.
- **`ostra checkout` with a short-lived GitHub token from ostra.** Rejected: the member's own access is enough, and a token in a terminal outlives its purpose.
- **The CLI on the member's browser session cookie.** Rejected: a CLI session must be listable and revocable on its own (F-103).

## Consequences

- The code host interface gains `compare` and, for GitHub, the compare endpoint's limits reported per file (milestone 3's spec, section 5.2).
- The schema gains diff comments, the diff cache and CLI sessions; `DeviceCode` gains its purpose (section 5.3).
- The web app serves `/api/cli/v1/` beside tRPC, with schemas in `packages/protocol`, since the CLI is Apache-2.0 and the panel isn't (ADR 0048).
