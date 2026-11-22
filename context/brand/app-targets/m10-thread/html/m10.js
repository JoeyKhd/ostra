// Milestone 10's thread targets: the thread's parts and the scenes' data, as HTML strings.
// Loaded after `../../m8/html/app-fixture.js` (Tally, the demo app) and `../../m9/html/m9.js`
// (the pictures, thumbnails and file chips). `thread.html?scene=…` mounts a desktop scene,
// `phone.html?scene=…` a phone one, `states.html?sheet=…` a state sheet. All data is demo data.
(() => {
  const { ic, thumb, fchip } = m9;
  // The app at phone width, for the phone capture in turn 2 (S2).
  m9.pictures.appPhone = () => `<div style="position:relative;width:390px;height:844px">${tallyApp({ phone: true })}</div>`;
  m9.sizes.appPhone = [390, 844];

  // ── Small words ────────────────────────────────────────────────────────────
  const mono = (x) => `<span class="mono">${x}</span>`;
  const faint = (x) => `<span class="faint">${x}</span>`;
  const teal = (x) => `<span class="teal">${x}</span>`;
  const dot = (c) => `<span class="dot ${c}"></span>`;
  const av = (x) => `<span class="av">${x}</span>`;
  const add = (n) => `<span class="add">+${n}</span>`;
  const del = (n) => `<span class="del">−${n}</span>`;
  const sep = `<span class="sep">·</span>`;
  // "1 failed, then passed": red only on the word that failed (a failure the turn recovered from).
  const recovered = (n = 1) => `${sep} ${n} <span class="bad">failed</span>, then passed`;

  // ── The thread's parts ─────────────────────────────────────────────────────
  // A member's message: the name and time over a right-aligned bubble; tags after the time.
  const um = (who, time, html, { atts = "", tag = "", auto = false, got = false } = {}) =>
    `<div class="um"><div class="by"><b>${who}</b><span class="mono">${time}</span>${tag ? `<span class="tag">· ${tag}</span>` : ""}</div>${atts ? `<div class="atts">${atts}</div>` : ""}<div class="bubble${auto ? " auto" : ""}${got ? " got" : ""}">${html}</div></div>`;
  const prose = (html) => `<div class="prose">${html}</div>`;
  // One run of steps between the prose: a button that opens it. `at` is the turn's time, on its first line only.
  const fold = (text, { open = false, hover = false, tail = "", at = "", atHover = false, badge = "", id = "" } = {}) =>
    `<div class="fold${open ? " open" : ""}${hover ? " hover" : ""}"${id ? ` id="${id}"` : ""} role="button" aria-expanded="${open}"><span class="tx">${text}${tail ? ` ${tail}` : ""}</span><i data-lucide="chevron-right" class="chev"></i>${badge}${at ? `<span class="at${atHover ? " hover" : ""}"${id ? ` id="${id}-at"` : ""}>${at}</span>` : ""}</div>`;
  // A result the turn left: an icon, one line, and a chevron when it opens in place.
  const result = (icon, html, { chev = true, link = "" } = {}) =>
    `<div class="fold result" role="button">${ic(icon)}<span class="tx">${html}</span>${chev ? `<i data-lucide="chevron-right" class="chev"></i>` : ""}${link ? `<span class="teal" style="margin-left:4px">${link}</span>` : ""}</div>`;
  // The live step: rewritten in place while the turn runs; it becomes the run's line when the run ends.
  const live = (now, meta, { pause = false, need = "" } = {}) =>
    `<div class="livestep" role="button" aria-expanded="false">${pause ? ic("pause") .replace("<i ", '<i class="pause" ') : '<span class="spin"></span>'}<span class="now">${now}</span>${need ? `<span class="need">${need}</span>` : ""}<span class="m">${meta}</span><i data-lucide="chevron-right" class="chev"></i></div>`;
  const step = ({ icon, verb, sub, cls = "p", res = "", go = "", note = "", th = false, spin = false, need = "" }) =>
    `<div class="step${th ? " th" : ""}"><span class="ic">${spin ? '<span class="spin"></span>' : ic(icon)}</span><span class="vb">${verb}</span><span class="sub"><span class="${cls}">${sub}</span>${res}${need ? `<span class="need">${need}</span>` : ""}${note ? `<span class="note">${note}</span>` : ""}${go ? `<span class="go">${go}${ic("chevron-right")}</span>` : ""}</span></div>`;
  const steps = (rows, foot = "") => `<div class="steps">${rows.join("")}${foot}</div>`;
  // Each fact is kept whole when the row wraps on a phone.
  const gfoot = (facts, link = "Event log") => `<div class="gfoot"><span class="tx">${(Array.isArray(facts) ? facts : [facts]).map((f) => `<span class="sg">${f}</span>`).join(" · ")}</span><span class="lk">${link}${ic("chevron-right")}</span></div>`;
  const out = (text) => `<div class="out">${text}</div>`;
  const exitOk = (t) => `<span class="r ok">${ic("check")}exit 0</span><span class="r">· ${t}</span>`;
  const exitBad = (n, t) => `<span class="r bad">exit ${n}</span><span class="r">· ${t}</span>`;
  // A failure the turn didn't recover from: its own line under its run.
  const failed = (subject, word, msg, go = "") =>
    `<div class="failed">${ic("circle-x")}<span class="w">${word}</span>${subject ? `<span class="p">${subject}</span>` : ""}<span class="m">${msg}</span>${go ? `<span class="go">${go}${ic("chevron-right")}</span>` : ""}</div>`;
  const strip = (...shots) => `<div class="strip">${shots.join("")}</div>`;
  const receipt = (html) => `<div class="receipt">${html}</div>`;
  const divider = (html, { day = false } = {}) => `<div class="divider${day ? " day" : ""}"><span class="tx" style="display:inline-flex;align-items:center;gap:8px">${html}</span></div>`;
  // The question (milestone 3's form, the approved m1 copy): choose, then Send answer. Choosing never sends.
  const nyQuestion = ({ q, opts, sel = -1, other = null, driver = true, driverName = "Sam Rivera", agent = "OpenCode" }) =>
    `<div class="ny${driver ? "" : " quiet"}" role="group" aria-label="Needs you"><div class="t">${ic("message-circle-question")}Needs you · question</div><div class="q">${q}</div>
      <div class="opts">${[...opts, "Something else…"].map((o, i) => `<div class="opt${i === sel ? " on" : ""}${driver ? "" : " dis"}"><span class="rd"></span>${o}</div>`).join("")}
      ${other === null ? "" : `<div class="other focus">${other}<span class="caret"></span></div>`}</div>
      <div class="acts">${driver ? `<span class="btn sm amber${sel < 0 ? " dis" : ""}">Send answer</span><span class="foot">${agent} waits for your answer. Only the driver answers questions.</span>` : `<span class="btn sm">Take over to answer</span><span class="foot">${driverName} answers questions while driving.</span>`}</div></div>`;
  const nyPlan = (entries, { agent = "OpenCode" } = {}) =>
    `<div class="ny" role="group" aria-label="Needs you"><div class="t">${ic("list-checks")}Needs you · plan</div>
      <ol class="plist">${entries.map((e, i) => `<li><span class="n">${i + 1}</span><span>${e}</span></li>`).join("")}</ol>
      <div class="acts"><span class="btn sm amber">${ic("check")}Approve plan</span><span class="btn sm">${ic("pencil")}Edit and approve</span><span class="btn sm">Ask for changes to the plan</span></div>
      <div class="foot">Nothing in the repo has changed. ${agent} starts the work from the plan you approve.</div></div>`;
  const pill = (what) => `<div class="jumpband"><span class="jump">${dot("amber")}Needs you · ${what}${ic("arrow-down")}</span></div>`;
  const prCard = ({ n, title, a, d, ci }) =>
    `<div class="pr"><div class="r1">${ic("git-pull-request")}<span class="num">#${n}</span><span class="tt">${title}</span>${add(a)} ${del(d)}</div><div class="r2">${ci}</div></div>`;
  const composer = ({ ph = "Message OpenCode…", hint = "Send reaches OpenCode at its next step.", model = "Claude Sonnet 5.5", effort = "High", interrupt = false } = {}) =>
    `<div class="cbox"><span class="clip" title="Attach files">${ic("paperclip")}</span><span class="fld">${ph}</span><span class="go">${interrupt ? `<span class="intb dis" title="Interrupt and send (⌥↵)">${ic("pause")}Interrupt and send</span>` : ""}<span class="sendb dis" title="Send (↵)">${ic("arrow-up")}</span></span></div>
     <div class="cunder"><span>${hint}</span><span class="r" title="The next turn's model and effort">${model}<span class="sep">·</span>${effort}${ic("chevron-down")}</span></div>`;
  const ttip = (rows) => `<div class="ttip" id="ttip">${rows}</div>`;
  const kv = (k, v) => `<div class="k"><span>${k}</span><span>${v}</span></div>`;
  const prop = (k, v) => `<div class="prop"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const group = (title, rows, n = "") => `<div class="group"><h5>${title}${n ? `<span class="n">${n}</span>` : ""}</h5>${rows.join("")}</div>`;

  // ── CALC-192, a prompt task. Sam Rivera drives, and is the one viewing. ────
  const s1Ask = `<p>Add a history panel next to the keypad: the last 50 results, newest first, with a <b>Use</b> button that puts a result back in the display. Dana's mock and the spec are attached.</p>`;
  const s1Atts = thumb("mock", 84, { label: "history-panel-mock.png" }) + fchip("history-panel-spec.docx", "DOCX · 48 KB");
  const s1Plan = "<p>The results only live in the display's state today, so I'll add a small store that keeps the last 50 and a panel beside the keypad that reads from it, as in Dana's mock.</p>";
  const s1Question = { q: "Should <b>Use</b> replace what's in the display, or add the result to the expression being typed?", opts: ["Replace the display", "Add it to the expression"] };

  // The second run, opened (S4): each step, outputs and diffs still folded.
  const s1Run2 = steps([
    step({ icon: "pencil", verb: "Edited", sub: "src/history/store.ts", res: add(48), go: "diff" }),
    step({ icon: "pencil", verb: "Edited", sub: "src/history/panel.tsx", res: add(118) + del(6), go: "diff" }),
    step({ icon: "terminal", verb: "Ran", sub: "pnpm test history", res: exitBad(1, "4.1 s"), go: "output" }),
    step({ icon: "brain", verb: "Thought", sub: "The empty history renders nothing; Dana's mock has an empty state for it.", cls: "x", go: "show", th: true }),
    step({ icon: "pencil", verb: "Edited", sub: "src/history/panel.tsx", res: add(12) + del(2), go: "diff" }),
    step({ icon: "terminal", verb: "Ran", sub: "pnpm test history", res: exitOk("3.8 s"), go: "output" }),
    step({ icon: "image", verb: "Captured", sub: `a screenshot of ${mono("/history")}`, cls: "s", res: `<span class="r">web :5173</span>` }),
  ], gfoot(["Turn 1", "High", "41.2k in", "6.3k out", "2.1k reasoning", "$0.62 so far", "not saved yet"]));
  // The first run, opened (S6, phone): the thought and every read on one row.
  const s1Run1 = steps([
    step({ icon: "brain", verb: "Thought", sub: "The display keeps one result; there's nowhere to keep 50 yet.", cls: "x", go: "show", th: true }),
    step({ icon: "file-text", verb: "Read", sub: `state.ts, keypad.tsx, App.tsx, package.json`, res: `<span class="r">4 files</span>` }),
  ], gfoot(["Turn 1", "High", "41.2k in", "6.3k out", "2.1k reasoning", "$0.62 so far"]));

  const s1Thread = ({ open = false } = {}) => `
    ${um("Sam Rivera", "14:02", s1Ask, { atts: s1Atts })}
    ${fold("Thought for 6s, read 4 files", { at: "14:02" })}
    ${prose(s1Plan)}
    ${fold("Edited 2 files, ran 2 commands, took a screenshot", { tail: recovered(), open, id: "run2" })}
    ${open ? s1Run2 : ""}
    ${strip(thumb("app", 110, { cap: "1280 · /history" }))}
    ${prose("<p>The panel is in and <code>pnpm test history</code> passes. The first run failed on an empty history, so the panel now shows the mock's empty state. The screenshot is the app at 1280 wide.</p><p>One thing the mock doesn't settle:</p>")}
    ${nyQuestion(s1Question)}`;

  // The same turn four minutes in, the second test run still going.
  const s1WorkingThread = () => `
    ${um("Sam Rivera", "14:02", s1Ask, { atts: s1Atts })}
    ${fold("Thought for 6s, read 4 files", { at: "14:02" })}
    ${prose(s1Plan)}
    ${live(`Running ${mono("pnpm test history")}`, `${sep} 8 steps done, 1 <span class="bad">failed</span> ${sep} ${mono("3:52")}`)}`;

  // ── S2: three turns later. PR #483 is open; CI runs on GitHub. ────────────
  const s2Thread = () => `
    ${prose("<p>One thing the mock doesn't settle:</p>")}
    ${receipt(`${ic("check")}<span>Sam Rivera answered <span class="v">Replace the display</span></span>${mono("14:09")}`)}
    ${fold("Edited 1 file, ran 1 command")}
    ${prose("<p><b>Use</b> now replaces the display, and a test covers it.</p>")}
    ${um("Sam Rivera", "14:31", "<p>On phones, keep the panel closed behind a History button in the header.</p>")}
    ${fold("Read 2 files, edited 2, ran 2 commands, took a screenshot", { at: "14:31" })}
    ${strip(thumb("appPhone", 110, { cap: "390 · /history" }))}
    ${prose("<p>On phones the panel is now a sheet that opens from a <b>History</b> button in the header, so the keypad keeps the full height.</p>")}
    ${um("Sam Rivera", "14:37", "<p>Set the expressions in the mono font, like the display.</p>")}
    ${fold("Edited 1 file, ran 1 command", { at: "14:37" })}
    ${prose("<p>The expressions are in Plex Mono now, at the display's size.</p>")}
    ${um("Sam Rivera", "14:44", "<p>Looks right. Open the PR.</p>")}
    ${fold("Ran 2 commands", { at: "14:44", atHover: true, id: "t4" })}
    ${prose("<p>Done. The pull request adds the store, the panel and 14 tests, and the whole suite passes:</p><ul><li><b>Desktop:</b> the panel sits beside the keypad, newest result first.</li><li><b>Phones:</b> a sheet behind the <b>History</b> button.</li><li><b>Use:</b> replaces the display, as you chose.</li></ul>")}
    ${result("git-commit-horizontal", `Pushed ${mono("ostra/calc-192-history-panel")} ${sep} 3 checks passed in the box`)}
    ${prCard({ n: 483, title: "Add a history panel", a: 214, d: 18, ci: `<span class="spin"></span>CI on GitHub: running, 2 of 4 jobs done<span class="faint">· then the AI review</span>` })}`;
  const s2Tip = ttip(`<div class="h">Turn 4 · 14:44 to 14:47</div>${kv("Effort", "High")}${kv("Tokens", mono("22.4k in · 3.8k out"))}${kv("Reasoning", mono("1.1k"))}${kv("Spend", mono("$0.31"))}${kv("Saved", `archive ${mono("193 kB")}`)}`);

  // ── S3: the AI review of PR #483, round 2 of 3. Two turns; the second has 23 steps. ──
  const s3Thread = () => `
    ${um("ostra", "15:20", `<p><b>AI review of PR #483</b>, round 2 of 3</p><div class="mt2"><span class="mono">3</span> files, <span class="mono">+203 −6</span> · the PR's commits, CALC-192 and its criteria</div><span class="lk">What the agent got${ic("chevron-right")}</span>`, { auto: true, tag: "automatic" })}
    ${fold("Read 14 files, ran 5 commands, searched the code 3 times", { at: "15:20" })}
    ${prose("<p>Round 2 on <code>4be21c0</code>: round 1's blocking finding is fixed, and a test covers it.</p>")}
    ${result("message-square-text", `Review posted on ${teal("PR #483")} ${sep} nothing blocking, 1 nit`, { chev: false, link: "Open the review" })}
    ${um("Sam Rivera", "15:31", "<p>Web search works in this box now. Check the README's claims against the spec, then confirm the review.</p>")}
    ${fold("23 steps: read 9 files, ran 8 commands, searched the web 4 times, used 2 tools", { at: "15:31" })}
    ${failed("finance.acme.dev/rounding", "Fetch failed", "· 403 Forbidden, not retried", "details")}
    ${prose(`<p>Web search is on now, so I checked the README's claims against the spec:</p>
      <ul>
        <li><b>Rounding:</b> results round half up to 10 digits. <code>formatResult</code> does that, and the spec agrees.</li>
        <li><b>History cap:</b> 50 results, newest first, as in <code>store.ts</code> and its tests.</li>
        <li><b>Keyboard:</b> the README says Enter reuses the selected result. The panel doesn't handle Enter yet.</li>
      </ul>
      <p><b>Outcome:</b> nothing blocking. One nit at <code>README.md:41</code>: handle Enter in the panel, or drop the sentence. Finance's rounding page answered 403, so the rounding check rests on <code>docs/rounding.md</code>.</p>`)}
    ${result("message-square-text", `Review on ${teal("PR #483")} confirmed ${sep} already posted this round, unchanged`, { chev: false, link: "Open the review" })}`;

  // ── S5: plan first, CALC-196 from Linear. Alex Kim drives and is viewing. ──
  const s5Ticket = () => um("Priya Shah", "13:58", `
        <div class="src">${ic("ticket")}<span class="mono">CALC-196</span>from Linear · what the agent got</div>
        <div class="tt">Add keyboard shortcuts to the keypad</div>
        <p>Power users want to type sums without the mouse: digits and operators from the keyboard, Enter for equals, Esc to clear, and ⌘Z to undo the last key.</p>
        <div class="gmore">${ic("paperclip")}1 image · 2 comments ${sep} <span class="teal">Show it all${ic("chevron-right")}</span></div>`, { got: true });
  const planEntries = [
    "Add <code>src/keys/shortcuts.ts</code>: a map from keys to the keypad's actions",
    "Listen on the window in <code>App.tsx</code>, ignoring keys typed into inputs",
    "Enter is equals, Esc clears, Backspace deletes the last key",
    "⌘Z and Ctrl+Z undo the last key, through the store's key history",
    "Show each key's shortcut in its tooltip",
    "Tests in <code>src/keys/shortcuts.test.ts</code>",
  ];
  const planMarker = divider(`${ic("list-checks")}<span>Plan first: OpenCode reads the code and proposes a plan. It can't edit files or run commands.</span>`);
  const planTurn = () => `
    ${fold("Read 5 files, searched the code twice", { at: "13:58" })}
    ${prose("<p>Keys reach the app only through the keypad's buttons today, and the store already records every key press, so undo can reuse it. Here's the plan:</p>")}`;
  const s5Plan = () => `${s5Ticket()}${planMarker}${planTurn()}${nyPlan(planEntries)}`;
  const s5Approved = () => `
    ${s5Ticket()}${planMarker}${planTurn()}
    ${receipt(`${ic("check")}<span>Plan approved by Alex Kim, with edits</span>${mono("14:09")}<span class="teal">Show the plan${ic("chevron-right")}</span>`)}
    ${divider(`${ic("play")}<span>OpenCode works from the approved plan. Plan mode is off.</span>`)}
    ${fold("Read 2 files", { at: "14:09" })}
    ${prose("<p>Starting with the key map, then the listener in <code>App.tsx</code>.</p>")}
    ${live(`Editing ${mono("src/keys/shortcuts.ts")}`, `${sep} Plan step 1 of 6: Add ${mono("src/keys/shortcuts.ts")} ${sep} 3 steps done ${sep} ${mono("0:42")}`)}`;

  // ── The page around each scene: header, top bar, properties, the open live row. ──
  const driverSR = `${av("SR")}Sam Rivera<span class="faint">· you</span>`;
  const props192 = (status, extra = []) => [
    group("Properties", [prop("Status", status), prop("Driver", driverSR), prop("Agent", "OpenCode"), prop("Model", "Claude Sonnet 5.5"), prop("Effort", "High"), prop("Runner", mono("build-fleet-03"))]),
    ...extra,
  ].join("");
  const seg = `<span class="seg"><span>${ic("app-window")} Preview</span><span class="on">${ic("panel-right")} Properties</span></span><span class="ib">${ic("link")}</span>`;
  const barRun = `${seg}<span class="btn sm">${ic("square-terminal")} Take it local</span><span class="btn sm">${ic("square")} Stop</span>`;
  const barIdle = (pr) => `${seg}${pr ? `<span class="btn sm">${ic("git-pull-request")} PR #483</span>` : ""}<span class="btn sm">${ic("square-terminal")} Take it local</span>`;
  const spend = (x) => `${mono(x)}<span class="muted" style="margin-left:-2px">of $25.00</span>`;
  const s1Props = (status, { working = false } = {}) => props192(status, [
    group("Usage", [prop("Tokens", mono(working ? "28.9k in · 4.1k out" : "41.2k in · 6.3k out")), prop("Reasoning", mono(working ? "1.5k" : "2.1k")), prop("Spend", spend(working ? "$0.41" : "$0.62")), prop("Time", mono(working ? "4 min" : "12 min"))]),
    group("Code", [prop("Repo", mono("acme/calculator-web")), prop("Branch", mono("ostra/calc-192-history-panel")), prop("PR", faint("None yet"))]),
    group("Session", [prop("Box", working ? "Running" : "Running · waits on you"), prop("Saved work", faint("Not yet: the turn is open"))]),
    group("Attachments", [prop("From people", "1 image · 1 file"), prop("Captured", working ? faint("None yet") : "1 screenshot")]),
  ]);

  const scenes = {
    s1: () => ({
      key: "CALC-192 · from a prompt", title: "Add a history panel", viewer: "SR",
      status: `<span class="st">${dot("amber")}Needs you · question</span><span class="sep">·</span><span class="muted">Started 12 min ago on <span class="mono">build-fleet-03</span></span>`,
      tabs: [["Activity", ""], ["Changes", "2"], ["Checks", ""], ["Event log", "41"]],
      bar: barRun, thread: s1Thread(),
      composer: composer({ ph: "Reply to OpenCode…", hint: "Send reaches OpenCode after your answer." }),
      props: s1Props(`${dot("amber")}Needs you · question`),
      live: { key: "CALC-192", doing: `CALC-192 · <span class="amber-t">Needs you · question</span>`, dot: "amber" },
    }),
    "s1-working": () => ({
      key: "CALC-192 · from a prompt", title: "Add a history panel", viewer: "SR",
      status: `<span class="st">${dot("teal")}Running</span><span class="sep">·</span><span class="muted">Running <span class="mono">pnpm test history</span></span><span class="sep">·</span><span class="muted">Started 4 min ago on <span class="mono">build-fleet-03</span></span>`,
      tabs: [["Activity", ""], ["Changes", "2"], ["Checks", ""], ["Event log", "33"]],
      bar: barRun, thread: s1WorkingThread(), bottom: true,
      composer: composer({ interrupt: true, hint: "Send reaches OpenCode at its next step. Interrupt and send stops the turn first." }),
      props: s1Props(`${dot("teal")}Running`, { working: true }),
      live: { key: "CALC-192", doing: "CALC-192 · Running pnpm test history", dot: "teal" },
    }),
    s2: () => ({
      key: "CALC-192 · from a prompt", title: "Add a history panel", viewer: "SR",
      status: `<span class="st">${dot("green")}In review · CI running</span><span class="sep">·</span><span class="muted">PR #483</span><span class="sep">·</span><span class="muted">box idle, stops in 11 min</span>`,
      tabs: [["Activity", ""], ["Changes", "6"], ["Checks", "", '<span class="spin" title="CI running on GitHub"></span>'], ["Event log", "186"]],
      bar: barIdle(true), thread: s2Thread(),
      composer: composer({ ph: "Message OpenCode…", hint: "The box is idle. Send starts the next turn in it." }),
      props: props192(`${dot("green")}In review · CI running`, [
        group("Usage", [prop("Tokens", mono("168k in · 24.1k out")), prop("Reasoning", mono("6.2k")), prop("Spend", spend("$2.14")), prop("Time", mono("48 min"))]),
        group("Code", [prop("Repo", mono("acme/calculator-web")), prop("Branch", mono("ostra/calc-192-history-panel")), prop("PR", `<span class="teal">#483</span><span class="muted">· open</span>`), prop("Checks", `<span class="ck">${ic("circle-check")}</span>3 of 3 passed<span class="faint">· in the box</span>`), prop("CI", `<span class="spin"></span>Running<span class="faint">· 2 of 4 jobs</span>`)]),
        group("Session", [prop("Box", `Idle<span class="faint">· stops in 11 min</span>`), prop("Saved work", `After turn 4<span class="faint mono">· 193 kB</span>`), prop("Turns", mono("4"))]),
      ]),
      live: { key: "CALC-192", doing: "CALC-192 · In review · PR #483", dot: "green" },
      after: () => {
        // The pointer rests on turn 4's time: its tooltip holds the turn's numbers.
        const at = document.getElementById("t4-at");
        if (at === null) return;
        const r = at.getBoundingClientRect();
        document.querySelector(".app").insertAdjacentHTML("beforeend", s2Tip.replace('class="ttip"', `class="ttip" style="left:${Math.round(r.left - 10)}px;top:${Math.round(r.top - 150)}px"`) + `<svg class="pointer" viewBox="0 0 17 22" style="left:${Math.round(r.left + 14)}px;top:${Math.round(r.top + 9)}px"><path d="M1.5 1.5v16.2l4.1-3.9 2.6 6.2 2.9-1.2-2.6-6.1h5.7z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>`);
      },
    }),
    s3: () => ({
      key: "CALC-192 · AI review", title: "Review of PR #483", crumb: "Review of PR #483",
      status: `<span class="st">${dot("green")}Done</span><span class="sep">·</span><span class="muted">round 2 of 3: nothing blocking, 1 nit</span><span class="sep">·</span><span class="muted">box released</span>`,
      tabs: [["Activity", ""], ["Event log", "237"]],
      bar: `<span class="ib">${ic("link")}</span><span class="btn sm on">${ic("panel-right")} Properties</span><span class="btn sm">${ic("arrow-up-right")} Open the code task</span><span class="btn sm">${ic("git-pull-request")} PR #483</span>`,
      thread: s3Thread(),
      composer: composer({ ph: "Message OpenCode to reopen the review…", hint: "Send reopens the review on a fresh box.", effort: "Max" }),
      props: [
        group("Properties", [prop("Status", `${dot("green")}Done`), prop("Kind", "AI review"), prop("Reviews", `<span class="teal">PR #483</span><span class="muted">· CALC-192</span>`), prop("Round", `${mono("2")}<span class="muted">of 3</span>`), prop("Agent", "OpenCode"), prop("Model", "Claude Sonnet 5.5"), prop("Effort", "Max"), prop("Runner", mono("build-fleet-03"))]),
        group("Result", [prop("Blocking", "None"), prop("Nits", mono("1")), prop("Review", `<span class="teal">Open the review</span>`)]),
        group("Usage", [prop("Tokens", mono("61.0k in · 9.7k out")), prop("Reasoning", mono("4.4k")), prop("Spend", mono("$0.74")), prop("Time", mono("9 min"))]),
      ].join(""),
      live: null,
    }),
    s5: () => ({
      key: "CALC-196 · from Linear", title: "Add keyboard shortcuts to the keypad",
      status: `<span class="st">${dot("amber")}Needs you · plan</span><span class="sep">·</span><span class="muted">Started 6 min ago on <span class="mono">build-fleet-07</span></span>`,
      tabs: [["Activity", ""], ["Changes", ""], ["Checks", ""], ["Event log", "23"]],
      bar: barRun, thread: s5Plan(),
      composer: composer({ ph: "Ask for changes to the plan…", hint: "Send asks OpenCode for another plan. To start the work, approve the plan." }),
      props: [
        group("Properties", [prop("Status", `${dot("amber")}Needs you · plan`), prop("Driver", `${av("AK")}Alex Kim<span class="faint">· you</span>`), prop("Agent", "OpenCode"), prop("Model", "Claude Sonnet 5.5"), prop("Profile", "Careful"), prop("Effort", "High"), prop("Runner", mono("build-fleet-07"))]),
        group("Plan", [prop("State", "Proposed · turn 1"), prop("Steps", mono("6"))]),
        group("Ticket", [prop("Key", `<span class="teal mono">CALC-196</span>`), prop("Tracker", "Linear · In Progress")]),
        group("Code", [prop("Repo", mono("acme/calculator-web")), prop("PR", faint("None yet"))]),
      ].join(""),
      live: { key: "CALC-161", title: "Add keyboard shortcuts", doing: `CALC-196 · <span class="amber-t">Needs you · plan</span>`, dot: "amber" },
    }),
    "s5-approved": () => ({
      key: "CALC-196 · from Linear", title: "Add keyboard shortcuts to the keypad",
      status: `<span class="st">${dot("teal")}Running</span><span class="sep">·</span><span class="muted">Editing <span class="mono">shortcuts.ts</span></span><span class="sep">·</span><span class="muted">Started 8 min ago on <span class="mono">build-fleet-07</span></span>`,
      tabs: [["Activity", ""], ["Changes", "1"], ["Checks", ""], ["Event log", "31"]],
      bar: barRun, thread: s5Approved(), bottom: true,
      composer: composer({ interrupt: true, hint: "Send reaches OpenCode at its next step. Interrupt and send stops the turn first." }),
      props: [
        group("Properties", [prop("Status", `${dot("teal")}Running`), prop("Driver", `${av("AK")}Alex Kim<span class="faint">· you</span>`), prop("Agent", "OpenCode"), prop("Model", "Claude Sonnet 5.5"), prop("Profile", "Careful"), prop("Effort", "High"), prop("Runner", mono("build-fleet-07"))]),
        group("Plan", [prop("State", "Approved · edited"), prop("Progress", `${mono("Step 1")}<span class="muted">of 6</span>`)]),
        group("Ticket", [prop("Key", `<span class="teal mono">CALC-196</span>`), prop("Tracker", "Linear · In Progress")]),
        group("Code", [prop("Repo", mono("acme/calculator-web")), prop("Branch", mono("ostra/calc-196-keyboard-shortcuts")), prop("PR", faint("None yet"))]),
      ].join(""),
      live: { key: "CALC-161", title: "Add keyboard shortcuts", doing: "CALC-196 · Editing shortcuts.ts", dot: "teal" },
    }),
  };
  // S4: S1 with its second run opened, scrolled up to it: the question is below, so the pill shows.
  scenes.s4 = () => ({
    ...scenes.s1(), thread: s1Thread({ open: true }), pill: "question",
    scrollTo: (chat) => {
      const run = document.getElementById("run2");
      chat.scrollTop = run.offsetTop - 214;
    },
  });

  // Patch the project panel's live row for the open task (the shell draws a fixed list).
  const patchLive = (live) => {
    for (const row of document.querySelectorAll(".live")) row.classList.remove("on");
    if (live === null) return;
    const row = [...document.querySelectorAll(".ctx .live")].find((r) => r.querySelector(".d").textContent.includes(live.key));
    if (!row) return;
    row.classList.add("on");
    if (live.title) row.querySelector(".t").textContent = live.title;
    row.querySelector(".d").innerHTML = live.doing;
    row.querySelector(".st").innerHTML = `<span class="dot ${live.dot}"></span>`;
  };

  const mount = (name) => {
    const s = scenes[name]();
    document.getElementById("bar-right").innerHTML = s.bar;
    document.getElementById("crumb").textContent = s.crumb ?? s.key.split(" ")[0];
    document.getElementById("content").innerHTML = `
      <div class="page">
        <div class="key">${s.key}</div>
        <h1>${s.title}</h1>
        <p class="doing">${s.status}</p>
        <div class="tabs">${s.tabs.map(([t, n, extra], i) => `<span class="tab${i === 0 ? " on" : ""}">${t}${n ? ` <span class="n">${n}</span>` : ""}${extra ?? ""}</span>`).join("")}</div>
        <div class="chatwrap"><div class="chat"><div class="col">${s.thread}</div></div>${s.pill ? pill(s.pill) : ""}</div>
        <div class="dockcol">${s.composer}</div>
      </div>
      <aside class="props">${s.props}</aside>`;
    window.addEventListener("load", () => {
      setTimeout(() => {
        patchLive(s.live ?? null);
        if (s.viewer) for (const me of document.querySelectorAll(".rail .me")) me.textContent = s.viewer;
        const chat = document.querySelector(".chat");
        chat.scrollTop = chat.scrollHeight;
        if (s.scrollTo) s.scrollTo(chat);
        if (s.after) s.after();
        lucide.createIcons();
        document.body.dataset.settled = "1";
      }, 0);
    });
  };

  window.m10 = {
    scenes, mount, patchLive,
    parts: { mono, faint, teal, dot, av, add, del, sep, recovered, um, prose, fold, result, live, step, steps, gfoot, out, exitOk, exitBad, failed, strip, receipt, divider, nyQuestion, nyPlan, pill, prCard, composer, ttip, kv, prop, group },
    data: { s1Ask, s1Atts, s1Plan, s1Question, s1Run1, s1Run2, s1Thread, s3Thread, planEntries },
  };
})();
