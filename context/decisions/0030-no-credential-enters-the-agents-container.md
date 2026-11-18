# No credential enters the agent's container: the sidecar, the key proxy and the git proxy

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0014. Settles Q17, Q26, Q27, Q41 and Q47.

No model key and no GitHub token is ever in the agent's container. They live in the box's sidecar (ADR 0029), and the agent reaches models and GitHub only through two proxies there (Q17).

**Where the real credentials live.**
- On the server, encrypted, through the built-in `SecretStoreAdapter`.
- They reach the sidecar per task over the runner protocol, tied to the task and its lease epoch.
- The sidecar keeps them in memory only. They're never in an environment variable, an argument or a file, the sidecar's own included (`research/credential-proxy.md`, "Interactions with OS users"). They're never logged.

**The key proxy** (Q26).
- The agent gets a base URL that points at the sidecar, and a fake key that is valid for one task. The fake key has at least 128 random bits and an expiry, and it's revoked when the session ends.
- The proxy checks the fake key, strips every client credential header, sets the real one, and opens its own TLS connection to the model provider.
- It passes the stream through byte for byte: no buffering, headers and body fields forwarded unchanged, keep-alive events kept, error bodies returned as received (`research/credential-proxy.md` §1).
- It handles both API formats the provider form offers (ADR 0033).
- It counts the tokens of each call from the usage fields in the stream, and logs IDs and counts only. Budgets and the spend cap per task rest on this count (Q105, ADR 0042).
- It reports the provider's rate-limit answers, so the scheduler holds new dispatches until the retry time (Q20). It fails the task at once on an upstream 401 or 403.
- It needs no certificate authority and no TLS interception.
- The agent's environment is built from an allowlist, never inherited.

**The git proxy** (Q26, Q41).
- The agent's own `git` fetches and pushes through the sidecar, by a `url.<sidecar>.insteadOf` rule. `GITHUB_TOKEN` and `GH_TOKEN` are never in the agent's environment.
- The proxy adds a token for one repo, which the server mints from the organization's GitHub App.
- It reads the command list of each `git-receive-pack` request. It refuses any ref except the task's branches and its hidden ref (ADR 0039), and any delete, before a byte reaches GitHub (`research/credential-proxy.md` §14).
- On refine and review tasks it accepts fetches only (Q66, Q71).
- The agent may commit. After every turn, the box commits what's left and pushes the task's branches. Commits are authored by the GitHub App's bot identity, with a `Co-authored-by` trailer for the member whose prompt led to them (Q55, ADR 0040).

**ostra's MCP tools** also run in the sidecar, with a token for that one task. No ostra credential enters the agent's container either (round 13, problem 3).

**The boundary on each executor** (Q27).
- **`docker` and `kubernetes`:** a container. The sidecar holds the credentials and the agent's container never does. The agent may install packages in its own container without reaching a key.
- **`host` in a pool:** there's no box. The runner process does the sidecar's work, and the agent runs as a separate OS user from it.
- **A personal runner:** one user. The key proxy still keeps the key out of the agent's environment and files, but the member controls the machine and can read the key.

**Keys everywhere** (Q47). Every runner, a member's own laptop included, runs on model provider keys through the key proxy. No subscription login is used, stored or passed on anywhere. An organization's provider is usable on personal runners only when an admin switches that on for the provider. It's off by default.

**Accepted limits.**
- The agent can use its fake key while the task runs, but only through the proxy, only for model calls, and only until it's revoked. That allows spend, not theft, and the spend cap per task limits it.
- An environment's own variables and secrets stay visible to the code under test (`research/credential-proxy.md`, "Per-repo test secrets"). The panel says environments are for dev and test credentials (F-050). The docs recommend throwaway resources per task, such as a database with a random password.

## Considered options

- **Keys as environment variables of the agent** (ADR 0014). Rejected: the agent runs untrusted input with a shell, so anything in its environment can leak, through an install script that harvests variables or a prompt-injected `env | curl`.
- **A loopback key proxy inside the runner, the runner doing every fetch and push, and the agent as a different OS user** (Q26 and Q27 as first written, `research/credential-proxy.md`'s recommendation). Rejected for `docker` and `kubernetes`: with a box per task, a container boundary is available and stronger than Unix users. And a runner that runs `git push` on a workspace the agent controls runs the agent's hooks and config beside the token. The separate OS user stays the rule for `host` pools, and the whole design is spike 3's fallback.
- **A push from the sidecar's own clean clone.** Kept as spike 4's fallback, if LFS or large packs break through the proxy.
- **A central model gateway on the server.** Rejected: by the research's own estimate, about 35 MB/s each way through the server at 1,000 tasks, and a single point of failure (`research/credential-proxy.md` §1).
- **An off-the-shelf gateway, such as LiteLLM.** Rejected: a Python dependency holding every organization's keys, and supply-chain compromised twice in 2026 (`research/credential-proxy.md` §16).
- **Placeholder secrets swapped by a TLS-intercepting proxy.** Later, as an environment option. It needs a certificate authority per task and breaks clients that sign requests.
- **A member's subscription login on their own laptop** (ADR 0005, ADR 0014). Rejected: the maintainer chose keys, and the terms forbid a platform from routing subscription logins (`research/agent-harnesses.md` §1.4).

## Consequences

- ADR 0020's gap, that a GitHub token can't be limited to one branch, is closed: the git proxy enforces the task's refs. So refusing an unprotected default branch becomes a warning (F-060, ADR 0031).
- Adapter parity: an agent adapter must take a model base URL and a placeholder key, and declares that as a capability. OpenCode (F-019, v1) does. Claude Code, the second agent in milestone 7 (F-018), does through its gateway settings, on an endpoint that speaks Anthropic's Messages API, which the key proxy supports.
- Budgets are only as good as the count. An endpoint that reports no usage gets an estimate from token counts, and the panel says so.
- A laptop runner on an organization's provider holds a real key on a machine its owner controls. That's why an admin turns it on per provider.
- Spike 1 checks that the agent's environment holds only the fake key, and that the proxy's count is within 2% of what the endpoint reports. Spike 3 checks that no key or token can be read from a shell in the agent's container, through the environment, the process list, files or the network. Spike 4 checks that the git proxy refuses a push to the default branch, a delete and a push to another repo, and records how LFS, a shallow clone and a 500 MB pack behave.
- Short-lived provider credentials come later, as an auth strategy of the `ModelProviderAdapter` (F-130).
- Ledger rows: F-014, F-089 and F-090.
