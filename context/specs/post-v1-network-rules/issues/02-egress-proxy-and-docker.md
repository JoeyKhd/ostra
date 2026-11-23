# 02: The egress proxy, and the box's only door on `docker`

Status: ready-for-agent
Builder: runner
Blocked by: 01
Features: F-052 (c2, c3, c7)
Packages: `apps/runner` (`src/sidecar/egress-proxy.ts` (new), `src/sidecar/egress-proxy.test.ts` (new), `src/task-host/task-run.ts`), `packages/adapters/adapter-executor-docker` (`src/boxes.ts`, `src/boxes.test.ts`), `packages/adapters/adapter-opencode` (`src/config.ts`, `src/config.test.ts`), `packages/adapter-sdk` (`src/testing/egress-probes.ts`, its test)
Spec: `../spec.md`, sections 5.3 and 5.4; ADR 0073

## What to build

- **The proxy, `apps/runner/src/sidecar/egress-proxy.ts`**, `node:http` and `node:net` only, no new dependency, with the options in section 5.3 and these cases, in order:
  - `CONNECT host:port`: refuse with `403` and the spec's body when the destination matches no rule, or resolves inside `EGRESS_BLOCKED_V4/V6` and is not in `OSTRA_EGRESS_ALLOW`; otherwise open a `node:net` connection, answer `200 Connection Established`, and pipe both ways. TLS is never terminated.
  - An absolute-form HTTP request: the same check, then forward to the origin over a fresh connection, dropping `Proxy-Connection` and `Proxy-Authorization` and passing every other header and the body through, and return the response unchanged (so a plain-HTTP mirror works).
  - Anything else (origin-form with no absolute URI, an `Upgrade` without `CONNECT`, a port not in a rule): the same `403`.
  - Matching: exact host, `*.suffix` at a label boundary (never the bare suffix), and resolved-IP matching for a `cidr` rule; the rule's ports are the only ports it opens.
  - Refusals: no request content echoed, one structured log line `{ taskId, host, port, reason }` only, and `onBlocked` at most once per (host, port) per task (`reason`: `not-listed`, `baseline`, `unresolvable`). Never a path, a query or a header, in the log, the event or the 403's body.
  - The resolver is injectable (`resolve`), so the tests can script answers.
- **Start it only when the environment has rules.** In `task-run.ts`, after the key/git/MCP proxies and before the agent launches: if `taskSpec.environment.networkRules` is non-empty, start the proxy with `{ listenHost, advertiseHost }` and the `allowedAddresses` read from `OSTRA_EGRESS_ALLOW` (which `boxes.ts` now passes into the sidecar's `Env`, from the setting the runner already validates), and add `egressUrl` to `proxies`. With an empty or missing list, start nothing and set no variable. A unit case in `boxes.test.ts` asserts the variable reaches the sidecar's environment and never the agent's.
- **The agent's environment** (`packages/adapters/adapter-opencode/src/config.ts`): `PrepareLaunchInput` gains the proxy URL; `buildAgentEnv` adds `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase spellings **after** `extraEnv` and **before** the git guard, and a `NO_PROXY`/`no_proxy` computed from the model, git and MCP proxy origins plus `localhost,127.0.0.1,::1,sidecar,host.docker.internal`. `allowedEnvNames` gains them, and the agent contract suite's environment case already iterates that list. A repo variable with those names loses.
- **The setup, the checks and the app processes** inherit the same base environment, by construction. Assert it in `task-run`'s own test rather than adding plumbing: the setup job's environment and a check's environment hold the proxy when the rules are non-empty, and none of them when empty.
- **The probes** (`packages/adapter-sdk/src/testing/egress-probes.ts`): the allowlist cases of section 5.4, with the expectation per executor passed in, positive control first and a timeout `inconclusive`, in the file's existing scripted style. Add them to the runner's probe command wiring if the command enumerates cases.

## Done when

- [ ] Tests named for `F-052/c2`: against a real loopback HTTP origin and a raw TCP echo server, an allowlisted `GET` and an allowlisted `CONNECT` succeed and the tunnel carries bytes both ways; another host and an unlisted port get the 403; `*.example.com` matches `a.example.com` and `a.b.example.com` and not `example.com`; a `cidr` rule matches the resolved address; a destination whose answer is loopback/private is refused with `reason: "baseline"` even when a `host` rule names it, and allowed when `OSTRA_EGRESS_ALLOW` holds it (break-it: drop the baseline check and that case fails).
- [ ] Tests named for `F-052/c3`: with rules, the agent's environment holds the three proxy variables in both cases and a `NO_PROXY` naming the model, git and MCP origins and the box's names; a repo variable named `HTTPS_PROXY` doesn't win; the setup job and a check job hold the proxy; with no rules, none of the eight variables (three proxy names and `NO_PROXY`, each in both cases) is set and no proxy is started. (Break-it: move the assignment before `extraEnv` and the override case fails.)
- [ ] Tests named for `F-052/c7`: three refusals to one destination call `onBlocked` once, two destinations call it twice, and the log lines and the 403's body hold neither a path nor a query nor a header (break-it: log `request.url` and the case fails).
- [ ] `egress-probes.test.ts` covers the allowlist cases' verdicts from scripted results, including a failing positive control making the case `inconclusive`.
- [ ] Checks for `apps/runner`, `packages/adapters/adapter-opencode` and `packages/adapter-sdk` pass (typecheck, lint, tests).
- [ ] Committed as `✨ route a box's egress through its rules`.

## Comments
