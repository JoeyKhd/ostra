# 04: Web: the compact thread's words

Status: ready-for-agent
Builder: web
Blocked by: 03
Features: F-151
Packages: `apps/web/messages/en.json`, new `apps/web/src/task/thread/words.ts` (and its test), `context/GLOSSARY.md`
Spec: `../spec.md`, section 5.4; the targets' `parts.md` (every part's copy), `states-*.md`; the README's content fixes 12 and 16

## What to build

Every word milestone 10 adds or changes, in one commit, so the part tickets (09 to 16) render words and never edit `en.json` or build a sentence themselves.

- **The keys,** under the spec's section 5.4 namespaces (`task.run.*`, `task.step.*`, `task.doing.*`, `task.result.*`, `task.ci.*`, `task.footer.*`, `task.tooltip.*`, `task.receipt.*`, `task.divider.*`, `task.needs.*`, `task.status.box.*`), each with its ICU plural, word for word as `parts.md` and the scenes give them.
- **The pure functions** in `words.ts`, typed over ticket 03's items, each with an exhaustive `switch` over its union and the translator passed in:
  - `runLineWords(run)`: the counts joined by `, `, the first capitalized, a shared noun dropped (`Read 2 files, edited 2`), `twice`, `{n} steps:` over 20, and the tail (`1 failed, then passed`, `1 approved by Sam Rivera`, `1 denied by Alex Kim, with a reason`), returned as segments so the part can colour only `failed` and `denied`;
  - `stepWords(step)`: the verb (`Editing` while running), the subject, the result (`✓ exit 0`, `exit 1`, `killed`, `+48 −6` with U+2212), the link (`output ›` / `hide output ›`, …), and the link's accessible name (`Show the output of pnpm test history`);
  - `liveStepWords(live)`, `failureWords(item)`, `noticeWords(item)`, `resultWords(item)`, `receiptWords(…)`, `dividerWords(…)`;
  - `footerFacts(turn, kind)` and `tooltipRows(turn, kind)`: the facts in `parts.md` part 6's order, none of the saved facts for a `review` or `refine` task, `≈` for an estimate, `so far` while open, the clamp as `Max, asked Extra high` with its sentence;
  - `ciLine(ci)` and `checksLine(checks)`: `CI on GitHub: running, 2 of 4 jobs done`, `3 checks passed in the box`;
  - `boxStatusWords(box, now)`: `box idle, stops in {n} min`, `box stopped`, `box released`.
- **Changed strings** (content fix 12): the review screen's `Passed · {n} checks` → `Passed · {n} jobs`, the CI round's `CI failed: {n} checks` → `CI failed: {n} jobs`, and every other place the panel counts the code host's CI as checks (milestone 6's stage words, Home's board sub-state), found by a search of `en.json` and listed under `## Comments`.
- **Kept for now:** milestone 1's `task.tool.*` keys and the top-level `doing.*`; ticket 17 removes what nothing reads.
- **The glossary:** **run** (of steps: a turn's steps between two pieces of its prose, as `parts.md` part 4 defines it; distinct from a review run and a check run, which the glossary already names), **live step**, **result line** and **receipt**; **CI job** beside **check** (whose `_Avoid_` already says "CI" isn't ostra's), saying which is whose and that the panel counts CI in jobs.

## Done when

- [ ] Tests named for `F-151/c2`: `runLineWords` over S1's runs (`Thought for 6s, read 4 files`; `Edited 2 files, ran 2 commands, took a screenshot · 1 failed, then passed`), S3's 23 steps (`23 steps: read 9 files, …`), `searched the code twice`, and an approved and a denied tail.
- [ ] Tests named for `F-151/c3`: `footerFacts` for S4 (`Turn 1 · High · 41.2k in · 6.3k out · 2.1k reasoning · $0.62 so far · not saved yet`), for a review task (no saved fact), and the clamp; `tooltipRows` for S2's turn 4.
- [ ] Tests named for `F-151/c6`: `ciLine` for running, passed, failed and none, all in jobs; `checksLine` for passed and one failing; no string in `en.json` counts CI in checks (a test reads the file).
- [ ] Tests named for `F-151/c9`: `boxStatusWords` for idle (the minutes rounded up), stopped and released.
- [ ] Every key is used by a function or a part's stub (ticket 09), and the message files' check passes.
- [ ] Checks for `apps/web` pass.
- [ ] Committed as `📝 add the compact thread's words`.

## Comments
