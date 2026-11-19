# 10: Runner: Claude Code's calls at the key proxy

Status: ready-for-agent
Builder: runner
Blocked by: 06
Features: F-018, F-089
Packages: `apps/runner` (`src/sidecar/key-proxy.ts`)
Spec: `../spec.md`, sections 4 and 6

## What to build

Claude Code posts to `/v1/messages?beta=true`, may call `/v1/messages/count_tokens` and `GET /v1/models` at start, and sends `anthropic-beta` (`research/claude-code-acp.md`, D3). The key proxy:
- passes each through to the provider's base URL with the real key in `x-api-key` and the client's `anthropic-version` and `anthropic-beta` kept;
- records a `count_tokens` call and a `models` call as calls with no tokens, never as an estimate (they hold no usage), so F-089's count stays exact;
- counts the streamed `/v1/messages?beta=true` response's four kinds of token as it does for the plain path.

## Done when

- [ ] Tests named for `F-089` and `F-018`: each of the three paths reaches the stub with the real key and the client's version headers; `count_tokens` and `models` are recorded with zero tokens and no estimate flag; a streamed beta response's usage is counted to the token; the placeholder in `x-api-key` is refused for another task.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ count Claude Code's calls at the key proxy`.

## Comments
