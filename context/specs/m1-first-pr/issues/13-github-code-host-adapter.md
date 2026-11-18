# 13: The GitHub code host adapter

Status: ready-for-agent
Builder: adapters
Blocked by: 04
Features: F-006, F-030, F-078, F-090 (token minting), F-112 (file reads)
Packages: `packages/adapters/adapter-github`
Spec: `../spec.md`, sections 2, 8 and 11 (items 3, 4)

## What to build

`GitHubAdapter extends CodeHostAdapter`, on `@octokit/auth-app` 8.3.1 and `@octokit/rest` 22.0.1 (exact pins).

- **The App.** `appManifest(input)`: the manifest with exactly the permissions spike 4 got GitHub to accept (`contents`, `pull_requests`, `checks`, `actions`, `issues`, `statuses`, `metadata`), no `email_addresses`, no `workflows`; a webhook and its events only when a public URL is given (GitHub refuses a loopback hook URL, F-006). `convertManifestCode(code)`: the App's ID, slug, PEM, webhook secret and client credentials, as a result the caller stores through the secret store. `readApp(appId, pem)`: slug, permissions, events, for "use an existing App".
- **Installations and repos:** `listInstallations`, `listRepos(installationId)`, `getDefaultBranch`.
- **Tokens:** `mintRepoToken(installationId, repo, permissions)`, narrowed to one repo and the permissions the step needs (ADR 0030 as amended: clone and push, the PR, and the member lookup are separate scopes).
- **Files:** `readFiles(repo, ref, paths)` and a tree listing, for detection (ticket 32).
- **PRs:** `getPullRequestTemplate(repo)` (the usual locations), `getBotIdentity()` (the `<slug>[bot]` name and its noreply email from the bot user's ID), `findPullRequest(repo, head)` and `openPullRequest({ repo, head, base, title, body })`, idempotent by `findPullRequest` first.
- Every request sets a `User-Agent`. Vendor answers parsed with loose schemas.
- **Capabilities:** `checkRuns` true, `prTemplates` true, `lfsActionHosts` exactly `github-cloud.githubusercontent.com`, `github-cloud.s3.amazonaws.com` and `lfs.github.com` (Q119).
- A fake GitHub (in this package's tests) that refuses a request with no `User-Agent`, and the code host contract suite against it. Live cases against `ostra-test/test1`, gated on `github.env` and `github-test.env`, cleaning up any branch they make.

## Port from

`spikes/github-app-and-git-proxy/src/github/` (`app-auth.ts`, `manifest.ts`, `pr-flow.ts`, `errors.ts`).

## Done when

- [ ] The contract suite passes against the fake.
- [ ] Gated live run: `readApp` for App 5821041 shows `checks: write` and `actions: read`; a token minted for `test1` can't read `test2`; a PR opened on a test branch is found again by `findPullRequest`, then closed and its branch deleted.
- [ ] No token, PEM or secret appears in a log line or an error message (a test checks the error path).
- [ ] Package checks and `pnpm check:licenses` pass.
- [ ] Committed as `✨ add the GitHub code host adapter`.

## Comments
