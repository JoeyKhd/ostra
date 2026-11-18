# 39: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead), with each builder on call for their part
Blocked by: 22, 27, 28, 29, 37, 38
Features: every F-ID in the spec's section 2
Packages: `e2e/m1-first-pr/` (new), `context/features.md`, this spec's `## Comments`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m1-first-pr/`:** a script that runs section 3 against a fresh dev stack and the test org: it reads the secrets from the environment (loaded from `~/.config/ostra-dev/`), drives the panel with Playwright for the first admin, the provider, the App, the project and the device approval, starts `pnpm ostra runner`, types the prompt, waits for the PR, and then runs the checks after the run. It never prints a secret, and it cleans up its PRs, branches and hidden refs in `test1` only.
- **The run, by hand as well,** in a real browser, once, following section 3 step by step, with what was seen written under `## Comments` (times, the PR's URL, anything that surprised).
- **The ledger:** in the same commit, set each row of section 2 to the status its "At M1's end" column says, if and only if every condition in its "done when" holds. Rows that wait for Linux stay `building` (F-017 stays `planned`), each with a short dated note naming what's left.

## Done when

- [ ] `pnpm e2e:m1` passes on this machine from a fresh clone, twice in a row.
- [ ] A PR on `ostra-test/test1` was opened by the App, with the admin as co-author, from a typed prompt, and the run is recorded under `## Comments`.
- [ ] Every check after the run passes: no credential reached the agent, the git proxy refused `main` and another repo, the empty task opened no PR, the stopped task left its branch and hidden ref, the tokens were counted.
- [ ] What waits for the Linux machine is listed here and in the ledger notes.
- [ ] All the checks for the whole repo pass.
- [ ] Committed as `✅ add the milestone 1 end-to-end demo`, and the ledger change as `📝 set milestone 1's ledger statuses`.

## Comments
