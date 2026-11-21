# 24: CLI: `ostra preview`

Status: ready-for-agent
Builder: runner
Blocked by: 22, 23
Features: F-143
Packages: `apps/runner` (`cli/`), `docs/` (the CLI's reference page, which `cli-docs-reference.test.ts` checks)
Spec: `../spec.md`, sections 3 (step 9) and 4; ADR 0068 ("`ostra preview`")

## What to build

- **`ostra preview <task> [port] [--local <port>]`:**
  - `<task>` takes a ticket key, an ID or a URL, as `ostra checkout` does;
  - it gets a ticket (ticket 23) with the CLI session, opens `wss://<core>/cli/v1/tunnel?ticket=…`, and speaks HTTP/2 as the client on it;
  - it listens on `127.0.0.1:<local>` only, never on another interface. The local port defaults to the remote's, or the next free one;
  - each accepted TCP connection becomes one `CONNECT` stream;
  - it prints `http://localhost:<port>` and the preview's label, and ends cleanly on Ctrl+C;
  - it reconnects with a new ticket after a dropped connection, up to three times, and says so.
- **No box:** "This task's box isn't running. Start the app? [y/N]", which calls the CLI's start route (ticket 23) and waits for the primary to be ready.
- **Refusals** in the CLI's words: not found, the port isn't one of this task's previews, the runner can't tunnel (HTTP only, or too old), signed out.
- **The help text and the CLI's reference page** gain the command.
- **The glossary's CLI session** line (this spec's commit) says a CLI session can also open a preview.

## Done when

- [ ] Tests named for `F-143`:
  - the command against a fake core: a local HTTP request and a WebSocket carried at once;
  - it listens on loopback only (break-it: listen on `0.0.0.0`, and the case fails);
  - each refusal's words;
  - the reconnect.
- [ ] Live evidence: `ostra preview` against the fixture app on this machine, HMR seen in a browser tab, its log kept in `context/proof/`.
- [ ] `cli-docs-reference.test.ts` passes with the new page.
- [ ] Checks for `apps/runner` pass (spec section 10).
- [ ] Committed as `✨ add ostra preview`.

## Comments
