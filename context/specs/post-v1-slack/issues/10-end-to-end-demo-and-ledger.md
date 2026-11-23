# 10: The end-to-end demo and the ledger

Status: ready-for-agent
Builder: core (lead)
Features: F-057
Packages: `e2e/post-v1-slack` (new), `context/specs/post-v1-slack/demo.md` (new), `context/features.md` (the row's status only)
Blocked by: 01 to 08; 09's workspace for the manual run
Spec: `../spec.md`, section 3

## What to build

- **The scripted run** (`pnpm e2e:slack`, `e2e/post-v1-slack/`): every step of spec section 3 that a person needn't do, on the `host` executor, with ticket 02's fake Slack at `OSTRA_SLACK_API_URL` and the dev server at `OSTRA_PUBLIC_URL`, in two worlds (the demo organization and a second one), as milestone 11's demo does:
  1. Slack off, the column disabled and the note;
  2. the install through the fake's authorize page, with the wrong state, wrong secret and refused code cases;
  3. the test DM;
  4. the choices, including an unmatched member;
  5. one question's DM to two members and none to the unmatched one;
  6. the answer's edit in place, with no new message;
  7. three moments and a fake 429 with the `Retry-After`, then one delivery;
  8. disconnect: no further DM, no `slack-*` secret left, the column disabled with choices kept;
  9. the second world: Slack off, the first organization's rows invisible.
- **`demo.md`** next to the spec: each step, what the fake or the real workspace showed, and the commit the run used.
- **The manual run, once:** the same steps against the maintainer's `ostra-test` workspace and the app ticket 09 makes, with the real client credentials from `~/.config/ostra-dev/slack.env`. Nothing is printed, logged or committed; the run records what happened in words.
- **The ledger:** after both runs pass, set F-057's status to `done` in `context/features.md`, with the date and a note naming `demo.md` and the manual run. If the manual run fails, the row stays `building` and the ticket stays open with the failure in its comments.

## Done when

- [ ] The scripted run's nine steps pass end to end, and each records the fake's store, the delivery rows and the page's state it observed (a failing step fails the spec); it exercises c1 to c8's paths through the real code.
- [ ] Tests named for `F-057/c1` to `c8`: every condition's test named with its key passes in CI on the commit the demo used.
- [ ] `F-057/c9`: the manual run on the maintainer's workspace passes (the only evidence c9 can have), and its outcome is recorded.
- [ ] The ledger row is `done` with the date and the note, or the ticket says in words what the manual run refused and stays open.
- [ ] The e2e spec runs locally before the push; no secret, token, address or DM text is in the repository or the logs.
- [ ] Committed as `✨ run Slack's end-to-end demo`.

## Comments
