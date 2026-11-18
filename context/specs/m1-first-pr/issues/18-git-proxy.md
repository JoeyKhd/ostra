# 18: The git proxy

Status: resolved
Builder: runner
Blocked by: 02
Features: F-090
Packages: `apps/runner` (`src/sidecar/git-proxy/`)
Spec: `../spec.md`, sections 2 and 4

## What to build

The git proxy of ADR 0030 as amended, with everything F-090's "done when" now lists from spike 4.

- Smart HTTP for one repo. The agent's `git` reaches it by a `url.<proxy>.insteadOf` rule the executor writes (ticket 19). The proxy adds the task's one-repo token, fetched from the task's credentials and refreshed through a token provider before it expires.
- **Pushes:** read the command list of each `git-receive-pack` request. Refuse any ref except the task's branch and `refs/ostra/wip/<taskId>`, and any delete, before a byte reaches GitHub. Answer in git's own words (`unpack ok`, then `ng <ref> <reason>`, in side-band when asked), and a plain 403 only when the client asked for no report. Read and drop a refused push's body up to 1 GiB (Q123), then close.
- **Read-only mode** for refine and review tasks (milestone 6 uses it; built and tested now): refuse the receive-pack advertisement, LFS uploads, LFS lock checks and every non-GET LFS action.
- **LFS:** rewrite batch answers so signed URLs and headers never reach the agent (nonce URLs on the proxy, kept at most an hour); drop actions outside the upstream or the task's `lfsActionHosts`; an object with a refused action gets a per-object error and no actions, never an empty `actions`.
- Every upstream request carries a `User-Agent`. Refusal messages are worded by status and by where the refusal came from (the git endpoint or an LFS host), and the log keeps the upstream's status and reason, never the body.
- On `host` the proxy listens on loopback with a random per-task path segment, and hands out URLs on the address the agent uses.

## Port from

`spikes/github-app-and-git-proxy/src/git-proxy.ts`, `pkt-line.ts`, `policy.ts`, `fake-token.ts`, `upstream-stub.ts` (as the test upstream), and its tests (`policy`, `pkt-line`, `lfs-action-href`).

## Done when

- [ ] Against the upstream stub: stock `git` clones, fetches and pushes the task's branch and hidden ref; a push to the default branch, a delete and a push to another repo each get `! [remote rejected] ... (ostra: <reason>)` with nothing forwarded; LFS upload and download work and a signed URL never reaches the client; every read-only refusal has a test.
- [ ] The stub refuses a request with no `User-Agent`, and the proxy's requests pass it.
- [ ] Gated live run against `ostra-test/test1`: clone, push a test branch and its hidden ref, refused push to `main`, then delete the test refs.
- [ ] A test proves no token reaches the client, a log line or an error.
- [ ] The whole-repo checks pass (spec section 9: credentials, agent output).
- [ ] Committed as `✨ add the git proxy`.

## Comments

- 2026-11-18, runner: done in 4ab7f9a (`✨ add the git proxy`); the upstream stub moved to `@ostra/adapter-sdk/testing` in c5ee411, so the executors' tests share it. `src/sidecar/git-proxy/`: one proxy per task behind a random path segment, serving the task's repos, each with its own one-repo token from a refreshing provider. Pushes are read before a byte goes upstream and refused in git's own words (`! [remote rejected] ... (ostra: ...)`, in side-band when asked). A push to another repo is answered as an empty repo and refused, so no request for that repo reaches the code host. Read-only mode refuses the receive-pack advertisement, LFS uploads, lock checks and non-GET actions. LFS batch answers are rewritten to nonce URLs (at most an hour), and an object with a disallowed action gets a per-object error. Every upstream request carries a User-Agent, and refusals are worded by status and source and logged with status and reason only. Tested with stock git and git-lfs against the stub; the gated live run against `ostra-test/test1` passed (clone, branch and hidden ref pushed, `main` refused, refs deleted after). Whole-repo checks green.
