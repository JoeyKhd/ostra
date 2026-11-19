# 10: Runner: Claude Code's calls at the key proxy

Status: ready-for-agent
Builder: runner
Blocked by: 06
Features: F-018, F-089
Packages: `apps/runner` (`src/sidecar/key-proxy.ts`)
Spec: `../spec.md`, sections 4 and 6

## What to build

Claude Code posts to `/v1/messages?beta=true`, may call `/v1/messages/count_tokens`, sends `anthropic-beta`, and at start sends a best-effort `HEAD /api/hello` warm-up probe (`research/claude-code-acp.md`, D3). It calls `GET /v1/models` only with gateway model discovery on (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`), which ostra never sets, so the proxy handles that path but no task is expected to call it. The key proxy:
- passes each through to the provider's base URL with the real key in `x-api-key` and the client's `anthropic-version` and `anthropic-beta` kept;
- records a `count_tokens` call and a `models` call as calls with no tokens, never as an estimate (they hold no usage), so F-089's count stays exact;
- counts the streamed `/v1/messages?beta=true` response's four kinds of token as it does for the plain path;
- answers `HEAD /api/hello` itself (or passes it through) without the real key leaving for any path but the provider's, and never records it as a call, so the warm-up neither fails nor inflates the count;
- matches Claude Code's own usage: for the calls the agent closed, the proxy's four counts equal the counters Claude Code reports over ACP (F-089's "within 2%", checked against the agent's usage for the same response bytes).

## Done when

- [ ] Tests named for `F-089` and `F-018`: each of the three paths reaches the stub with the real key and the client's version headers; `count_tokens` and `models` are recorded with zero tokens and no estimate flag; `HEAD /api/hello` is answered and not recorded; a streamed beta response's usage is counted to the token; the proxy's counts equal the agent's reported usage on the real Claude Code with the stub model (with ticket 07); the placeholder in `x-api-key` is refused for another task.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ count Claude Code's calls at the key proxy`.

## Comments
