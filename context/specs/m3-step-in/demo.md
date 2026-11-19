# Milestone 3 demo: step in and come back

**Run:** 2026-11-19, 14:41 to 16:40 UTC, on Windows 11 with the `host` executor, by the scripted run (`pnpm e2e:m3`, ticket 50), driving two members' browsers with Playwright: Demo (the default first admin) and Sam (`pnpm dev:seed-member sam`).
**Stack:** a fresh dev stack from an empty data folder on ports 3630 (panel), 9230 (core) and 54830 (Postgres), `OSTRA_BOX_IDLE_MINUTES=5`, `OSTRA_RECONCILE_MINUTES=2`, `OSTRA_EMAIL_DELAY_SECONDS=0`, a cloudflared quick tunnel to core for Linear's webhooks.
**Targets:** Linear `ostra-test` team `OST`, ticket [OST-75](https://linear.app/ostra-test/issue/OST-75/set-the-release-name-in-configsettingsjson); GitHub `ostra-test/test1`, PRs [#71](https://github.com/ostra-test/test1/pull/71) (merged) and [#77](https://github.com/ostra-test/test1/pull/77) (the fresh branch after the merge, left open as step 12 says); `ostra-test/test2` for the service.
**Model:** the one in `model.env` (DeepSeek V4.1 Flash), through OpenCode 2.3.2.
**Mail:** no Resend key yet (Q186), so email went over SMTP to the in-process server the script starts (`e2e/m3-step-in/src/fixtures.ts`), with AUTH, as ticket 50's decision says.

Screenshots are in [`demo/`](demo/), named by step, and every check's last result is in [`demo/checks.json`](demo/checks.json) (59 passed; the two failures there are checks that were wrong, each with a note). The machine's folders and the dev endpoint are masked (the magenta blocks).

## What the script does

`e2e/m3-step-in/` runs spec section 3 as named steps, each skipped once it happened, with its state in `.ostra-dev/e2e-m3/run.json`:

```
node e2e/m3-step-in/src/fixtures.ts         # the SMTP server and the release-names MCP server, kept up
node e2e/m3-step-in/src/runner-process.ts   # the personal runner on host, kept up
pnpm e2e:m3 [step …]                        # setup smoke profile environment email ticket plan approval steer
                                            # checks diff update-branch local merge cancel usage home mail services secrets
```

It reuses milestone 1's helpers (provider, App, project, runner) and milestone 2's (the Linear seed, the board).

## The steps, as they ran

| Step | What happened | Evidence |
|---|---|---|
| Before | Fresh stack; the provider, the App, `test1` and `test2`, Linear seeded with a webhook on the tunnel, `OST` attached to `test1`, the runner approved on the device page. Every new page (Needs you, Account, Notifications, the board, Email) loads for both members. | `01`–`07-*.png`, `smoke-*.png` |
| 1. A profile | `Careful` made in the editor: the model, the instructions, the `changelog` skill, the `release-names` HTTP MCP server with its bearer token stored as a secret, the rule `Settings files` (edit `config/**`), plan first on. `test1` picks it for code tasks. | `step01-*.png` |
| 2. Start with the profile | The script created OST-75; it reached the Inbox by webhook. The picker offered `Careful` first, then `OpenCode`; Demo started it on `m3-runner` and drives. | `step02-*.png` |
| 3. Plan first | The first turn ran with `mode: plan`, changed no file (`git status` clean in the worktree), and its plan showed as "Needs you · plan" in the thread. Within seconds: the sidebar count read 1, Home showed the plan first, ostra commented on OST-75 that it waits for a plan approval, and a mail "A plan to approve · OST-75 …" reached Demo with no ticket text in it. Demo pressed "Edit and approve", added "Also put today's date in the changelog line", and approved; the receipt marks that step `edited`. | `step03-*.png` |
| 4. An approval by another member | The agent called `release-names` (through the sidecar's MCP proxy, with the token) and then asked to edit `config/settings.json`; the rule held it. Sam saw it on Home and on the task, the card named the rule and the file, and "Approve for this task also approves later requests that match: Edit config/settings.json in this task". Sam pressed it: the receipt reads "Approved for this task by sam", the task rule shows under "Approval rules", the audit log has the entry, and Demo's Needs you lists it. | `step04-*.png` |
| 5. Steer, interrupt, take over | Demo's Send reached the agent mid-turn (`delivery: immediate`). "Interrupt and send" cancelled the turn and its message started the next (`after-interrupt`). Sam pressed Take over: the thread says "sam took over", and Demo's composer turned into "sam is driving · Take over". | `step05-*.png` |
| 6. Checks before the PR | After the turn the runner ran `whitespace` and `settings-json` and pushed; PR #71 opened ready, with a "Checks" section naming both as passed. The Checks tab lists both with their times. | `step06-*.png`, PR #71 |
| 7. The diff with comments | The Changes tab showed `test1`'s branch against `main` (`CHANGELOG.md`, `config/settings.json` with `"releaseName": "Quiet Heron"`, the MCP tool's answer). Sam commented on two lines and pressed "Send 2 comments to the agent": one member message with intent `diff-comments`; the agent's commit moved PR #71's head; both comments show "Sent". | `step07-*.png` |
| 8. Update branch | The script committed to `main` through the App. Within 90 s (the reconcile; the test App has no webhook) the task read 3 commits behind; Sam pressed "Update branch"; a turn merged `main` with no conflict, and the branch read 0 behind. | `step08-*.png` |
| 9. Take it local | "Take it local" showed `ostra checkout OST-75`. `ostra login` printed a code, Sam approved it on the device page, `ostra checkout OST-75` put Sam's clone at the PR's head. Sam's hand-made commit was pushed; Sam reopened with "Read my last commit and say what it did", and the agent named the commit's file. "Account › CLI sessions" listed the session; after Revoke the next checkout was refused (exit 1). | `step09-*.png`, `step09-branch-activity.txt` |
| 10. `@ostra` on the PR | **Not run**: the test App has no webhook and there is no token for a linked member's GitHub user (ticket 51, steps 9 and 10), as ticket 50 says. | — |
| 11. Merge, then a fresh branch | The script merged PR #71; the task went to merged and OST-75 to Done (16:06, by the reconcile). Sam reopened: the task got `…-config-settings-2` from `main`'s new head and PR #77, and the properties list both PRs. | `step11-*.png` |
| 12. A ticket cancelled while its task runs | During the follow-up's turn the script cancelled OST-75 in Linear: `ticket.closed` and a turn ended `cancelled` within 2 s; the task showed "Needs you · ticket closed" with Stop the task and Keep working. Sam stopped it; PR #77 stays open. | `step12-*.png` |
| 13. Usage | The task's totals (144.1k in · 29.3k out · 2.25M cache read) equal the sum of its 77 `usage.recorded` events; 12 turns each carry their own figures and agent time (3 m 18 s in all); each turn's footer shows its tokens. | `step13-usage.png` |
| 14. Home and Needs you | Sam's Home and its board (five columns by state, both projects); Sam's Needs you, open and done. | `step14-*.png` |
| 15. Mail | The test mail and each needs-you mail went through SMTP with AUTH; none carries the ticket's text. | `step15-*.png` |
| 16. Services and the cache on `host` | `test2`'s environment lists `db` (`postgres:17`); its prompt task stays queued with "Waiting for a runner that can start services. Online now: m3-runner (host)." With a setup script on `test1`, two more tasks' setup lines read "dependency cache: warm" (67 ms and 160 ms). | `step16-*.png` |

## The checks after the run

| Check | Result |
|---|---|
| Nothing reached the agent that shouldn't | **Passed.** Searched by value, never printed: the event log and 3 logs for 29 values (the MCP token, the SMTP password, the Linear key, the model key, the App's key) and the GitHub token pattern, and 583 files of the runner's folder (worktrees and agent folders): none holds one. The agent reached `release-names` once, through the sidecar's proxy, with the token; no request came without it. The plan turn changed no file (step 3). |
| The profile won | Proved by tests, not live: ticket 08's `adapter-opencode` contract cases and ticket 29's `profile-launch.opencode.test.ts`. |
| Deny | Proved by tests (ticket 30, on both fake agents and on OpenCode with stub models); not answered by hand in this run. |
| Expiry | Proved by tests (tickets 17 and 30, timers at seconds). |
| A no-steer agent | Proved by tests (ticket 19's fold and API cases, ticket 31's fake agent). |
| The race | Proved by `packages/api/src/routers/steering.test.ts` (50 runs each for send and interrupt). The live two-member race of step 4 was not scripted. |
| A failing check | Proved by ticket 23's live test (`apps/core/evidence/m3-pr-live.txt`) and the core tests. |
| No duplicates | **Passed.** Two of ostra's comments on OST-75 (the progress comment and the needs-you comment, edited in place); five mails for five moments (the test, OST-75's plan and approval, two other tasks' plans); one PR per repo and branch: #71 and, after the merge, #77. |
| Mail off | Proved by the core test "F-115: with mail off, every email delivery is skipped in words and the panel's are sent" (`apps/core/src/notifications/email.test.ts`, ticket 21) and the smoke screenshot `demo/smoke-email-settings.png` (the Email settings page before SMTP was set, Mail: Off). The notification page's own Playwright case belongs to ticket 45, which is still open. |
| Notification choices | Not run live. |
| Clean-up | PR #77 and OST-75 are left as step 12 leaves them; the fixtures stop with their process. |

## What this run found and fixed

- **A member's commit was lost on a reopen** (F-103). A session resumed in a kept `host` box didn't fetch the task's branch, so the agent saw stale code, and the runner's push after the turn, which is forced, rewound Sam's pushed commit (GitHub's activity: `force_push db0e208 -> 77ed0aa`). Fixed in `761a908`: a resumed box takes the branch's new commits first (fast-forward or merge). The re-run kept Sam's commits (`push 77ed0aa -> 9d292e4`, `9d292e4 -> c13800f`), and the agent named the hand-made commit's file from a resumed session. `step09-branch-activity.txt` holds both.
- **The plan became the PR's description** (F-063). With no `pr.text_set`, the PR body fell back to the session's last agent message, which was the plan as proposed. Fixed in `b8d9a26`; PR #71 was opened before the fix and keeps that text.
- **A merged task offered no Reopen** although the domain reopens it on a fresh branch (F-066). Fixed in `54194b1`.
- **The approved plan's receipt named nobody**, and a take-over read "{name} is driving now ({name} handed it over)". Fixed in `60d0a3d`.
- **The panel's milestone 3 screens weren't connected** (tickets 43 to 47): the approval card, the question form, the plan, the watcher's bar, usage, the ticket-closed block, the Activity/Changes/Checks tabs, Take it local, Needs you with its sidebar count, the board, Account, Notifications and Email. Wired in `3af06b0`, and the setup line's dependency cache in `6f33bbb`.

## What surprised, and what's missing

- **Another session's clean-up closed PR #71 and deleted Linear's webhook mid-run.** Milestone 2's demo clean-up closed every `ostra/ost-*` PR on `test1` and deleted every dev-seed webhook (since fixed in `5613b0a` to touch only its own). The PR was reopened by that session, but this stack had already read it as closed (`closed_unmerged`) and nothing reads a reopened PR back as open: the script set the row back by hand (logged here) and re-seeded the webhook. A PR reopened on GitHub should be read back by the PR reconcile; it isn't yet.
- **Plan mode hides an MCP server that isn't marked read-only**, so the plan said it couldn't find `release-names`; the build turn used it. Expected by ADR 0049, but the plan reads oddly: marking the server read-only would let plan mode call it.
- **The ticket stays Done when a merged task reopens**, so a cancel after that is "a close after the merge" and does nothing. Step 12 moved OST-75 back to In Progress first, as a person would.
- **Home's spend** (`$0.02` for November) disagrees with the task's (`$0.24`): Home prices at the catalog, the task at the key proxy.
- **Not done in this run:** step 10 (`@ostra`, waiting on ticket 51's App webhook and a member token); the manual run by hand with the maintainer's own inbox, Linear notification and GitHub OAuth link; the live Resend send (no key, Q186); the "notification choices" and "deny once on OpenCode" checks by hand; a second `pnpm e2e:m3` from an empty data folder (the run here went step by step on one stack).
- **What waits for the Linux machine** (ticket 14's comments): a snapshot built from the generated Dockerfile with its setup secret, the scan and its negative control, a box started from the snapshot that sees its repos, the nightly rebuild after a default branch moved, and `db` started, healthy and reachable by name from the agent's container (`snapshot.live.test.ts`, `docker.live.test.ts`). F-051 and F-094 stay `building`.
- **The screens against their targets:** the wiring follows the targets' structure but wasn't checked against each picture by eye; the plan's block and receipt sit at the end of the thread rather than under the plan turn; the Changes tab counts repos, not files; the "Approval rules" group lists the task's rules but not the profile's. Tickets 43 to 47 stay open for their Playwright cases and that pass.
