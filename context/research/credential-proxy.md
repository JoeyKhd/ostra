# Research: credential-injecting and egress-controlling proxies for agent processes

**Question:** How can the runner keep long-lived keys away from the agent (proposed Q17)? That covers four things: model keys added by a local proxy, GitHub tokens that never sit in the agent's environment, per-environment egress allowlists (F-052, later), and what to do about per-repo test secrets. Which existing tools fit a TypeScript, Apache-2.0 runner on Windows, macOS and Linux, at 1,000 concurrent tasks per install?
**Checked:** 2026-11-18. Versions are in [Versions checked](#versions-checked). Anything I could not confirm from a primary source (official docs, README, source, package registry) is marked **unverified**. Secondary sources (vendor blogs, articles) are labelled.

---

## Summary

- **Model keys need no TLS interception.** Claude Code has a documented gateway mode: `ANTHROPIC_BASE_URL` plus a credential the gateway issues ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). The runner can serve that gateway itself on loopback:
  - Claude Code gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and a per-task **phantom token** in `ANTHROPIC_API_KEY`.
  - The runner's proxy checks the token, swaps in the real credential, and opens its own TLS connection to the provider.
  - No CA certificate, no MITM, and it behaves the same on every OS.
  - Cloudflare's official Claude Code sandbox guide uses the same trick: a placeholder key, "because Claude Code does not start without an API key" ([Cloudflare](https://developers.cloudflare.com/sandbox/coding-agents/claude-code)).
- **Claude Code works through such a proxy.** Streaming, prompt caching and tools all hold, as long as the proxy is a byte-for-byte pass-through. It must not buffer, must forward `anthropic-*` headers and body fields unchanged, must keep SSE `ping`s, and must return error bodies unmodified ([gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)). A few defaults change with a custom base URL: fine-grained tool streaming, the background model, fast mode, WebFetch's preflight and the first-byte watchdog. Each has an environment-variable fix ([What breaks](#what-changes-or-breaks-with-a-custom-base-url)).
- **Subscriptions on laptops:** ostra must not put its proxy in front of a claude.ai login. With `ANTHROPIC_BASE_URL` set and no gateway credential, the subscription's OAuth token travels through the proxy ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). That is "intermediate Claude.ai credentials or session tokens", which the terms forbid ([legal](https://code.claude.com/docs/en/legal-and-compliance)). So on a subscription laptop: no base-URL override, no TLS termination of Anthropic hosts, no changing `CLAUDE_CONFIG_DIR`.
- **GitHub:** the simplest v1 that meets the goal is that the agent never gets a GitHub credential at all.
  - The runner runs every `fetch` and `push` itself, with an in-memory credential helper on its own git commands (already suggested in `research/platform-auth-github.md` §2.4).
  - The next step is a loopback **git smart-HTTP proxy**: `url.insteadOf` points the remote at the runner, and the runner adds `Authorization` and filters the ref list of each `git-receive-pack` request ([gitprotocol-http](https://git-scm.com/docs/gitprotocol-http)). That closes the "GitHub tokens can't be limited to one branch" gap from ADR 0020, still without MITM.
- **Egress allowlists (F-052)** are a different job, and only an OS-level jail makes them real. Without one, a process that ignores `HTTPS_PROXY` simply goes direct. Ranked for ostra:
  1. **`@anthropic-ai/sandbox-runtime`**: Apache-2.0, TypeScript, macOS Seatbelt, Linux bubblewrap, Windows alpha. It is a library and also a standalone `srt-proxy` with an external decider.
  2. Per-task containers on an `--internal` Docker network with a proxy sidecar.
  3. Cilium `toFQDNs` on Kubernetes.

  Most of the other candidates are Linux-only (Coder `boundary`, httpjail strong mode, iron-proxy enforcement), need Python (mitmproxy), or are GPL (Squid).
- **New in 2026:** placeholder-and-swap credential injection is now the industry pattern. It appears in:
  - Claude Managed Agents vaults ([vaults](https://platform.claude.com/docs/en/managed-agents/vaults))
  - Claude Code's own `sandbox.credentials` `mask` mode ([sandboxing](https://code.claude.com/docs/en/sandboxing))
  - Vercel Sandbox header `transform` (2026-02-23)
  - Docker Sandboxes ([credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials))
  - iron-proxy (open-sourced 2026-04-01)
  - Omnara PR #848 (2026-11-17)

  Separately, Anthropic **Workload Identity Federation** lets the ostra server mint short-lived Anthropic tokens: 60 s to 24 h, from an OIDC JWT ([WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)). With it, runners would hold no long-lived Anthropic key at all, which matches ADR 0012.
- **Per-repo `.env` test secrets (point 4):** confirm this as an accepted limit for v1. A secret the code under test uses *locally* cannot be hidden from code the agent writes. Placeholder swapping helps only for secrets sent verbatim to a known HTTPS host, and needs MITM ([details](#4-per-repo-test-secrets)).
- **Recommendation:**
  - Build a small loopback model proxy and a runner-side push into the runner for v1. No new dependency is needed for the Anthropic API.
  - Run the agent under a different OS user from the runner on remote runners.
  - Plan F-052 on `sandbox-runtime`.
- **Biggest risk:** on laptops and in v1's shared runner container, the agent runs as the same OS user as the runner. Phantom tokens defeat env/file harvesting (the common attack), but not a targeted read of the runner's process. The real boundary needs OS-user separation or per-task containers. See [Unknowns / spike](#unknowns--spike).

---

## Versions checked

| Component | Version (date) | License | Source |
|---|---|---|---|
| Claude Code | 2.1.326 (2026-11-16), per `research/agent-harnesses.md` | Proprietary | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-code) |
| `@anthropic-ai/sandbox-runtime` (srt) | 0.0.83 (2026-11-13); first published 2025-10-20; 79 versions; ~7.2k stars | Apache-2.0 | npm registry; [repo](https://github.com/anthropics/sandbox-runtime) |
| httpjail (Coder) | 0.6.2 (2026-09-24); created 2025-09-10; ~964 stars | CC0-1.0 | crates.io API; [repo](https://github.com/coder/httpjail) |
| boundary (Coder Agent Firewall CLI) | no GitHub releases; 228 commits; 25 stars | MIT | [repo](https://github.com/coder/boundary) LICENSE |
| Smokescreen (Stripe) | v1 tags `v0.x`; v2 on `master`, untagged; ~1.4k stars | MIT | [repo](https://github.com/stripe/smokescreen) |
| Envoy | 1.40.2 (2026-10-27, Docker Hub) | Apache-2.0 | [docs](https://www.envoyproxy.io/docs/envoy/latest/) |
| mitmproxy | 12.3.1 (2026-10-25) | MIT | PyPI |
| Squid | 7.8 (2026-10-30) | GPL-2.0-or-later | [versions](https://www.squid-cache.org/Versions/), COPYING |
| iron-proxy | 0.56.0 (2026-11-04); first image 2026-03-31; ~82k pulls; ~873 stars | Apache-2.0 | Docker Hub; [repo](https://github.com/paradigmxyz/iron-proxy) LICENSE |

---

## Comparison

"No-MITM injection" means the tool can add an auth header to HTTPS traffic without a CA the client must trust. In practice that means a base-URL redirect: the client speaks plain HTTP to loopback, and the proxy makes the TLS hop.

| | License | Win / mac / Linux | No-MITM injection | Per-task scoping | Allowlist | Audit log | Embed in TS runner | Perf. | Maturity |
|---|---|---|---|---|---|---|---|---|---|
| **Own loopback proxy in the runner** | ours (Apache-2.0) | ✅ / ✅ / ✅ | ✅ base-URL | Phantom token per task | Paths only (not egress) | Whatever we log | Native (`node:http`) | Adds one local hop (**unverified**: measure) | To build; ~a few hundred lines |
| **sandbox-runtime (srt)** | Apache-2.0 | alpha / ✅ / ✅ (bwrap, socat) | ❌ needs `tlsTerminate` | One config per process; per-command lists are "attribution, not a boundary" | ✅ domains, ports, resolved-IP checks | Violation store; `srt-proxy` decider sees every request | ✅ npm library | Node; 256-tunnel default cap | Research preview, 0.0.x, weekly releases |
| **Claude Code sandbox** (`sandbox.*`) | proprietary (part of CC) | ❌ native Win / ✅ / ✅ | ❌ `mask` needs `tlsTerminate` | Per session via `--settings` | ✅ | Not documented | Config only | n/a | Shipped; `tlsTerminate` experimental |
| **httpjail** | CC0 | ❌ / weak (env only) / ✅ strong | ❌ no injection at all | Per jailed process | ✅ JS/shell/line-processor rules | `--request-log` lines | Separate Rust binary | Rust | "experimental, no API or CLI compatibility guarantees" |
| **Coder Agent Firewall / boundary** | MIT CLI; streaming to the control plane is Coder Premium | ❌ / ❌ / ✅ | ❌ no injection | Per jailed process | ✅ domain, method, path | Structured; streams to coderd | Go binary, Linux only | Go | Launched Dec 2025 |
| **Smokescreen** | MIT | builds anywhere; built for Linux servers | ❌ v2 `mitm.add_headers` | Per client role (mTLS CN or custom `RoleFromRequest`) | ✅ per-role ACL, public-IP-only by default | `slog` JSON, Prometheus | Go binary or library | Go; carries most Stripe egress | v1 mature; v2 untagged |
| **Envoy** | Apache-2.0 | not listed / ✅ / ✅ | ✅ reverse-proxy route plus `credential_injector` | Route, header or `ext_authz` | ✅ (RBAC, dynamic forward proxy) | Rich access logs | Separate C++ daemon, YAML | Top tier | CNCF-graduated core |
| **mitmproxy** | MIT | ✅ / ✅ / ✅ (incl. per-process "local capture") | ✅ `--mode reverse:` plus addon | Per process (local mode) or addon logic | Via addon script | Flow dumps | Needs Python ≥ 3.12 | Python; slowest here (**unverified**) | Mature (12.x) |
| **Squid** | GPL-2.0+ | third-party / ✅ / ✅ | ✅ in reverse (accel) mode; forward HTTPS needs `ssl_bump` | `proxy_auth` and src ACLs | ✅ `dstdomain` ACLs | `access.log` | Separate daemon; GPL | C++, high | Decades |
| **iron-proxy** | Apache-2.0 | ❌ / ✅ binary / ✅ (enforcement via DNS, nftables, TPROXY) | ❌ MITM by design | Proxy token per secret, `hosts`, `require` | ✅ default-deny, upstream IP deny list | Per-request JSON plus OTel | Go sidecar | Go (no benchmarks found) | 0.56, 7 months old |
| **Managed Agents vaults** | hosted (Anthropic) | n/a | Anthropic-side proxy | Per session (`vault_ids`) | Host allowlist in environment | Hosted | Not embeddable; pattern only | n/a | GA self-hosted sandboxes, May–June 2026 (secondary) |
| **Sandbox-provider injection** (Vercel, E2B, Modal, Blaxel, Daytona, Docker `sbx`) | vendor | vendor | Mostly per-sandbox CA (MITM) | Per sandbox | ✅ | Vendor | Through the provider API | n/a | 2026 features |
| **git credential helper / git proxy** | git (GPL-2.0, external) | ✅ / ✅ / ✅ | ✅ helper: no proxy; proxy: `insteadOf` | Per git command or task | Repo and ref filter (proxy) | Ours | Native | n/a | Helper protocol stable |
| **Docker / K8s egress policy** | Apache-2.0 | Linux hosts | ❌ no injection | Per container or pod | Docker: all-or-nothing `--internal`; K8s: CIDR, or FQDN with Cilium | CNI (Hubble) | Config | Kernel | Mature |

---

## 1. Building it into the runner: a loopback model proxy (base-URL redirect)

**How Claude Code is pointed at it** ([connect to a gateway](https://code.claude.com/docs/en/llm-gateway-connect), [env vars](https://code.claude.com/docs/en/env-vars)):
- `ANTHROPIC_BASE_URL` sets the endpoint. Inference posts to `/v1/messages?beta=true`; `/v1/messages/count_tokens` is optional. Startup sends a `HEAD /api/hello` probe that the gateway may reject ([protocol](https://code.claude.com/docs/en/llm-gateway-protocol)).
- `ANTHROPIC_API_KEY` goes in `x-api-key`. `ANTHROPIC_AUTH_TOKEN` goes in `Authorization: Bearer`. `apiKeyHelper` output goes in both.
  - "In non-interactive mode (`-p`), the key is always used when present."
  - Precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > profiles and WIF > `/login` ([authentication](https://code.claude.com/docs/en/authentication)).
- Anthropic's own description of a gateway: "the provider key stays server-side; developers hold gateway credentials instead" ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). The phantom token is exactly that "gateway credential", scoped to one task.
- Bedrock, Vertex and Foundry through a gateway use their own variables:
  - Bedrock: `ANTHROPIC_BEDROCK_BASE_URL` with `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`.
  - Vertex: `ANTHROPIC_VERTEX_BASE_URL` with `CLAUDE_CODE_SKIP_VERTEX_AUTH=1`.
  - Foundry: `CLAUDE_CODE_SKIP_FOUNDRY_AUTH=1`.

  Claude Code then sends unsigned requests and the gateway "holds those" credentials ([connect](https://code.claude.com/docs/en/llm-gateway-connect#route-to-a-cloud-provider-through-a-gateway)). For Bedrock the proxy must SigV4-sign each body, or send a Bedrock API key as a bearer token. For Vertex it must add an OAuth access token. Both need provider libraries: **ask before adding**.
- Plain `http://` on loopback: widely used with LiteLLM (`ANTHROPIC_BASE_URL=http://localhost:4000`, secondary: [claude-mem docs](https://docs.claude-mem.ai/configuration/litellm-gateway), [LiteLLM](https://docs.litellm.ai/docs/proxy/client_setup/claude_code)). Not stated in Anthropic's docs: **unverified**, spike it. A Unix-socket base URL is **unverified**, probably unsupported.

**What the proxy must do to stay transparent** ([protocol](https://code.claude.com/docs/en/llm-gateway-protocol)):
- Forward `anthropic-version`, `anthropic-beta` and all body fields unchanged, "as open lists, not closed ones". A gateway that rewrites bodies "breaks the pairing" of beta headers and fields, and breaks preserved-thinking signatures.
- Don't buffer: "If your gateway buffers a response until it is complete, Claude Code stalls." Pass SSE `ping` events, or Claude Code's 300 s byte watchdog fires during long thinking ([network config](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs)).
- Return error bodies unmodified. Claude Code's automatic retries (thinking type, effort, `context_management`, tool search, …) match on the upstream's wording.
- Return `retry-after` (integer), `x-should-retry` and `anthropic-ratelimit-unified-*` as received. This also gives ostra rate-limit data for Q20.
- Prompt caching needs `cache_control` forwarded unchanged. The system-prompt attribution block is stable for a custom base URL from v2.1.181, and `api.anthropic.com` strips it when it arrives unchanged as the first system block, so caching is unaffected.
- Strip every client credential header (`x-api-key`, `authorization`) before setting the real one. Cloudflare's guide warns that a leftover placeholder `x-api-key` is forwarded and fails with "Invalid API key" ([Cloudflare](https://developers.cloudflare.com/sandbox/coding-agents/claude-code)).

**Useful for ostra.** Claude Code always sends `x-claude-code-session-id`, plus subagent IDs. `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` adds request class, compaction and prompt ID ([protocol](https://code.claude.com/docs/en/llm-gateway-protocol#gateway-hint-headers)). The proxy can count tokens per task by reading the `usage` in `message_start` and `message_delta` from a tee of the stream. It logs IDs and counts only, never content (AGENTS.md logging rule).

**Scale.** One proxy per runner serves all of that runner's tasks. 1,000 concurrent tasks spread over many runners put no hot path on the server. A central gateway on the ostra server is the alternative that keeps keys off runners entirely. Its cost, by my own arithmetic (**unverified**): each turn resends the whole context (roughly 0.5 MB at 150k tokens), so 1,000 tasks at one request per 15 s is about 35 MB/s through the server each way, and the server becomes a single point of failure. Short-lived upstream credentials ([§13](#13-anthropic-workload-identity-federation-a-credential-source-not-a-proxy)) get most of the benefit without that.

**Where it is weak.** The phantom token is itself usable by the agent while the task runs, but only through the loopback proxy, only for model calls, and only until revocation. That allows spend, not theft of the key. A budget per token caps it. The real key sits in the runner's memory, so who can read the runner process matters ([Interactions](#interactions-with-os-users-and-the-runner-process)).

### What changes or breaks with a custom base URL

| Change | Source | Fix in the task environment |
|---|---|---|
| Fine-grained tool streaming is off by default behind a custom base URL, so big `Write` inputs arrive at once and look like a hang | [env vars](https://code.claude.com/docs/en/env-vars) | `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` |
| Background tasks (titles, summaries) use the **main** model unless an Anthropic Console-format key is present or `ANTHROPIC_DEFAULT_HAIKU_MODEL` is pinned: a cost leak | [protocol](https://code.claude.com/docs/en/llm-gateway-protocol#requests-and-defaults-by-connection-method) | Pin `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| Fast mode: the availability check goes **directly** to `api.anthropic.com`, not the base URL, and with a non-Anthropic-format key it isn't sent, so fast mode reads as unavailable | [fast mode](https://code.claude.com/docs/en/fast-mode#use-fast-mode-behind-proxies-and-llm-gateways) | `CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS=1` (or `_ORG_CHECK=1`), only if profiles allow fast mode |
| WebFetch sends each hostname to `api.anthropic.com` for a safety check, whatever the provider | [data usage](https://code.claude.com/docs/en/data-usage#webfetch-domain-safety-check) | Allow that host, or `skipWebFetchPreflight: true` plus WebFetch permission rules |
| The first-byte deadline doesn't run on a custom base URL; only the 300 s byte watchdog does, so a dead upstream is noticed later | [network config](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs) | `API_TIMEOUT_MS`; the proxy can fail fast itself |
| A rejected credential is retried about 10 times (~3 min) before the task fails with 401 | [Cloudflare](https://developers.cloudflare.com/sandbox/coding-agents/claude-code) (vendor doc) | The proxy reports upstream 401/403 to the runner, which fails the task at once |
| Remote Control is disabled with a non-Anthropic base URL; `/feedback` writes locally | [env vars](https://code.claude.com/docs/en/env-vars), [connect](https://code.claude.com/docs/en/llm-gateway-connect) | Not needed by ostra |
| Nonessential traffic (updates, telemetry, release notes) still goes outside the gateway | [connect](https://code.claude.com/docs/en/llm-gateway-connect#turn-off-traffic-outside-the-gateway-path) | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (also stops auto-update, which the runner image should own) |
| HIPAA configuration isn't available through a gateway | [protocol](https://code.claude.com/docs/en/llm-gateway-protocol) | Document it |

---

## 2. Anthropic `@anthropic-ai/sandbox-runtime` (srt)

Sources: npm README for 0.0.83, plus the repo README and `docs/srt-proxy.md` ([repo](https://github.com/anthropics/sandbox-runtime)).

- **What it is.** "A lightweight sandboxing tool for enforcing filesystem and network restrictions on arbitrary processes at the OS level, without requiring a container." It is a "Beta Research Preview … APIs and configuration formats may evolve". Claude Code's sandbox is built on it ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- **Platforms:**
  - **macOS:** `sandbox-exec` with a generated Seatbelt profile. The only allowed network target is the proxy's localhost port.
  - **Linux:** bubblewrap. The network namespace is removed, and the proxies are reached over bind-mounted Unix sockets via `socat`. It needs `bwrap`, `socat` and `rg`.
    - Ubuntu 24.04+ needs `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile.
    - As root it needs `CAP_SETFCAP`.
    - In unprivileged Docker it needs `enableWeakerNestedSandbox`, which "considerably weakens security".
  - **Windows (alpha):** commands run as a dedicated `srt-sandbox` user, with a WFP egress fence, a write-restricted token and NTFS ACEs. Setup needs one elevated `windows-install`. Its own known limitations:
    - A process that impersonates the anonymous token, or a deny-only copy of its own token, before creating a socket "is not fenced". The README says to "treat the network filter as stopping commands that connect directly, not code written to defeat it".
    - SMB and WSL traffic escape.
    - Schannel clients can't do TLS.
    - The proxy auth token is visible on the runner process's command line.
- **Network model.**
  - Allow-only: an empty list means no network.
  - `deniedDomains` win over `allowedDomains`.
  - Ports can be given per entry.
  - A resolved-address check refuses loopback, link-local, metadata and the host's own addresses for allowed names.
  - An ask callback handles undecided hosts.
  - `--control-fd` takes live policy updates.
- **Credential injection.**
  - `credentials.envVars` and `credentials.files` with `mode: "mask"` put a sentinel inside the sandbox, and the proxy substitutes the real value on egress to `injectHosts`.
  - "Masking requires `network.tlsTerminate`", which means an in-process MITM: an ephemeral or given CA is put in the sandbox's trust bundle through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO` and others.
  - `credentials.sigv4` re-signs AWS requests.
  - Files are masked on Linux only; macOS and Windows deny them instead.
  - Library users get `filterRequest` with `setHeaders` and `removeHeaders`. Header sets on plaintext requests are refused unless `allowPlaintextHeaderSet` is on.
- **`srt-proxy`.** A standalone proxy for "a host that runs the workload elsewhere (a VM, a container, another sandbox)".
  - Every request is decided by an external **decider** over a framed JSON protocol. An allow can carry `cred` and `credential`; the proxy removes all client credential headers first, then sets `Authorization: Bearer` or a configured scheme.
  - It fails closed (5 s verdict timeout), dials nothing before a verdict, refuses opaque tunnels, pins Host and SNI, and drops private ranges.
  - A single-file Bun or Node build exists.
  - This is the closest thing to an off-the-shelf, Apache-2.0, TypeScript "egress plus credential" proxy that ostra could embed.
- **Per-task scoping.**
  - `SandboxManager` is initialised once per process with one config.
  - Per-command allow lists exist, but the README calls them "attribution, not a boundary between concurrent commands of one session", because the id travels as a proxy username the sandboxed client presents.
  - Concurrent tasks with different policies need separate `srt` processes, or one `srt-proxy` per task.
  - The TLS termination default is `maxTunnels: 256`. Under Bun, uploads to a stalled upstream buffer without bound, so the README recommends Node.
- **Audit.** It records violations (denies). Allowed traffic is visible through `filterRequest`, `onResponse` or the decider, so ostra would write the log itself.
- **Fit for ostra.**
  - Best candidate for F-052: same license, TypeScript, embeddable, Anthropic-maintained, cross-platform.
  - Weak spots: Windows is alpha with documented bypasses, the API churns (0.0.x), and Linux system packages are needed.
  - Not needed for the model key itself, because §1 avoids MITM.
  - Wrapping the *whole* Claude Code process changes networking on Linux: inside bubblewrap, "localhost" is private. So `ANTHROPIC_BASE_URL=http://127.0.0.1:…` would not reach a host-side proxy. Spike it.

## 3. Claude Code's own sandbox and network settings

([sandboxing](https://code.claude.com/docs/en/sandboxing), [network config](https://code.claude.com/docs/en/network-config), [env vars](https://code.claude.com/docs/en/env-vars))

- **Scope.** The sandbox wraps **Bash commands only**. File tools (Read, Edit, Write), WebFetch, hooks, MCP servers, LSP and `apiKeyHelper` "run outside it". The Claude Code process's own API calls are not sandboxed either. It is off by default (`sandbox.enabled`). Native Windows "runs commands unsandboxed"; WSL2 works.
- **Network:**
  - A host-side proxy checks hostnames against `sandbox.network.allowedDomains` and `deniedDomains`; `strictAllowlist` denies instead of prompting.
  - UDP, QUIC and ICMP can't leave. Tools that ignore proxy variables (plain `ssh`, most DB drivers) fail.
  - `httpProxyPort` and `socksProxyPort` hand filtering to *your* proxy, and then "Claude Code's own network controls … stop applying to that traffic".
  - The default proxy "does not terminate or inspect TLS".
- **Credentials:**
  - `sandbox.credentials.envVars` and `files` with `deny` unset or deny-read.
  - `mask` uses a sentinel plus substitution at the proxy to `injectHosts`, and needs the experimental `network.tlsTerminate`.
  - `mask`, `tlsTerminate` and `sigv4` are honoured only from user, managed or `--settings`, never from the repo's `.claude/settings.json`, so a cloned repo can't redirect credentials.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`:**
  - Strips credentials from Bash, hook and MCP subprocess environments, by name or value shape.
  - Keeps `GITHUB_TOKEN`, `GH_TOKEN` and proxy URLs "so that `gh` … keep working".
  - On Linux it runs Bash in a separate PID namespace so it "can't read host process environments through `/proc`".
  - The Claude Code process keeps the credential.
- **Other relevant knobs:**
  - `HTTPS_PROXY` and `NO_PROXY` are honoured. SOCKS is not supported.
  - CA trust is bundled plus the OS store; `NODE_EXTRA_CA_CERTS` and `CLAUDE_CODE_CERT_STORE` adjust it.
  - mTLS client certificates work.
  - `CLAUDE_CODE_SHELL_PREFIX` wraps every Bash, hook and MCP command, as a hook point for logging or jailing.
  - `CLAUDE_CODE_PROCESS_WRAPPER` is a launcher for Claude Code's own processes. It is ignored on Windows, and repo settings can't set it ([corporate launcher](https://code.claude.com/docs/en/corporate-launcher)).
  - `allowedProviders: ["customEndpoint"]` with a pinned `ANTHROPIC_BASE_URL` refuses sessions pointed anywhere else (managed settings, v2.1.285+).
  - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` makes Claude Code ignore provider and endpoint variables in settings files, so a repo can't re-route a host-managed session.
- **Fit.** A cheap per-task defence-in-depth layer: ostra already sets permissions per profile through `--settings` (ADR 0020 #5). But it is Claude-specific, so for adapter parity it must be a declared optional capability. F-052 itself belongs at runner level (§2, §14).

## 4. Coder `httpjail`

([README](https://github.com/coder/httpjail), [platform support](https://coder.github.io/httpjail/guide/platform-support.html), [line processor](https://coder.github.io/httpjail/guide/rule-engines/line-processor.html))

- **What it is.** CC0, Rust, "experimental and offers no API or CLI compatibility guarantees". It monitors and restricts HTTP(S) from a process: transparent TLS interception with its own CA, DNS-exfiltration protection, and JS, shell or line-processor rules.
- **Platforms:**
  - **Linux strong mode:** network namespace plus nftables, seccomp for Unix sockets. Needs `sudo` from a non-root user.
  - **macOS:** "always runs in weak mode", using environment variables only, because "PF can't match on user or group".
  - **Windows:** "not yet implemented".
- **Injection: none.** Rule results are only `allow`, `deny_message` and `max_tx_bytes`.
- **Audit:** `--request-log` writes `<timestamp> <+/-> <METHOD> <URL>`. Logs include full URLs and query strings.
- **Fit:** allowlist and inspection only, Linux only in practice. Not a fit for credentials. Deno Sandbox credits it as the model for its outbound proxy ([Deno](https://deno.com/blog/introducing-deno-sandbox), vendor blog).

## 5. Coder Agent Firewall (formerly "Agent Boundaries") and `boundary`

([docs](https://coder.com/docs/ai-coder/agent-firewall), [boundary README](https://github.com/coder/boundary), [launch post](https://coder.com/blog/launch-dec-2025-agent-boundaries))

- **What it is.** "A process-level firewall that restricts and audits what autonomous programs … can access". Rules match `domain=`, `method=` and `path=`. Jails are `nsjail` (default, escalates via `sudo`/`setpriv`) or `landjail`.
- **Audit.** Logs record allow and deny decisions. Inside Coder, they stream over a Unix socket to the workspace agent and on to coderd. "Part of AI Governance, which is included with a Premium license."
- **Platforms:** Linux only. macOS and Windows: "Not supported".
- **Injection:** none.
- **Fit:** a reference for rule syntax and audit shape. The `boundary` CLI is MIT, but it is Linux-only and has no credential feature.

## 6. Stripe Smokescreen

([README](https://github.com/stripe/smokescreen))

- **What it is.** An HTTP CONNECT proxy. Clients usually authenticate with mTLS, and the role comes from the certificate CN or a custom `RoleFromRequest`.
  - Per-role YAML ACLs: `open`, `report` or `enforce`.
  - It refuses non-public resolved IPs by default (an SSRF guard).
  - Logs are `slog` JSON; Prometheus metrics are optional.
  - MIT, Go.
- **Injection.** Only in v2, which is untagged and whose Go API "will change". A domain entry can carry `mitm: add_headers`, which means MITM.
- **Fit.** A proven egress ACL for Linux server fleets, with a good per-role model: one role per task, via proxy auth. But it is Go-only to embed and its injection is immature. Better as an idea source for remote runners than as a dependency.

## 7. Envoy

- **Credential injector filter.** `envoy.filters.http.credential_injector` "serves the purpose of injecting credentials into outgoing HTTP requests". It supports a Generic (static or SDS) Basic or Bearer credential and OAuth2 client credentials ([docs](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter)). Its stability status isn't stated on the page.
- **No-MITM operation.** As a reverse proxy (a listener on loopback that routes to `api.anthropic.com`), Envoy injects without MITM. The Hatchet cookbook names "Envoy with its `credential_injector` filter" and LiteLLM as production-grade sandbox credential proxies ([Hatchet](https://docs.hatchet.run/cookbooks/agent-sandbox-credentials), vendor doc).
- **Platforms.** Official installs are Linux (static binary, Docker) and macOS (Homebrew). Windows is not listed ([install](https://www.envoyproxy.io/docs/envoy/latest/start/install)).
- **Fit.** Excellent performance and access logs, but it is a large external daemon with YAML or xDS config. Too heavy for `npx ostra-runner` on laptops. It could serve a central gateway mode later.

## 8. mitmproxy

- **What it is.** MIT, Python ≥ 3.12. **Local capture mode** intercepts by process name or PID ("available on Windows, Linux, and macOS"). Reverse mode (`--mode reverse:https://…`) needs no client CA ([modes](https://docs.mitmproxy.org/stable/concepts/modes/)). Python addons can rewrite headers.
- **Precedent.** Onyx uses a mitmproxy-based egress gateway with ALLOW, ASK and DENY policies per action ([Onyx](https://onyx.app/insights/secure-agent-access-control), vendor blog).
- **Fit.** The only tool here with per-process capture on all three OSes. Valuable for spikes and debugging. Shipping a Python runtime inside a Node runner is a poor fit, and throughput at hundreds of streams is **unverified**.

## 9. Squid

- **What it is.** GPL-2.0-or-later, C++, current 7.8 (2026-10-30). `request_header_add` "adds header fields to outgoing HTTP requests", with fast ACLs ([docs](http://www.squid-cache.org/Doc/config/request_header_add/)). Forward HTTPS needs `ssl_bump` (MITM); whether the directive applies to bumped requests is **unverified**. `dstdomain` ACLs and `access.log` are standard.
- **Fit.** Mature and fast. But it is GPL, so it can't be embedded in the Apache-2.0 runner; it could only ship as a separate binary in the Docker image. Its config language is heavy. iron-proxy's own comparison says "Requires complex ACL config" ([docs.iron.sh](https://docs.iron.sh), vendor).

## 10. iron-proxy (new in 2026)

([README](https://github.com/paradigmxyz/iron-proxy), [docs](https://docs.iron.sh), [launch post](https://x.com/mslipper/status/2039422148654366764) 2026-04-01)

- **What it is.** Apache-2.0, Go. "A MITM egress proxy with a built-in DNS server": default-deny allowlists, an upstream IP deny list (metadata and loopback by default), per-request JSON audit and OTel export, SSE and WebSocket aware.
- **Secrets transform.** The workload holds proxy tokens. The proxy swaps them in headers (body, query and path are opt-in), with a `require` flag that rejects requests lacking the token. Sources include env, file, AWS Secrets Manager or SSM, Vault KV and 1Password. It mints OAuth, SigV4, HMAC and GCP tokens per request ([docs](https://docs.iron.sh)).
- **Other features.** A Postgres MITM listener with role pinning, and MCP policy and gateway.
- **Platforms.** Binaries for Linux and macOS, plus a Docker image. Enforcement relies on DNS, nftables or TPROXY on Linux.
- **Adoption.** Hermes Agent wires it into its Docker backend only ([Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy)).
- **Fit.** The most complete off-the-shelf "egress plus secrets plus audit" sidecar for **remote Docker runners**: same license family, active (0.56 in 7 months). Not embeddable in TypeScript, no Windows, and MITM is its only mode. Worth comparing with `srt-proxy` when F-052 starts.

## 11. Claude Managed Agents vault credentials (pattern)

- **How vaults work.** "Vaults store credentials; those credentials never enter the sandbox."
  - MCP calls go through an Anthropic-side proxy that adds the vault credential.
  - Git operations on attached repos go "through a git proxy that injects the `github_repository` resource's `authorization_token`".
  - `environment_variable` credentials sit "in the sandbox as an opaque placeholder … substituted with the real secret at egress" ([vaults](https://platform.claude.com/docs/en/managed-agents/vaults); [skills repo](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-tools.md)).
- **Stated limits.** "Clients that validate the credential format at startup might reject it, and clients that compute a request signature from the secret (for example, AWS SigV4) produce an invalid signature."
- **Self-hosted sandboxes.** "You can run your own proxy that replaces placeholder values with the real secrets at egress" ([vaults](https://platform.claude.com/docs/en/managed-agents/vaults)). Self-hosted Managed Agents (2026-11) keeps vault secrets outside the sandbox, but only for "MCP tools and supported API calls" ([Help Net Security](https://www.helpnetsecurity.com/2026/11/12/anthropic-self-hosted-claude-managed-agents), secondary).
- **Takeaway.** Anthropic's own split is the one ostra should copy: the agent loop and secrets outside, placeholders inside, and git through a credential-adding proxy. Claude Code on the web does the same: GitHub credentials "never enter the VM. GitHub traffic from the VM goes through an Anthropic proxy" ([data usage](https://code.claude.com/docs/en/data-usage#cloud-execution-data-flow-and-dependencies)).

## 12. Omnara and sandbox-provider proxies (pattern for elastic runners)

- **Omnara PR #848** ("inject machine daemon tokens through sandbox provider proxies", merged 2026-11-17) ([PR](https://github.com/omnara-ai/omnara/pull/848)):
  - "Sandboxes hold a placeholder; the provider's proxy injects the real daemon token."
  - On Blaxel, E2B and Modal, a proxy rule goes inline with the create request.
  - On Daytona and Superserve, it uses a per-machine provider secret that is deleted with the machine.
  - Omnara's docs say provider-side injection "doesn't work with self-hosted sandboxes yet" ([Omnara guide](https://www.omnara.com/guides/deploy-ai-agents-to-production), vendor).
- **Vercel Sandbox.** Network-policy `transform` headers, available since 2026-02-23 ([changelog](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox)). It works by "selectively terminate[ing] TLS using a certificate authority unique to the sandbox" ([Vercel blog](https://vercel.com/blog/a-sandbox-without-a-network-boundary-is-only-half-a-sandbox)).
- **Docker Sandboxes (`sbx`).** A host-side proxy overwrites auth headers. The agent sees a `proxy-managed` sentinel, and custom secrets get `sbx-cs-…` placeholders. The TLS mechanism isn't documented (**unverified**) ([Docker](https://docs.docker.com/ai/sandboxes/configuration/credentials)).
- **Others.** Blaxel (`network.proxy.routing` with `{{SECRET:name}}`) and sandboxd: secondary sources.
- **Watch out.** Some vendors offer to hold a Claude *subscription* OAuth token at their edge, for example Freestyle's "Inject a Claude Code OAuth Token at the Edge" ([Freestyle](https://www.freestyle.sh/docs/guides/run-claude-code-in-a-sandbox)). That looks like "collect, store, or intermediate Claude.ai credentials or session tokens" ([legal](https://code.claude.com/docs/en/legal-and-compliance)). ostra must not copy it.
- **Takeaway.** For elastic runners (Q8), ostra's runner inside the sandbox can keep using its loopback proxy. The *runner's own* token to the ostra server can instead use the provider's injection, as Omnara does.

## 13. Anthropic Workload Identity Federation (a credential source, not a proxy)

([WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation))

- **What it is.** A workload presents an OIDC JWT. `POST /v1/oauth/token` (RFC 7523 `jwt-bearer`) returns an `sk-ant-oat01-…` token for a service account, sent as `Authorization: Bearer`.
- **Lifetime.** "The lesser of" the rule's `token_lifetime_seconds` (60 to 86,400, default 3,600) "and twice the remaining lifetime of the IdP JWT". `jti` is single-use by default.
- **Issuers.** "Any standards-compliant OIDC issuer". The JWKS can be `inline` "for issuers that are not reachable from the public internet". So an **ostra server could be the issuer**: it signs one JWT per task, exchanges it, and sends the runner's proxy a token that dies with the task.
- **Cost.** Each team registers ostra's issuer, a service account and a rule in its Console: an extra admin step. Plan availability is **unverified**.
- **Fit.** An optional "no long-lived key on any runner" mode. The static API key stays the default so a fresh install works (self-hosting rule). AWS STS and GCP short-lived access tokens give the same result for Bedrock and Vertex.

## 14. Git credential helpers, and a git proxy

- **Helpers** ([gitcredentials](https://git-scm.com/docs/gitcredentials)) are programs git runs with `get`, `store` or `erase`, using `key=value` lines on stdin and stdout. A `!` prefix makes a shell snippet. `credential.useHttpPath` scopes by repo path.
- **The weakness.** A helper configured in the worktree's git config can be run by the agent too. Anything the agent can invoke, it can call (`research/platform-auth-github.md` §2.4). So in v1 the helper must live only on the **runner's own git command line**, for example `git -c credential.helper=… push`, with the runner holding the token. It must never be in `.git/config`, the environment, or the remote URL. The agent commits; the runner fetches and pushes. ostra can expose "push" to the agent as a runner-side MCP tool that checks the branch name.
- **The git smart-HTTP proxy option (no MITM).**
  - Set `url.http://127.0.0.1:<port>/<task-token>/.insteadOf=https://github.com/`.
  - The runner forwards only the task's repo and only `info/refs`, `git-upload-pack` and `git-receive-pack`, adding `Authorization: Basic x-access-token:<ghs_…>` upstream.
  - A `git-receive-pack` body is a pkt-line command list, `old-id new-id refname`, then `PACK` ([gitprotocol-http](https://git-scm.com/docs/gitprotocol-http)). The proxy can refuse any update outside `refs/heads/ostra/<task>…` and any delete before a byte reaches GitHub.
  - This is the "push proxy that only accepts `refs/heads/ostra/*`" from `platform-auth-github.md`, moved onto the runner. The token never leaves the proxy.
  - **Unverified**, needs a spike: LFS (`/info/lfs/objects/batch` returns signed storage URLs), submodules on other repos, protocol v2 and large packs.
- **Never** put `GITHUB_TOKEN` or `GH_TOKEN` in the agent's environment. Claude Code's env scrub deliberately *keeps* them ([env vars](https://code.claude.com/docs/en/env-vars#what-the-subprocess-environment-scrub-removes)).

## 15. Docker and Kubernetes egress policies

- **Docker.** `docker network create --internal`: "Containers on an internal network may communicate between each other, but not with any other network" ([docs](https://docs.docker.com/reference/cli/docker/network/create/)). Put an agent container on an internal network whose only other member is a proxy sidecar, and the proxy is the only exit. This is tsk's design (`research/landscape.md`). Docker has no FQDN rules of its own.
  - Claude Code's reference devcontainer uses an `init-firewall.sh` iptables allowlist with `NET_ADMIN`/`NET_RAW`.
  - Anthropic warns that with `--dangerously-skip-permissions`, "dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials" ([devcontainer](https://code.claude.com/docs/en/devcontainer)).
- **Kubernetes.** Standard NetworkPolicy "only understands pods, namespaces and CIDRs". Cilium `toFQDNs` (open source, through its DNS proxy), Calico DNS policy (commercial) and ClusterNetworkPolicy `domainNames` (experimental) add names ([guide](https://www.ajayk.sh/blog/kubernetes-network-policies-guide), secondary).
- **Fit.** They stop bypass at layer 3/4 but inject nothing. Pair them with one of the proxies above. They matter once F-017 (container per task) lands.

## 16. Gateways seen along the way

- **Claude apps gateway.** Built into the `claude` binary as `claude gateway`. It needs Postgres and an IdP, runs on Linux only, and "There is no service-token flow for unattended pipelines" ([docs](https://code.claude.com/docs/en/claude-apps-gateway)). Not usable for ostra's unattended tasks.
- **LiteLLM.** Has virtual keys with budgets, but was supply-chain-compromised twice in 2026: 1.82.7/1.82.8 in March, and 1.107.0 on 2026-10-21 ([Datadog](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-docker), [LiteLLM](https://docs.litellm.ai/blog/security-incident-oct-21-2026)). A Python gateway holding every team's keys is a large dependency for little gain over §1.

---

## Interactions with OS users and the runner process

"The agent never sees long-lived keys" holds only against what the agent can read:

- **Environment of other processes.** Linux `/proc/<pid>/environ` is guarded by a ptrace read check ([proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)), which a same-uid process normally passes. So the real key must never be in *any* process's environment, the runner's included. The runner receives it over the runner protocol and keeps it in memory.
- **Memory of other processes.**
  - Linux: needs ptrace attach, which Yama can restrict. Per-distro defaults are **unverified**.
  - Windows: `OpenProcess` checks the process DACL, and `PROCESS_VM_READ` is blocked only towards *higher*-integrity processes ([process rights](https://learn.microsoft.com/windows/win32/procthread/process-security-and-access-rights), [integrity](https://learn.microsoft.com/en-us/previous-versions/dotnet/articles/bb625962(v=msdn.10))). A same-user agent can therefore likely read the runner on Windows (**unverified** in practice).
  - macOS: **unverified**.
- **Remote runners (v1: one runner container, ADR 0020).** Run agents as a **separate Unix user** from the runner and its proxy. That makes the key unreachable by both routes above, with no per-task containers needed yet. Spike it.
- **Laptops.** The agent already runs as the member and can read the member's home directory. The proxy still beats the realistic attacks: env-harvesting install scripts (IronWorm scanned 86 env vars and 20 credential files, per [Blaxel](https://blaxel.ai/blog/egress-proxy-api-credentials-ai-agent-sandboxes), vendor) and prompt-injected `env | curl`. It does not stop a targeted read of the runner. srt's Windows design uses a dedicated user account for exactly this reason.
- **Argv is public too.** srt documents its proxy token leaking through the Windows command line. Pass secrets over pipes or sockets, never argv.

## Anthropic's terms on laptops

([legal](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-11-18)

- **Team API keys and cloud credentials through ostra's proxy are allowed.** The terms don't restrict "how customers provision and manage their own API keys … for use by the customer's own authorized users", provided usage is billed to the key owner and not resold. Anthropic documents gateways that hold the key server-side.
- **A member's subscription must bypass ostra entirely:**
  - Anthropic doesn't permit "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and "developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  - Setting `ANTHROPIC_BASE_URL` without a gateway credential sends the login's `Authorization` through the gateway ([LLM gateway](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)).
  - So, in subscription mode: no base-URL override, no TLS-terminating proxy on `api.anthropic.com`, `claude.ai` or `platform.claude.com` (exclude them from any `tlsTerminate`), and no copying credentials into a per-task `CLAUDE_CONFIG_DIR`.
  - A plain CONNECT tunnel for egress allowlisting is fine, because it never sees the token.
- **Hosted ostra** (ADR 0001) falls under "Can customers offer Claude Code in their products?": it may "not pay for, resell, or intermediate Claude usage". Teams bring their own keys. The proxy must also not "remove, disable, or restrict any authentication method built into" the binary. Pointing a base URL is a documented configuration, not a modification (my reading, not legal advice).

## 4. Per-repo test secrets

- **Accepted limit (recommend confirming).** If code the agent writes or runs can use a secret locally, the agent can read it. Examples: a DB password for a local Postgres, an HMAC key, a signing key. ADR 0020's consequence already says so, and F-050 tells admins to keep environments to dev and test credentials.
- **Pattern A: placeholder and swap.** Works for secrets sent verbatim to a known HTTPS host: Stripe test keys, third-party test APIs. The proxy substitutes on egress (srt `mask`, iron-proxy `secrets`, Managed Agents `environment_variable`).
  - Needs MITM with a per-task CA.
  - Breaks clients that validate the key format or sign requests locally. srt and iron-proxy special-case SigV4.
  - Files can be masked on Linux only in srt.
  - A later F-050 option, not v1.
- **Pattern B: make the secret worthless.** The setup script creates per-task throwaway resources: a database container with a random password, a seeded sandbox account. Nothing outlives the task. Document this as the recommended practice.
- **Pattern C: secrets only in the check step (F-054).** The runner injects them only for check commands, outside the agent's process tree. But the agent wrote the code under test, so a malicious test can print or send the secret. This only helps with an egress-restricted check step and redacted check output.
- **Reads by Claude's own tools.** Claude Code's Read tool isn't sandboxed. ostra's profile should deny `Read(./.env*)` and the like, as defence in depth, not a boundary.

---

## Recommendation

**v1: model key injection** (replaces ADR 0014's "passes them to the agent as environment variables")
1. **Build** a loopback model proxy into the runner with `node:http`/`node:https` only (no new dependency for the Anthropic API).
   - It binds `127.0.0.1` on a random port and runs on all three OSes, on Node and on Bun-compiled builds.
   - It forwards a fixed path list byte-for-byte, with no buffering. It strips client credential headers, sets the real one, logs IDs and token counts only, and fails tasks fast on upstream 401/403.
2. **Give each task a phantom token** (≥128 random bits) with an expiry and an optional spend cap. Revoke it when the session ends.
   - Claude Code's environment is built from an allowlist, never inherited from the runner: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY=<phantom>`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`, a pinned `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Fast-mode and WebFetch settings come from the profile.
3. **Where the real credential lives:** server-encrypted (ADR 0014). It reaches the runner per task over the runner protocol and stays in proxy memory, never in env, argv or disk.
   - Offer an optional **short-lived mode**: Anthropic WIF with the ostra server as OIDC issuer, AWS STS for Bedrock, GCP access tokens for Vertex. Runners then hold only credentials of an hour or less.
   - The static key stays the default for self-hosting.
4. **Subscription laptops:** proxy off, nothing touched (above).
5. **Remote runner image:** run agents as a separate Unix user from the runner and proxy.
6. **Adapter parity:** declare "model base-URL override plus placeholder key" as an agent capability. OpenCode, omp and Codex support custom provider base URLs (per `agent-harnesses.md`; exact variables **unverified** per agent).

**v1: GitHub**
- The agent gets **no GitHub credential**. The runner fetches before the session and pushes after it (or when the agent calls an ostra `push` tool).
- It uses a 1-hour, one-repo, push-only token the server mints per operation (ADR 0014), passed through a credential helper on the runner's own git command line.
- The server does all REST work (PRs, comments), as already planned.

**Next (spike now, ship when agents need to push mid-task):**
- The loopback git smart-HTTP proxy with receive-pack ref filtering. It enforces `ostra/*` branches on ostra's side even where branch protection is weak.

**Later: allowlists (F-052)**
- **Implement at runner level, not in Claude Code settings.** Wrap the whole agent process tree with `@anthropic-ai/sandbox-runtime` (Apache-2.0, TypeScript; **ask before adding**).
  - One policy per environment, one srt process per task.
  - An `srt-proxy`-style decider writes the audit log (host, method, decision, task ID).
  - On remote runners after F-017: per-task containers on an `--internal` network with an srt-proxy or iron-proxy sidecar, and Cilium `toFQDNs` on Kubernetes.
- Claude Code's `sandbox.*` becomes an optional, declared agent capability, used as defence in depth.
- Windows laptops get "best effort" (srt alpha) or WSL2, and the panel says so.

**Point 4:** confirm the accepted limit. Document Pattern B. Keep Pattern A (MITM swap) as a later environment option.

---

## Unknowns / spike

1. **Claude Code through the loopback proxy (core spike).** Run it via `claude-agent-acp` and via Rivet Sandbox Agent, on Windows, macOS and Linux, with Node and Bun runners. Check:
   - Plain-`http` loopback base URL works.
   - Streaming and fine-grained tool streaming.
   - Prompt caching: `cache_read_input_tokens > 0` on turn 2.
   - Tools, subagents and compaction.
   - Interrupt mid-stream.
   - 401 path and timing.
   - Fast mode and WebFetch behaviour.
   - With all other egress blocked, nothing bypasses the proxy (except the documented `api.anthropic.com` checks).
   - Added latency (p50/p99) and memory at 50 concurrent sessions.
2. **The phantom token.** Does Claude Code check key format or length? (Cloudflare's `provided-by-worker` suggests not, at least at startup.) Does a Console-shaped phantom (`sk-ant-api03-…`) change background-model or fast-mode behaviour? Is it scrubbed from Bash's environment?
3. **A separate Unix user for agents** in the runner Docker image. Can the agent read the runner's environ or memory? Worktree permissions (shared group), git ownership (`safe.directory`), and whether the runner needs root or `CAP_SETUID` to spawn as another user.
4. **Git.** Runner-side push through an MCP tool, end to end. Then the loopback git smart-HTTP proxy: ref filtering on `git-receive-pack`, protocol v2 fetch, LFS batch, shallow and partial clones, large packs.
5. **WIF.** The ostra server as a "Custom OIDC" issuer with inline JWKS. One exchange per task. Lifetime, `jti` handling and refresh. Which Anthropic plans can use it.
6. **Bedrock and Vertex through the proxy.** SigV4 re-signing of exact body bytes (binary eventstream response kept as-is) and Vertex token injection. Dependency choice (e.g. `@smithy/signature-v4`, `google-auth-library`): ask the maintainer.
7. **For F-052 (later):**
   - srt wrapping the *whole* agent process: how the agent reaches the model proxy from inside bubblewrap's private network namespace (via srt's own proxy, or `srt-proxy` as the model gateway), Seatbelt on macOS, and the Windows alpha with its documented bypasses.
   - Docker-in-runner needing `enableWeakerNestedSandbox`.
   - Concurrent per-task policies in one runner.
8. **Open fact checks:** Envoy on Windows; whether Squid's `request_header_add` applies to bumped requests; Docker `sbx`'s TLS mechanism; macOS same-user process reading; last-commit dates for boundary, smokescreen and iron-proxy (the GitHub API was rate-limited this session; star counts came from the repo pages).
