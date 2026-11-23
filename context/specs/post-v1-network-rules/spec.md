# Post-v1: network rules per environment

**Status:** spec, 2026-11-23. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** none. F-052 sits first in `build-order.md`'s "After v1, in this order", so it is built after the launch gate, not as a milestone of its own.
**Features:** F-052 (network rules). It builds on F-116 (the egress baseline), F-017 and F-093 (the boxes), F-050 (the environment), F-051 (snapshots) and F-094 (services), and it unblocks Q302's `docker` half (webhook forwarders wait for network allowlists).
**Decisions it builds on:** ADR 0029 (pools, executors and boxes; the `host` and `kubernetes` differences), 0030 (no credential in the agent's container), 0031 (the safety minimum, and why allowlists are not in v1), 0038 (environments, snapshots and services), 0060 (the `kubernetes` policy and the chart), 0034 and 0022 (the runner protocol and its minors). **New for this spec:** ADR 0073 (environment network allowlists), which amends ADR 0031's fourth line and extends ADR 0029's fourth recorded difference.
**Research it rests on:** `research/credential-proxy.md` (`summary`, §14 "Later: allowlists (F-052)", §15 "Docker and Kubernetes egress policies"). Its finding is the reason this spec is shaped the way it is: *a process that ignores `HTTPS_PROXY` simply goes direct*, so an allowlist is only real where the box has no other route. On `docker` the box has none; on `kubernetes` and `host` it does.
**On this machine:** the scripted run and every unit test run on Windows with the `host` executor and fakes. The `docker` and `kubernetes` halves have never run live (spike 3, milestone 5's ticket 35): they are written, and their proof is the launch-gate Proof run.

Terms follow `context/GLOSSARY.md`. **Network rule** and **egress proxy** are new terms and go in the glossary with this spec's commit.

---

## 1. What F-052 ends with

A project admin opens the environment's **Network** tab, names the public hosts this environment may reach, and every box that environment starts does so through a proxy that refuses the rest. On `docker` that is the whole of the box's egress; on `kubernetes` and `host` the page says in plain words what the proxy does not stop.

In more words, and by executor, because the honest answer differs.

- **On `docker`** the agent's container is on an `internal` network whose only other members are the box's sidecar and its services (`boxes.ts`): it has no route out at all. The environment's rules are enforced by an **egress proxy in the sidecar**, which is the box's only way out; the agent, its setup script, its checks and its app processes get `HTTP_PROXY`/`HTTPS_PROXY` pointing at it. A destination that isn't a rule is refused with a 403, and the refusal is one line in the task's Event log. A process that ignores the proxy variables reaches nothing, because there is nothing to reach. **This is enforcement, and it is proved from a shell in the agent's container.**
- **On `kubernetes`** every container of the pod shares one network namespace and one IP, and the chart's NetworkPolicy selects the pod, not a container, so the agent keeps direct public egress (ADR 0029, fourth difference; ADR 0060 applies the policy once and the runner may not write one). The same proxy runs in the sidecar and the same variables are set, so every client that honours them is filtered; a process that ignores them goes direct. **This is a filter, not a boundary**, and the environment page, the runner page and the docs say so in those words, beside ADR 0029's existing note.
- **On `host`** there is no box at all, and the executor is labelled "not isolated". The runner process runs the same proxy and sets the same variables on the agent's processes and its setup, so the common case is covered the same way as on `kubernetes`. Nothing stops a process that ignores them. **That is the declared difference this spec records**, and it is the fifth `host` difference in ADR 0029's list (it is the first that is about egress rather than containment, so ADR 0073 restates the list's count and adds it).
- **Services** are not proxied. A service's own environment is its own, and a third-party image with an injected `HTTP_PROXY` is a support problem, not a feature. On `docker` a service reaches no public host today and won't after this; on `kubernetes` a service keeps the pod's direct egress.
- **Snapshots** are unchanged. A snapshot builds with the build's own egress (BuildKit's network on `docker`, the build namespace's policy on `kubernetes`, ADR 0038), because the setup script is the admin's and a build that can't fetch a lockfile is useless. The **incremental install the box runs at start** happens in the agent's container, so with rules set it goes through the proxy, and the package hosts the environment installs from belong in the rules. The panel says this beside the editor; it does not try to guess hosts from the script.

### What the feature adds, and what it does not

**In:**
- a rule is a **host** (an exact name, or `*.` and a suffix for a whole subdomain level) or a **CIDR**, each with one or more TCP ports;
- the environment's list of rules, saved on the **Network** tab beside Services and checks, readable by anyone who can open the project and editable by project admins;
- the validation that keeps rules inside the baseline: a CIDR inside `EGRESS_BLOCKED_V4/V6` is refused, because an environment narrows what the baseline allows and never widens it (`OSTRA_EGRESS_ALLOW` is the runner admin's widening, and stays the only one);
- the **egress proxy** in the sidecar (and in the runner process on `host`): HTTP forwarding and `CONNECT` tunnels, TLS untouched, a 403 and one event per refused destination and port;
- the agent's proxy variables, set only when the environment has at least one rule, and `NO_PROXY` covering the model, git and MCP proxies so an allowlisted environment never proxies its own model or git traffic;
- the runner protocol's **minor 10** field and refusal, so an older runner never receives a task whose environment has rules;
- the panel's words for each executor, the task's Event log line, the docs, and the probes in `proof.yml`'s live jobs.

**Not in** (and where it goes):
- **Containment on `kubernetes`.** Closing the pod's direct egress needs a CNI that understands names (Cilium `toFQDNs`) or a per-box NetworkPolicy, and both are a dependency or a privilege the runner doesn't have (section 8, ADR 0073's alternatives). It is an open question for the maintainer, not a silent gap.
- **An OS-level jail on `host`** (`@anthropic-ai/sandbox-runtime`, the research's first recommendation). It is a new dependency and a new runtime story for Windows, and it needs the maintainer's word. Open question.
- **Wildcards beyond `*.suffix`, regular expressions, URL paths, HTTP methods, and UDP.** The proxy is layer 7 by accident (it must read a host name), and it deliberately does not go further: a method or path rule is an inspection feature with its own failure modes. UDP has no CONNECT and no rule surface we would want to publish.
- **Per-rule prompts ("ask a member").** A refusal is silent to the agent except as an HTTP error; no approval path is built (Onyx's ALLOW/ASK/DENY split is recorded in the research, §7, and not copied).
- **A per-project default list, or an organization-level list.** An environment is the unit (ADR 0038), and a template can come later.
- **Detection reading a repo's hosts** (`.env.example` URLs, lockfile registries) into a draft. A later F-112 extension.

### On this machine

- **Unit tests** run everywhere: the proxy against a real loopback origin, the rule validation, the codec at minor 9 and 10, the API, the panel's words.
- **The scripted run** (`pnpm e2e:f052`, `e2e/f052-network-rules/`) runs on the `host` executor with a loopback HTTP origin and a refused destination, and checks the event log, the panel's text, and that a task with rules is not offered to a minor-9 runner (a fake minor-9 peer in the runner suite).
- **The live half** — that the proxy is reachable from a shell in a real `docker` box and that a proxy-ignoring request has no route, and the same on `kind` with direct egress observed — is `proof.yml`'s `live-docker` and `live-kind` jobs, run once at the launch gate. Until that run, F-052 stays `building` even with every other condition green, with a dated note in the ledger (ticket 06).

---

## 2. The feature and where it lives

| F-ID | What this spec builds | Packages | Tickets | At the end |
|---|---|---|---|---|
| F-052 Network rules | The rule shape and its validation; the table; minor 10; the egress proxy and its wiring on `docker`, `kubernetes` and `host`; the Network tab; the words per executor; the docs; the live proof | `packages/db`, `packages/protocol`, `packages/domain`, `apps/runner`, `packages/adapters/adapter-executor-docker`, `packages/adapters/adapter-executor-kubernetes`, `packages/adapters/adapter-executor-host`, `packages/adapters/adapter-opencode`, `packages/adapter-sdk`, `packages/task-view`, `packages/api`, `apps/web`, `apps/docs` | 01 to 06 | `done` once the Proof run's `live-docker` and `live-kind` pass, otherwise `building` |

**Rows this spec touches without finishing:**
- **F-116** (egress baseline) is unchanged. The proxy adds a second check of the baseline's ranges on a resolved address; it does not restate them.
- **F-051** (snapshots): the build's egress is untouched. One sentence lands in its spec's docs section that the box's start-time install now needs the package hosts in the rules.
- **F-094** (services): a service is not proxied; the Network tab's note says so.
- **F-116's row and ADR 0029's fourth difference:** the difference stays exactly as it is. What changes is that F-052's page says what it means for allowlists. No new difference for `kubernetes`.
- **F-013/F-092** (the runner pages): one line each about what the allowlist binds on that executor. Ticket 04.

**Built in from the first milestone** (`build-order.md`), checked by ticket 06:
- organization-scoped data: the new table carries `organizationId`, `projectId` and `environmentId` with the same composite keys as `Service`/`Check`, and the generated isolation test (F-049) gets its fixture and its reviewed row (Q196);
- the event log and the durable queue: a rule's save is one transaction with its audit entry; an `egress.blocked` is an event, saved with the task's others;
- no credential in the agent's container: the proxy holds none, the rules carry none, and the agent's environment gains only proxy URLs;
- strict typing end to end: one Zod schema for the rule, its type `z.infer`'d, and the protocol's strict codecs;
- dark first, responsive, English text in `apps/web/messages/en.json`.

### Done when (F-052's conditions)

Each is the first sentence of a ledger condition, so its test is `it("F-052/cN: ...")`. Ticket 06 sets them in `context/features.md`.

1. **c1.** A network rule is a host name (exact, or `*.` and a suffix) or a CIDR, with one or more TCP ports, and a project admin saves the environment's list on its Network tab; a rule inside the egress baseline's ranges is refused, because an environment narrows the baseline and never widens it.
2. **c2.** On `docker`, a request to an allowlisted host and port succeeds through the sidecar's egress proxy, a request to any other public host is refused with a 403, a positive control runs first, and a request that ignores the proxy variables reaches nothing. *(The last two clauses, from a shell in a real box, are shown by the Proof run's `live-docker` job and wait for it.)*
3. **c3.** An environment with at least one rule gives its agent, its setup script, its checks and its app processes `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` for the proxy, and a `NO_PROXY` that keeps the model, git and MCP proxies out of it; a repo variable can't override them, and an environment with no rules sets none of them.
4. **c4.** On `kubernetes` the same proxy answers the same way, and the environment page, the runner page and the docs say that a process that ignores the proxy reaches the pod's direct public egress, which this feature does not close (ADR 0029's fourth difference). *(The direct-egress half is shown by `live-kind` and waits for it.)*
5. **c5.** On `host` the runner's proxy is offered to the agent's processes the same way, and the page says nothing enforces it because the executor is not isolated (ADR 0029's fifth `host` difference, recorded in ADR 0073).
6. **c6.** A task whose environment has rules is offered only to a runner at protocol minor 10 or later; a minor-9 peer is refused it with a reason it can show, and never receives the rules.
7. **c7.** A refused destination is one `egress.blocked` event per host and port per task, shown in the task's Event log in words, and neither the event nor any log line carries a request's path, query or headers.

*Working values in this spec:* at most 100 rules per environment and 16 ports per rule; the proxy listens on a free port, as the key and git proxies do, and the sidecar reports its URL on the box network (`sidecar:<port>`) or on loopback (`127.0.0.1:<port>`); a refused destination emits at most one event per (host, port) per task.

---

## 3. How it is proved

**Unit and package tests** (tickets 01 to 04):
- the rule schema and its validation, including the baseline refusal and the host syntax;
- the proxy against a real loopback HTTP origin and a raw TCP echo server: an absolute-form GET, a `CONNECT` tunnel (bytes both ways), a refused host, a refused port, a host rule matching `*.suffix` but not the bare suffix, a CIDR rule matching a resolved address, the baseline refusal on a loopback target, and a 403 with a body a person can read;
- the minor-10 codec both ways, and the offerability refusal, in the runner protocol's own tests;
- the API's admin check, the audit entry, and the isolation test's new row;
- the panel's words per executor, and `packages/task-view/src/coverage.ts` gaining `egress.blocked`.

**The scripted run** (`e2e/f052-network-rules/`, ticket 06), on `host`, no network beyond loopback:
1. a project whose environment has no rules: a task's agent gets no proxy variables and reaches a loopback origin directly (as today);
2. a rule for the loopback origin's host and port: a new box's shell reaches it through the proxy, a second loopback origin on another port is refused, the Event log shows one `egress.blocked` line, and the third request to the refused destination adds no second line;
3. the panel's Network tab: add, edit ports, remove, the baseline refusal's message, the warning about the setup script's installs, and the three executors' notes;
4. a fake minor-9 peer: the task is not offered, with the reason.

**The live run** (ticket 06, at the launch gate, `proof.yml`'s `live-docker` and `live-kind`):
- `docker`: from a shell in the agent's container, `curl` to the allowlisted origin succeeds through `HTTP_PROXY`, `curl` to another public host gets the proxy's 403, `curl --noproxy '*'` to that host fails to connect, and the same for a raw `node:net` connection;
- `kind`: the same proxy assertions, plus one assertion that a `--noproxy '*'` request **succeeds**, which is the recorded difference made visible rather than asserted away.

---

## 4. How it fits the code as it is

Read from `main` on 2026-11-23 (`9f1f76bb`), so builders don't rebuild what exists.

- **The environment is one row per project** (`Environment`, `packages/db/prisma/schema.prisma`) with `status` (`draft`|`saved`), and typed children `EnvironmentEntry`, `Service`, `Check`, `Snapshot`, `AppProcess`, `EnvironmentProposal`, `EnvironmentRepoDraft`. Each child carries `organizationId`, `projectId` and `environmentId` with the composite relation `[environmentId, projectId]`.
- **The environment config** that `saveEnvironment` writes is `environmentConfigSchema` (`packages/protocol/src/config/environment.ts`): base image, setup script, `envFiles`, entries. Services and checks have **their own routers and their own transactional saves** (`packages/api/src/routers/environment-services.ts`: `list`, `save`, `delete`), because they change without the big form. Rules follow services, not the environment form.
- **The task spec** is `taskSpecSchema` (`packages/protocol/src/task/spec.ts`) at minor 9, with `taskSpecEnvironmentSchema`/`…V6`, `taskSpecResponseSchemaFor(minor)`, `encodeTaskSpecForMinor`, `taskSpecMinMinor` and `isTaskOfferable`; a new section is added the way minor 7's app processes and minor 8's files were.
- **The sidecar** (`apps/runner/src/sidecar/`) already holds three loopback proxies: `key-proxy.ts`, `git-proxy/`, `mcp-proxy.ts`. `task-run.ts` starts them with `listen` options and hands the agent `proxies` (`gitBaseUrl`, `modelBaseUrl`, `mcpUrl`). The `host` executor's task host is the same code, with the runner process as the sidecar (ADR 0029).
- **The agent's environment is an allowlist** built in `packages/adapters/adapter-opencode/src/config.ts` (`buildCliEnv`, `buildAgentEnv`, `allowedEnvNames`) from the fake key, the task's folders and `input.extraEnv` (the environment's non-secret variables), with the git guard applied last. Proxy variables must be added there, after `extraEnv`, or a repo variable named `HTTPS_PROXY` would win.
- **The box** on `docker` has `agent` on the `internal` box network only, and `sidecar` on the box network and the shared egress network (`boxes.ts`). The `kubernetes` pod shares one namespace (`packages/adapters/adapter-executor-kubernetes/src`), and the chart's `ostra-egress-baseline` policy is applied once per namespace (`packages/adapters/adapter-executor-kubernetes/src/egress.ts`, `baselineEgressPolicy`, `baselineProblem`). **No executor writes a NetworkPolicy**, by design.
- **The baseline's one list** is `EGRESS_BLOCKED_V4/V6`, `METADATA_ADDRESS`, `inCidr`, `hostCidr`, `isBlockedByBaseline` in `packages/adapter-sdk/src/executor/egress-baseline.ts`; the probes are `packages/adapter-sdk/src/testing/egress-probes.ts` (`runEgressProbes`), run by `proof.yml`'s live jobs.
- **The panel's environment page** is one page with tabs `setup`, `services`, `app`, `proposal` (`apps/web/src/components/projects/environment-view.tsx`, `?tab=`), with `ServicesAndChecks` in `environment-services.tsx` and its words in `environment-services-words.ts`.
- **Every event kind has a declared place**: `packages/task-view/src/coverage.ts` fails a kind with none, and `derive-state.ts` switches over kinds exhaustively.

---

## 5. The contracts

### 5.1 `packages/protocol`: a network rule, and minor 10 (ticket 01)

A new `packages/protocol/src/config/network-rule.ts`:

```ts
export const networkRulePortSchema = z.number().int().min(1).max(65_535);

/** 1 to 16 TCP ports, sorted, no repeats (the one place a rule's ports are made canonical). */
const networkRulePortsSchema = z.array(networkRulePortSchema).min(1).max(16)
  .refine((ports) => new Set(ports).size === ports.length)
  .transform((ports) => [...ports].sort((a, b) => a - b));

/** A host name: an exact name or `*.` and a suffix (two labels at least); case and a trailing dot are normalised. */
export const networkRuleHostSchema = z.string().min(1).max(253)
  .toLowerCase()
  .transform((host) => host.replace(/\.$/, ""))
  .pipe(z.string().regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/));

export const networkRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host"), host: networkRuleHostSchema, ports: networkRulePortsSchema }),
  z.strictObject({ kind: z.literal("cidr"), cidr: cidrSchema, ports: networkRulePortsSchema }),
]);

export type NetworkRule = z.infer<typeof networkRuleSchema>;

/** A rule's id: `src/ids.ts`'s `idBase.brand<"NetworkRuleId">()`, as `projectIdSchema` is. */
export const networkRuleIdSchema = idBase.brand<"NetworkRuleId">();

/** An environment's whole list: at most 100 rules, each (kind, value) once. */
export const networkRulesSchema = z.array(networkRuleSchema).max(100)
  .refine((rules) => new Set(rules.map((rule) => `${rule.kind}=${rule.kind === "host" ? rule.host : rule.cidr}`)).size === rules.length);
```

- The host schema's chain is illustrative: what matters is that a typed value is trimmed, lowercased and stripped of a trailing dot before the pattern is checked, in that order (Zod 4's `.trim()`/`.toLowerCase()` or a `.transform` before the `.pipe`), so `EXAMPLE.com.` is accepted and stored as `example.com`, and the pattern then refuses what no DNS name can be.
- `cidrSchema` is new (there is none in `packages/protocol` today): an IPv4 or IPv6 address and a prefix, always with the prefix written, the bit count in range, checked by splitting and parsing the octets or groups. The panel pre-fills `/32` (or `/128`) for a single address, and the domain canonicalises the case of an IPv6 prefix's address before saving.
- The schema normalises what a person types (case, a trailing dot, port order) rather than asking the panel to; the database stores the parsed value. It is ostra's own format, so an unknown field in a rule is refused.
- The host regex refuses an IP literal in `host` (it needs a TLD label), a scheme, a path, a port, an underscore and a trailing dot; a member who wants an IP writes a `cidr`.

**Task spec (minor 10).** The environment schema's newest version is minor 7's (`taskSpecEnvironmentSchemaV6` extended with `appProcesses` and `screenshots`), so the current `taskSpecEnvironmentSchema` gains one more optional field:

```ts
networkRules: networkRulesSchema.optional(), // missing: none
```

`encodeTaskSpecForMinor(9)` strips it, `taskSpecResponseSchemaFor(minor)` returns nothing at 9, and `isTaskOfferable` gains a reason, `network-rules`, for a spec whose environment has a non-empty list and a peer below minor 10, with its sentence in `taskNotOfferableWords` ("this environment limits which hosts its agent may reach, and this runner needs upgrading"). `PROTOCOL_MINOR` becomes 10 and its comment gains one line; a `minor-10.test.ts` follows `minor-9.test.ts`'s shape.

**Event.** `egress.blocked` as a runner event: `{ host: string, port: number, reason: "not-listed" | "baseline" | "unresolvable" }`, where `host` is the name or the literal address exactly as the client asked for it (the CONNECT authority's host), never a resolved address and never the client's. It carries no path, query, header or client IP. The event's schema is in the protocol, so the server refuses an unknown field and the codec at minor 9 has no code for it. `packages/task-view/src/coverage.ts` gets `"egress.blocked": eventLog("post-v1, F-052")`, and `derive-state.ts` treats it as a non-state event.

### 5.2 `packages/domain`: normalisation and what a rule may not say (ticket 01)

`packages/domain/src/environment/network-rules.ts`:

- `normalizeNetworkRule(rule)`: lowercases the host and drops a trailing dot (again, defensively), canonicalises the address case inside an IPv6 CIDR and its bit count, and returns the rule as the schema would. The host and ports are already canonical from the schema (`5.1`).
- `networkRuleProblem(rule): string | null`, one message per refusal:
  - a `host` ending in `.localhost`, `localhost` itself, or a single-label name: "a rule names a public host; `localhost` and private names are inside the egress baseline";
  - a `cidr` that `EGRESS_BLOCKED_V4/V6` contains (`inCidr` per range; a CIDR inside a range, not only a single address): "this address is inside the egress baseline (F-116). A runner admin allows a private endpoint with `OSTRA_EGRESS_ALLOW`, not an environment";
  - a schema issue (a bad port, a repeat, a bad address): the API re-words it for the panel, in the same shape as the messages above;
  - a `host` rule whose name resolves at save time to a baseline address: **not checked** (DNS changes; the proxy checks at connect time and refuses with `reason: "baseline"`). The message says so in the help text, not as a refusal.
- `networkRulesView(rows)`: rows to the API's view (section 5.5), stable-ordered by `kind`, then value.
- Three audit actions join `auditActions` (`packages/domain/src/audit/actions.ts`, the `environment.service-*` trio's pattern): `environment.network-rule-added`, `environment.network-rule-changed` and `environment.network-rule-removed`, each with the rule's kind and, for an added or removed rule, its value. A rule's value is not a secret; an entry stays one line.

The environment's **saved** state is what counts: a rule saved on a `draft` environment applies as soon as a box is dispatched with it, as the rest of a draft environment does. **A running box is not restarted**: the rules travel in the task spec at dispatch, and a box keeps the rules it started with. The tab says so.

### 5.3 `apps/runner`: the egress proxy (ticket 02; `host` and `kubernetes` in 02 and 03)

A new `apps/runner/src/sidecar/egress-proxy.ts`, Node's `node:http` and `node:net` only (**no new dependency**), modelled on the existing `key-proxy.ts`/`git-proxy/`:

```ts
export type EgressProxyOptions = {
  readonly taskId: TaskId;
  readonly rules: readonly NetworkRule[];
  /** `OSTRA_EGRESS_ALLOW`, which the runner was started with: the baseline's administered exceptions. */
  readonly allowedAddresses: readonly string[];
  readonly listen: { readonly host: string; readonly port: number };
  readonly logger: Logger;
  readonly onBlocked: (event: { host: string; port: number; reason: EgressBlockedReason }) => void;
  /** The DNS answer the proxy uses; the default resolves through this process's resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
};
```

Behaviour, in order:
1. **A `CONNECT host:port`** — parse the authority, refuse immediately with `403` and a short body when (host, port) matches no rule, or when the host's resolved address is inside the baseline and not in `allowedAddresses`; otherwise resolve, open a `node:net` socket, write `200 Connection Established`, and pipe both ways. TLS passes untouched: the proxy never has a CA and never sees a byte of plaintext.
2. **An absolute-form HTTP request** (`GET http://host/path HTTP/1.1`) — the same check, then forward the request to the origin over a fresh connection, stripping `Proxy-Connection` and `Proxy-Authorization` and passing every other header and the body through unchanged; return the origin's response as it is. This is what makes `curl http://…` and a plain-HTTP package mirror work.
3. **Anything else** (an origin-form request with no absolute URI, a WebSocket upgrade without CONNECT, a `CONNECT` to a port not in a rule) — `403` with the same body. No `Upgrade` handling: HTTPS WebSockets ride inside CONNECT, plain `ws://` is not supported and the docs say so.
4. **Matching:** a `host` rule matches the requested name case-insensitively; a `*.suffix` rule matches any name with at least one label before `suffix` (`*.example.com` matches `a.example.com` and `a.b.example.com`, never `example.com`). A `cidr` rule matches the resolved address. A rule's ports are the only ports it opens.
5. **Baseline, again:** every resolved address is checked with `isBlockedByBaseline` (or the CIDR check) and refused unless `allowedAddresses` (`OSTRA_EGRESS_ALLOW`) holds it. This is the second wall behind the host rules and the only wall on `kubernetes` and `host`; it is why a rule naming a public name can't be used to reach a private one through a hostile DNS answer.
6. **A refusal** writes no body content from the request, logs `{ taskId, host, port, reason }` only, and calls `onBlocked` **at most once per (host, port) per task** (a `Set` in the proxy). The 403's body is `ostra: <host>:<port> is not in this environment's network rules`.

Wiring:
- **`docker`:** `task-run.ts` starts the proxy when the task's environment has rules, and only then, with the same `{ listenHost, advertiseHost }` the key and git proxies get (`run-sidecar.ts`'s `listenHost`, `OSTRA_SIDECAR_HOST=sidecar`), so the agent reaches it at `http://sidecar:<port>`. It adds `egressUrl` to `proxies` and to the agent's environment (below). The agent's container already has no other route, so no container or network changes; the one addition is the runner's own `OSTRA_EGRESS_ALLOW` in the sidecar's `Env` (`boxes.ts`), so the proxy reads the same exceptions the host rules do. It is a list of addresses, not a credential.
- **`kubernetes`:** the same start, with the pod's `localhost` (`listenHost` is loopback, `advertiseHost` absent), so the agent reaches it at `http://127.0.0.1:<port>`, and `OSTRA_EGRESS_ALLOW` in the sidecar container's `Env` (`pod.ts`), from the setting the runner already reads. Nothing else changes: the chart, the policy and the executor's `health()` are untouched.
- **`host`:** the same start in the task host (`run-runner.ts`'s `listenHost: "127.0.0.1"`), and the executor's `baseEnv` overlay gains the variables for the agent, the setup and the checks (the same helper).
- **The agent's environment:** `buildAgentEnv` (`adapter-opencode`) gains, after `extraEnv` and before the git guard, when a proxy URL is passed in `PrepareLaunchInput`:

```ts
HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy = <proxy url>
NO_PROXY, no_proxy = "localhost,127.0.0.1,::1,sidecar,host.docker.internal"
```

  plus the model, git and MCP proxy origins (their host and port as the agent reaches them). `allowedEnvNames` gains all of them, and the agent contract suite's allowlist check accepts them. `NO_PROXY` is computed in `task-run.ts` from `proxies`, never from a repo variable. The uppercase and lowercase spellings both, because curl, git and npm each read one or both.
- **The setup script, the checks and the app processes** run in the same container (or, on `host`, the same process tree) with the same base environment the agent's launch carries, so they inherit the variables by construction; ticket 02 asserts it rather than adding plumbing.

### 5.4 `packages/adapter-sdk`: the probes (ticket 02)

`testing/egress-probes.ts` gains a scripted case set for the allowlist, in the file's existing style (positive control first, a timeout is `inconclusive`):
- an allowlisted destination through `$HTTP_PROXY` — must succeed;
- a second destination not in the rules — must be refused with the proxy's 403;
- the same destination with `--noproxy '*'` — `blocked` on `docker`, `reachable` on `kubernetes`, `inconclusive` on `host` unless the caller says otherwise. Each case takes that expectation per executor as a parameter, so the live job asserts the recorded difference instead of hiding it.
The probes read the proxy from their own environment (`HTTP_PROXY`/`HTTPS_PROXY`), which the runner already gives the agent's processes, so no new task-spec field is needed.

### 5.5 `packages/api`: the Network tab's procedures (ticket 04)

A new `packages/api/src/routers/environment-network.ts`, registered on `appRouter`, built on `projectProcedure` exactly as `servicesRouter` is:

```
networkRules.list   (read)   { projectId } -> { rules: RuleView[], enforcement: EnforcementView }
networkRules.save   (admin)  { projectId, ruleId?: NetworkRuleId, rule: NetworkRule } -> { rules: RuleView[] }
networkRules.delete (admin)  { projectId, ruleId: NetworkRuleId } -> { rules: RuleView[] }
```

- `RuleView` = `{ ruleId, kind: "host", host, ports } | { ruleId, kind: "cidr", cidr, ports }`, the stored normalised values.
- `EnforcementView` = `{ online: ExecutorKind[], pool: ExecutorKind[] }`, read the way `whereTasksRun` reads the pools: which executors the project's runners have, so the tab can say what the rules bind on the pool someone will actually use.
- `save` normalises (`5.2`), refuses a `networkRuleProblem` with `BAD_REQUEST` and its message, and writes one row plus the audit entry in one transaction. It does **not** enqueue `snapshot.schedule`: the image doesn't hold a rule. It writes a change notice, as the services router's writes do, and returns the whole list so the panel replaces its state with the server's order.
- The rules' writes are allowed on a `draft` environment (services are), and the view says whether the environment is saved.
- Isolation: the generated test (F-049) gets `environment_network_rule` in its fixture set and its reviewed allowlist, plus a two-project case in `milestone-3.test.ts`'s style proving one project's rules never reach another's task spec.
- `apps/api`'s `environment.test.ts`-style suite covers: read for a member, save/delete refused for a member and allowed for a project admin, the baseline refusal's exact message, normalisation (`EXAMPLE.com.` → `example.com`, ports sorted), and a rule saved against a project the caller can't see → `NOT_FOUND`.

### 5.6 `apps/web`: the Network tab (ticket 04)

- `EnvironmentTab` gains `"network"` (`?tab=network`), a new tab between **Services and checks** and **App**: the label "Network", with the tab strip's existing roles (the `tablist`/`tab`/`tabpanel` pattern in `environment-view.tsx`).
- A new `apps/web/src/components/projects/environment-network.tsx` with its words in `environment-network-words.ts` and a `environment-network-words.test.ts` (the `environment-services-words.ts` pattern):
  - **What the rules do**, one sentence per executor among those online, built from `EnforcementView`: "Enforced on `docker`: the agent's container's only way out is the proxy." / "On `kubernetes`, a process that ignores the proxy still reaches the internet directly (ADR 0029)." / "On `host`, nothing enforces it." When the project's pools hold several executors, all the applicable lines show, in the order `docker`, `kubernetes`, `host`.
  - **The list**: each rule as a row — the host or CIDR, its ports as chips, an edit and a remove. Inline add: a kind picker (Host / Address), the value, ports (`443` prefilled), Add. Errors appear under the field with the domain's message.
  - **The note** under the list: "Applies to the next task. A running task keeps the rules it started with." and "The setup script and the install at box start run through the proxy too: name the package hosts they use." and "A service is not proxied."
  - **Empty state:** the rules list's absence is not an error, and reads: "No rules: this environment's egress is unrestricted. On `docker` that still means no public host; on `kubernetes` and `host` the agent has whatever its machine has."
- **The Event log line** (ticket 04: `packages/task-view`'s place and the panel's `task-event-log/event-log-words.ts`): `Blocked example.com:443 — not in the environment's network rules`, once per destination, with the reason's words; no path, no query, no header. A refusal during a turn is folded as bookkeeping, not as a step: it is in the Event log and in the run's footer count, not a bubble.
- `apps/web/messages/en.json` gains `environment.network.*` and the event's words; nothing in the panel is hard-coded English.

### 5.7 `apps/docs` (ticket 05)

- `runners/egress.mdx`: the closing paragraph ("Allowlists ... come after v1") is replaced by a **Network rules** section: what a rule is, the three executors' sentences copy-for-copy from the panel, the setup/install consequence, and a link to the environment page's tab.
- `install/setup.mdx`: one step-5 paragraph, "Limit what the environment may reach", with the same rule shape and the package-hosts note.
- `runners/executors.mdx`: `host`'s "not isolated" paragraph gains "and no network rule is enforced there".
- No new setting: the proxy listens on a free loopback (or box-network) port and the sidecar hands its URL to the task, `OSTRA_EGRESS_ALLOW` already has its line in the configuration reference, and the section says that a private endpoint is the runner admin's exception, not an environment's.

---

## 6. Parity

**Runner parity (executors).** A task's behaviour is the same on every executor except in the strength of one control, and each difference is recorded:
- `docker`: the proxy is the box's only exit — **enforcement**;
- `kubernetes`: identical proxy and variables, and the pod's direct egress is what ADR 0029's fourth difference already says — **filter**;
- `host`: identical proxy and variables, no boundary — **advisory**, and ADR 0073 records it as ADR 0029's fifth `host` difference.

**No new declared capability.** How much a rule binds is a property of the executor kind, fixed by ADR 0073, not something a runner reports: the panel's three sentences are one function over `ExecutorKind` with a test per kind, so a runner can't misreport its strength and an old runner's `hello` doesn't need a field. That is the one departure from "a difference is a declaration": the difference is the ADR's, and the words are its single implementation.

Everything else is identical: the rule list, the matching, the 403, the events, the offerability at minor 10, and the effect at the next dispatch. **A task's result never differs**: a request to a non-allowlisted host is refused by the proxy in all three; what differs is whether a process can leave the proxy's path, and the panel and docs say which executors allow it.

**Adapter parity.** The rules and the proxy are the runner's, not an agent's: the `AgentAdapter` interface is unchanged, and every agent gets the same environment variables. `adapter-opencode`'s `allowedEnvNames` gains the variables (ticket 02), and the agent contract suite's environment case accepts them; any later agent that reads proxies the way every tool does needs nothing.

**Protocol.** Minor 10 is additive; a minor-9 peer is never sent a spec with rules (`encodeTaskSpecForMinor`) and is never offered such a task (`isTaskOfferable`). The refusal is a normal "wait for a runner" state, with the panel's sentence; the task stays queued rather than failing.

---

## 7. Migrations and rollout

- One migration, additive only: `environment_network_rule` (table and its enum), plus the environment's relation. No backfill; an environment with no rows is exactly today's behaviour, and **no task spec changes for an environment with no rules**, so upgrading an install changes nothing until a member adds a rule.
- No dropped or renamed column; `Environment` is untouched (rules are a child table, like `Service`).
- A downgrade is the usual one: the table stays, the code that read it doesn't (the migration isn't reversed).
- The minor's rollout is the protocol's usual window: a runner one minor behind refuses only the tasks that need the rules; every other task runs as before.

---

## 8. Dependencies and open questions

**No new dependency.** The proxy is `node:http`/`node:net`, the table is Prisma, the panel is the existing stack.

**Open questions for the maintainer** (also to be added to `context/open-questions.md` by ticket 06, and left there by this spec):
1. **Closing `kubernetes`'s direct egress.** Cilium's `toFQDNs` is the research's third-ranked option and gives real name-based enforcement, but it makes a CNI a requirement of the cluster and its policy is vendor-specific. A per-box NetworkPolicy written by the runner is the native alternative, but the chart deliberately keeps the right to write policies out of the runner's service account (ADR 0060), it can't express a host name without resolving it at box start, and the pod shares the namespace with the sidecar, so the policy would have to carry the sidecar's own destinations too. **Recommended: keep F-052's proxy on `kubernetes`, and decide the CNI question before a "strict mode" is promised.**
2. **An OS-level jail on `host`.** `@anthropic-ai/sandbox-runtime` is Apache-2.0 and TypeScript, and the research recommends planning F-052 on it; it is also a runtime dependency with an alpha Windows story, and it would wrap the whole agent process tree. **Recommended: not for this feature; ask before adding it.**
3. **Should an environment ever be able to open a baseline range?** This spec says never (the runner admin's `OSTRA_EGRESS_ALLOW` is the only widening). A team with a private model server per project might want the environment to name it; that is a second, privilege-laden setting and is not built.

---

## 9. Packages, builders and tickets

| Ticket | Builder | Packages | Blocked by |
|---|---|---|---|
| 01 the rule, the table and minor 10 | core (contracts, first) | `packages/protocol`, `packages/db`, `packages/domain` | none |
| 02 the egress proxy, and `docker` | runner | `apps/runner`, `packages/adapters/adapter-executor-docker` (the sidecar's `OSTRA_EGRESS_ALLOW`), `packages/adapters/adapter-opencode`, `packages/adapter-sdk` | 01 |
| 03 the proxy on `kubernetes` and `host`, and the words' facts | runner | `apps/runner`, `packages/adapters/adapter-executor-host`, `packages/adapters/adapter-executor-kubernetes` (`pod.ts`'s env only; no policy change) | 01, 02 |
| 04 the API, the panel and the event's line | api and web | `packages/api`, `apps/web`, `packages/task-view`, `packages/domain` (the audit action's use) | 01 |
| 05 the docs | docs | `apps/docs` | 01, 04 |
| 06 the scripted run, the live proof and the ledger | core (lead), with each builder on call | `e2e/`, `.github/workflows/proof.yml`, `context/features.md`, `context/open-questions.md`, `context/GLOSSARY.md` | 02, 03, 04, 05 |

**Test seams, in one place** (the builders share them):

| Seam | Where | Ticket |
|---|---|---|
| `networkRuleSchema`, `networkRulesSchema`, host/CIDR syntax, ports | `packages/protocol/src/config/network-rule.test.ts` | 01 |
| the task spec at minor 9 and 10, the stripping, the reason | `packages/protocol/src/runner/minor-10.test.ts` | 01 |
| normalisation and the baseline refusal | `packages/domain/src/environment/network-rules.test.ts` | 01 |
| the table, the composite keys, the isolation row | `packages/db`'s schema test and `packages/domain/src/milestone-3.test.ts` | 01 |
| the proxy: forward, CONNECT, refuse, wildcard, CIDR, baseline, once-per-destination | `apps/runner/src/sidecar/egress-proxy.test.ts` | 02 |
| the agent's variables, ordering and `NO_PROXY` | `packages/adapters/adapter-opencode/src/config.test.ts`, `apps/runner/src/task-host/*.test.ts` | 02 |
| the probes' verdicts from scripted results | `packages/adapter-sdk/src/testing/egress-probes.test.ts` | 02 |
| the pod's proxy and the recorded difference's probe | `packages/adapters/adapter-executor-kubernetes/src/…test.ts` | 03 |
| `host`'s variables and its advisory note | `packages/adapters/adapter-executor-host/src/host-executor.test.ts` | 03 |
| the API's admin checks, audit, messages | `packages/api/src/routers/environment-network.test.ts` | 04 |
| the tab's words per executor, the list, the empty state | `apps/web/src/components/projects/environment-network-words.test.ts` | 04 |
| `egress.blocked`'s place and words | `packages/task-view/src/coverage.ts`'s test, the panel's event renderer test | 04 |
| the scripted run and the live jobs | `e2e/f052-network-rules/`, `proof.yml` | 06 |

**Checks per ticket** (AGENTS.md's table): 01 runs the whole repo's checks for the schema and the protocol; 02 and 03 run typecheck, lint and tests for the packages they touch; 04 the same for `packages/api`, `packages/task-view` and `apps/web`; 05 nothing; 06 the whole repo and the Proof run, dispatched only by the lead on the maintainer's word. No ticket runs `proof.yml` while building.

**Commit messages:** `✨ add network rules to the environment`, `✨ route a box's egress through its rules`, `✨ offer network rules on kubernetes and host`, `✨ edit an environment's network rules`, `📝 document network rules`, `✅ prove network rules on a real box`.

---

## 10. Choices this spec makes

- **One mechanism, the egress proxy, on all three executors**, rather than one mechanism per executor. The research's own conclusion forces it: a proxy is only as strong as the absence of a route around it, and on the one executor that has no route (`docker`) it is exact. Building a second mechanism (a per-box NetworkPolicy on `kubernetes`) would add the chart privilege ADR 0060 removed, a host name it can't express, and a union-of-policies fail-open, for a difference the panel would still have to explain. ADR 0073 records this and its alternatives.
- **The rules are a child table, not JSON on `Environment`.** Services and checks set the pattern: one row per thing, written by its own procedures, with an audit entry per change, and a unique key that makes a duplicate impossible. A JSON array would have made the isolation test and the panel's edit one big write.
- **No rules means no change.** The proxy is started and the variables are set only when the list is non-empty, so no existing environment changes behaviour on upgrade, and the "empty vs off" ambiguity disappears.
- **`NO_PROXY` is computed, never inherited.** A repo variable named `HTTPS_PROXY` is a repo's, not the runner's; the proxy variables are applied before the git guard and after `extraEnv`, and the contract suite checks the order.
- **One event per destination.** A loop that retries a refused host would otherwise fill the Event log; the footer's count and the Event log's one line say as much as a hundred.
- **The `kubernetes` difference is shown, not asserted away.** The probe has an expectation per executor, and the live job asserts that direct egress **works** on `kind`, so the test can't pass by pretending the gap is closed.
