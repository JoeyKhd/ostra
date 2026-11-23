# 05: Core: the Slack channel and its deliveries

Status: ready-for-agent
Builder: core
Features: F-057
Packages: `apps/core` (`notifications/slack.ts`, `notifications/index.ts`, `notifications/deliver.ts`, `core.ts`), `packages/jobs` only if a job name is added
Blocked by: 03, 04
Spec: `../spec.md`, section 4.5; ADR 0050, ADR 0074

## What to build

- **`createSlackChannel(deps)`** in `apps/core/src/notifications/slack.ts`, shaped like `createEmailChannel`:
  - resolves the organization's `active` installation; none → `{ outcome: "skipped", why: "slack-off" }`;
  - resolves the bot token from the secret store, and refreshes it first when it is within `OSTRA_SLACK_TOKEN_REFRESH_MINUTES` of its date (ticket 04's `refreshSlackToken`);
  - matches the member's Slack identity from their account address (`matchSlackIdentity`); no match → `skipped: no-slack-account`; a match → a `MomentNotification` with `slackUserId` and `renderSlackDm`'s words, sent through `SlackNotificationAdapter` built from the token and `OSTRA_SLACK_API_URL`;
  - a `token_expired`/`invalid_auth` answer refreshes once and retries; a second refusal or a refresh refusal is `failed` with words; `retryable` is the same table the other channels use;
  - budget, runner and preview notices use the same loaders and loaders' words as `email.ts` (`loadBudgetNoticeView`, `loadRunnerNoticeView`, `loadPreviewShareNotice`), and skip `closed` when the notice is gone or the person was taken off;
  - a send's `refused` entry for the member is `skipped: no-slack-account`, not a failure.
- **The edit delivery:** `change !== "created"` sends the closing text through `update` with the delivery's `providerMessageId`; `not-found`/`unsupported` → `skipped: nothing-to-edit`.
- **`notify.deliver`** gains `case "slack"`; `NotifyDeps` gains `slack: SlackChannel`; `core.ts` builds it with a `realSlackFactory` (the adapter and the connect kit) and passes it. No `close()` is needed (the adapter is stateless).
- **The token's check:** a 5-minute tick (`slack.token-check`) refreshes any installation within its window and marks a refused one `failed` with words and an audit entry; without rotation it does nothing. No new queue.
- **Logs:** every new record carries IDs (`installationId`, `deliveryId`, `memberId`) and never a token, a code, a state's nonce, an address, a DM's text or a title.

## Done when

- [ ] Tests named for `F-057/c5`: a delivery for a member whose address the fake Slack knows posts one DM to their `D…` channel; one whose address it doesn't is `skipped: no-slack-account` and the other member's still goes.
- [ ] Tests named for `F-057/c3`: no Slack delivery is sent when the member's choice is off or the installation isn't active (`skipped: slack-off`), and the panel's row is still written.
- [ ] Tests named for `F-057/c6`: a second `notify.deliver` of a `sent` delivery sends nothing (the row's state); an answered moment edits the stored message and no new message appears; a gone message is `skipped: nothing-to-edit`.
- [ ] Tests named for `F-057/c7`: a 429 leaves the delivery `pending` with the `Retry-After` and the retry sends it once; a failed Slack delivery records its failure while the panel's and mail's deliveries of the same moment are recorded as theirs; a token expired by the fake is refreshed once and the send succeeds.
- [ ] Tests named for `F-057/c4`: a budget, runner and preview notice each posts the panel's words, and a task title with Slack markup arrives literally.
- [ ] Tests named for `F-057/c2`: no log record of any of these tests carries a token, code, nonce, address, title or DM text.
- [ ] Typecheck, lint and tests for `apps/core` and its direct consumers pass.
- [ ] Committed as `✨ deliver notifications to Slack`.

## Comments
