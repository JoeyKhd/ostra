# Target: a join token, shown once (milestone 5, screen 3)

> **Committed image:** `pool-join.webp`, downscaled from its 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `pool-join.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, an edit of `pool-new`'s generation (its sheet's content replaced). References: that generation, `app-targets/m4/member-invite-link`'s generation (the screen this one starts from: the code box, the teal copy button and the lines under it), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. The page behind the sheet was dimmed afterwards by a script (×0.6 left of the sheet's edge).
- **Route:** none of its own. The same `Sheet` as `pool-new`, after `Create pool`; and the sheet that `New token` opens, on the pool page's top bar and in the Runners page's properties panel. It's never reachable by a link: the token exists only in the answer that made it.
- **Features:** F-091 (join tokens: a lifetime, shown once, hashed, revoked), F-013 (the runner from the npm CLI and from the runner image), F-118 (the runner's Helm chart). Spec section 12, screen 3; section 3, steps 1 and 3. Ticket 25 (`pools.create`'s and `joinTokens.create`'s answer, `joinTokens.list`, `joinTokens.revoke`), ticket 30 (this sheet).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 30 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The token is the secret that adds a machine to the organization's fleet, so this sheet shows it once, says plainly what it allows, and gives the three ways to start a runner with it. None of the three puts the token on a shell line: each reads it from a file (`OSTRA_JOIN_TOKEN_FILE`) or a Kubernetes secret, so it stays out of shell history, `ps` and the CI log a command was pasted into (ticket 30).

The picture shows the sheet right after Alex Kim made `build-fleet` (`pool-new`): its first token, the `ostra runner` tab, and the pool's one token in the list.

## Layout (CSS px at 1440 wide)

The `pool-new` sheet: **450px**, full height, from the right, `--bg`, 1px `--line-2` on its left, padding `24px 28px`, a body that scrolls and a footer pinned to the bottom with a 1px `--line` above it. The page behind is dimmed by `bg-black/60` and inert.

Inside, top to bottom, one left edge:

1. **Header.** Title, Manrope 700 19px, and the close `X`:
   - after `Create pool`: `Pool created`
   - after `New token`: `Join token created`
   Under it, 6px, 14px `--muted`, the pool's name in Plex Mono `--text`:
   - approval required: `Runners join {pool} with this token, then wait for an admin to approve them.`
   - not required: `Runners join {pool} with this token and take tasks at once.`
2. **Join token** (field label, 13px `--muted`). A code box (`Code`: `--surface`, 1px `--line-2`, radius 8px, padding `10px 14px`), the sheet's full width, holding the **full** token in Plex Mono 14px `--text`, wrapping (`break-all`), selectable: `ostra-join-` and 43 base64url characters. Under it, 8px, a teal link button with Lucide `copy` 15px: `Copy token` (`Copied` with `check` for 1.5s). It copies the token alone, with no newline; the clipboard is the only place it goes, and it's never logged.
3. 12px below, 13px `--muted` with Lucide `shield` 14px: `Anyone with this token can add a runner to this pool.` With approval off, it adds: ` Turn on approval to check each one first.`
4. 8px below, 12.5px `--faint`: `Shown once. It expires on {date}.` (`19 Dec 2026`), or `Shown once. It doesn't expire: revoke it when you're done.`
5. A hairline, then **Start a runner** (field label), then underline `Tabs` in 14px: `ostra runner` · `docker run` · `Helm`. The selected tab is `--text` with a 2px Shell underline; the others `--muted`. A hairline runs under the tab row. The first tab is selected on open, except on a pool whose runners all run `kubernetes`, where `Helm` is. The choice isn't remembered.
6. **One code box** under the tabs, the sheet's full width, Plex Mono 13px `--text`, `white-space: pre`, scrolling sideways inside itself when a line is long, with a teal `Copy` (Lucide `copy`) in its top-right corner. Its content is the selected tab's:

   **`ostra runner`** (the npm CLI, F-013):
   ```
   OSTRA_JOIN_TOKEN_FILE=./join-token \
     npx {cliPackage}@{serverVersion} runner \
     --server {OSTRA_PUBLIC_URL} \
     --executor {executor}
   ```
   **`docker run`** (the runner image, as `deploy/compose.yaml`'s `runner` service runs it):
   ```
   docker run -d --name ostra-runner --restart unless-stopped --user root \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v /var/lib/ostra-runner:/var/lib/ostra-runner \
     -v "$PWD/join-token:/run/secrets/join-token:ro" \
     -e OSTRA_SERVER_URL={OSTRA_PUBLIC_URL} \
     -e OSTRA_RUNNER_EXECUTOR=docker \
     -e OSTRA_JOIN_TOKEN_FILE=/run/secrets/join-token \
     -e OSTRA_RUNNER_DATA_DIR=/var/lib/ostra-runner \
     {imageNamespace}/runner:{serverVersion} runner
   ```
   **`Helm`** (the `ostra-runner` chart's values, ticket 23):
   ```
   # kubectl -n ostra create secret generic ostra-join-token --from-file=token=./join-token
   # helm install ostra-runner https://github.com/JoeyKhd/ostra/releases/download/v{serverVersion}/ostra-runner.tgz -n ostra -f values.yaml
   server:
     url: {OSTRA_PUBLIC_URL}
   joinToken:
     existingSecret: ostra-join-token
   ```
   - `{executor}` is the pool's executor when its runners share one, and `docker` for a pool with no runner yet. `{serverVersion}` is the server's own version (`/runner/v1/info`), so the runner starts pinned to it (spec section 4, "The pin"). `{cliPackage}` and `{imageNamespace}` are where the server's release published the CLI and its images, the root `package.json`'s `cliPackage` and `imageNamespace`, which the release's stamp writes (`ostra` and `ostra` in a clone); the Helm line installs the runner chart that release attached. *Changed 2026-11-21: they were typed as `ostra`, which no release publishes. On a development build (`0.0.0`) the Helm line is a clone's `./deploy/helm/ostra-runner`, under a comment that says so.* The value names in the Helm values follow the chart's Zod schema (ticket 23); the build reads them from it, not from this file.
   - `Copy` copies exactly what the box shows, and never the token: the token goes in through the file or the secret.
   - The `docker run` tab adds, under the box, 12.5px `--faint` with Lucide `info`: `The Docker socket is root on this host: run pool runners on hosts of their own.` (the compose file's note, Q97).
7. Under the box, 10px, 12.5px `--faint` with Lucide `file` 14px:
   - `ostra runner`, `docker run`: `Save the token to a file named join-token first. The command reads it from there, so it stays out of your shell history.`
   - `Helm`: `Save the token to a file named join-token first. The secret holds it; the chart reads it from there.`
8. A hairline, then **Join tokens** (12px 500 `--faint` label) and a faint mono count of active tokens. The pool's tokens, newest first, as on the pool page: the label (`Join token` with none) in `--text` 14px, under it 12.5px faint mono `expires {date} · never used` (or `used {age} ago`, `{n} runners`), and a `--muted` ghost `Revoke` at the right. Revoked tokens: struck through, `revoked {date}`, no button. The row of the token just made has no marker beyond being first. `Revoke` asks first (the Runners page's `AlertDialog`); revoking the token just made also clears the code box above, which then reads `Revoked. Make another with New token.` in `--faint`.
9. **Footer**, pinned: primary `Done` (closes the sheet) and secondary `Open {pool}` (closes it and goes to the pool page).

Closing the sheet any way (`Done`, `Open {pool}`, `X`, Escape, the overlay) drops the token from the page. Nothing re-fetches it, and a reload never shows it again (ticket 30's test).

### Before it: `New token`'s short form

`New token` (pool page top bar, Runners page panel) opens the same sheet with a form first, built from `pool-new`'s parts: title `New join token for {pool}`, **Label** (`Input`, optional, at most 100 characters, placeholder `Join token`), **Lasts** (the three radio rows of `pool-new`, with the pool's lifetime picked), and the footer `Create token` / `Cancel`. `joinTokens.create` answers the token once and the sheet swaps to this screen.

## States and copy

| State | What changes |
|---|---|
| Pool created (the picture) | title `Pool created`, the first token, `ostra runner` selected, one token listed |
| Join token created | title `Join token created`; the list holds the pool's other tokens below the new one. Rotation: making a second token and revoking the first disconnects no runner (spec section 3, step 3); the revoke dialog says so already |
| Approval off | the line under the title and the shield line read as above |
| No expiry | `Shown once. It doesn't expire: revoke it when you're done.`; the list row reads `never expires` |
| `docker run` or `Helm` selected | the code box holds that tab's text; the box grows to fit (at most 12 lines, then it scrolls) |
| Copied | `Copy token` → `Copied` 1.5s; the box's `Copy` → `Copied` 1.5s |
| Clipboard refused | `Copy` reads `Select and copy it yourself` in `--muted` for 3s and selects the box's text |
| Revoke failed | one `--red` line under the Join tokens label, `role="alert"`, from `errorText()` |
| A member (not an admin) | never reaches this sheet; `joinTokens.create` answers `FORBIDDEN` |
| Phone (F-075) | the sheet takes the full width; the tabs stay on one line; the code box scrolls sideways inside itself, the page never does; the footer stays pinned above the safe area |

## Components (shadcn/ui names)

`Sheet` / `SheetContent` (as `pool-new`), the existing `Code` box, `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` (underline style), `Button` (default = Shell primary; secondary; `link` teal for `Copy token` and `Copy`; ghost for `Revoke`), `AlertDialog` (revoke), `Separator`, and for the short form `Field` / `Input` / `RadioGroup`. Lucide 15px, stroke 1.75: `x`, `copy`, `check`, `shield`, `file`, `info`.

## Tokens

At the approved pictures' scale (`../m1/README.md`, "Scale"; the colours `app-design.md` lists).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | the sheet |
| `--surface` | `#131416` | the two code boxes |
| `--line` | `#1F2023` | hairlines, the tab row's rule, the footer's rule |
| `--line-2` | `#2A2C30` | the sheet's left edge, code box borders, the secondary button |
| `--text` | `#F2F3F4` | the token, the commands, the selected tab, labels |
| `--muted` | `#B4B7BB` | field labels, lines, the other tabs, `Revoke` |
| `--faint` | `#8B8E93` | "Shown once…", the file line, token details |
| `--teal` | `#6FB8AA` | `Copy token`, `Copy` |
| `--red` | `#E5675C` | errors, the destructive button in the revoke dialog |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Done`, the selected tab's underline |
| `--amber` | `#FFB224` | nowhere in the sheet. The token shown once is not an alarm |

Type: Manrope 700 19px (the title); IBM Plex Sans 14px rows and tabs, 13px labels and lines, 12.5px notes; IBM Plex Mono 14px for the token, 13px for the commands, 12.5px for token details.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **The token shown once** lives today in the Runners page's properties panel (`pool-properties.tsx`, a `CopyLink` over the token and `runners.shownOnce`). It moves into this sheet; the panel keeps only the list.
2. **`New token`** today makes a 30-day token with no label at once (`createJoinToken { poolId, expiresInDays: 30 }`). It opens the short form above instead, and `pools.create` answers the first token too (ticket 25).
3. **The connect command** (`pnpm ostra runner --server …` on the Runners page) is the personal runner's and stays there; the three pool paths here are new (spec section 12: "the connect command moves into `pool-join`" for pools).
4. **No `Tabs` component** is used in `components/runners/` yet; use the shadcn one the panel has, in its underline style.
5. **Messages.** New keys under `runners.join.*` in `messages/en.json`. The command texts are built from the server's version and public URL in code, not stored as messages, except their notes.

## Wrong in the image

Build the copy and details in this file, not these:

- **The token** is 42 characters after `ostra-join-`; a real one is 43, and wraps where the box's width breaks it.
- **The `Copy` in the command box** sits on its own line above the command. It's in the box's top-right corner, level with the first line, and the command starts at the box's top padding.
- **The page behind** is `m1/runners`' picture, with its old connect command and an existing `build-fleet` row; build the Runners page as it is, and the overlay as `bg-black/60`.
- **The sidebar** is milestone 1's; build it from the shell. The logo is the model's approximation; use the real Hinge SVG.

All visible copy is spelled right.
