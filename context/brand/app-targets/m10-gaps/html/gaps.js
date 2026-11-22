// The four ledger gaps' parts as HTML (../README.md), shared by the desktop pages, the boards of
// states and the phone page. Each builder returns markup drawn at the build's sizes (gaps.css).
// All data is demo data: Acme Corp, calculator, CALC-…, Sam Rivera, Alex Kim.
window.G = (() => {
  const ic = (name, cls = "") => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ""}></i>`;
  const m = (t) => `<span class="mono">${t}</span>`;
  const logo = (vendor) => (vendor === null ? ic("server") : `<img class="vlogo" alt="" src="https://models.dev/logos/${vendor}.svg">`);

  // ── 1. Boards: the attached rows and "Make a ticket for every prompt task" ──────────────
  const boards = [
    { name: "Calculator", key: "CALC", open: 38, act: `<span class="dot green"></span>Last event ${m("2m ago")}` },
    { name: "Web platform", key: "WEB", open: 12, act: `<span class="dot grey"></span>Polled ${m("40s ago")}` },
  ];
  const attachedRows = ({ selected = "CALC", admin = true, list = boards } = {}) => `
    <div class="brows">${list.map((b) => `
      <div class="brow${b.key === selected ? " on" : ""}">${ic("square-kanban")}
        <span class="nm">${b.name}</span><span class="ky">${b.key}</span>
        <span class="tk">${m(b.open)} open tickets</span><span class="act">${b.act}</span>
        <span class="end2">${admin ? '<span class="btn xs ghost">Detach</span>' : ""}</span>
      </div>`).join("")}
    </div>`;
  const attachLine = () => `
    <div class="attachl">Attach a team <span class="select" style="width:260px">Mobile <span class="mono">· MOB</span>${ic("chevron-down", "chev")}</span><span class="btn sm">Attach</span></div>`;

  const explain = {
    on: (board) => `Each task a member starts from a prompt gets a ticket on <b>${board}</b> as it starts. Refine tasks make theirs from their draft.`,
    off: () => `Off: a prompt task makes no ticket. A member can still use <b>Create ticket</b> on one.`,
    none: () => `A ticket needs a board. Attach a team above, then turn it on.`,
    paused: (board) => `On, but the Linear connection isn't active, so prompt tasks get no ticket on <b>${board}</b> until it is. <span class="teal">Reconnect Linear →</span>`,
  };
  /** The setting's row. `state`: on | off | none | paused | ro-on | ro-off. `boards`: how many are attached. */
  const promptSetting = ({ state = "on", many = true, board = "Calculator", key = "CALC", open = false } = {}) => {
    if (state === "ro-on" || state === "ro-off") {
      return `<div class="pset ro">
        <span class="sw${state === "ro-on" ? " on" : ""} dis" aria-hidden="true"></span>
        <div><div class="lb">Make a ticket for every prompt task</div><div class="ex">${state === "ro-on" ? explain.on(board) : explain.off()}</div></div>
        ${state === "ro-on" && many ? `<span></span><div class="pick"><span class="pl">Board</span><span class="val">${ic("square-kanban")}${board} <span class="mono">· ${key}</span></span></div>` : ""}
      </div>`;
    }
    const on = state === "on" || state === "paused";
    const sw = `<span class="sw${on ? " on" : ""}${state === "none" ? " dis" : ""}" role="switch" aria-checked="${on}"></span>`;
    const pick = on && many ? `<div class="pick"><span class="pl">Board</span><span class="select${open ? " open" : ""}${state === "paused" ? " dis" : ""}">${ic("square-kanban")}${board} <span class="mono">· ${key}</span>${ic("chevron-down", "chev")}</span></div>` : "";
    return `<div class="pset${state === "none" ? " dis" : ""}">${sw}
      <div><div class="lb">Make a ticket for every prompt task</div><div class="ex">${explain[state](board)}</div>${pick}</div>
    </div>`;
  };
  const boardMenu = (style) => `
    <div class="menu" style="${style}">
      <div class="mi on">${ic("square-kanban")}Calculator <span class="mono">· CALC</span><span class="ck">${ic("check", "i14")}</span></div>
      <div class="mi">${ic("square-kanban")}Web platform <span class="mono">· WEB</span></div>
    </div>`;

  const mapping = () => `
    <div class="mrows">
      <div class="mrow"><div><div class="n">Open</div><div class="h">Tickets the Inbox shows</div></div>
        <div class="ctl" style="padding-left:5px"><span class="chipst">${ic("circle-dashed", "i13")}Triage<span class="x">${ic("x")}</span></span><span class="chipst">${ic("circle", "i13")}Backlog<span class="x">${ic("x")}</span></span><span class="chipst">${ic("circle", "i13")}Todo<span class="x">${ic("x")}</span></span>${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Started</div><div class="h">When the task starts</div></div><div class="ctl">${ic("contrast")}In Progress${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">In review</div><div class="h">At the task's first PR</div></div><div class="ctl">${ic("contrast")}In Review${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Done</div><div class="h">When the last PR merges</div></div><div class="ctl">${ic("circle-check")}Done${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Done is moved by</div></div><div style="display:flex;align-items:center;gap:16px"><span class="seg"><span class="on">Linear's GitHub integration</span><span>ostra</span></span><span style="display:inline-flex;align-items:center;gap:7px;font-size:14px"><span class="green" style="display:inline-flex">${ic("circle-check", "i14")}</span>Integration installed</span></div></div>
      <div class="mrow"><div><div class="n">Magic word</div><div class="h">In each PR's body</div></div><div style="display:flex;align-items:center;gap:16px"><span class="seg"><span class="on" style="padding:0 18px">Closes</span><span style="padding:0 18px">Refs</span></span><span class="mono faint" style="font-size:13.5px">Closes CALC-142</span></div></div>
    </div>
    <div style="margin-top:22px">
      <p class="sec-note" style="margin-bottom:6px">What the next task does on the ticket</p>
      ${[["When the task starts, ostra moves it to ", "In Progress", " and comments once with a link to the task."], ["At the first PR, ostra moves it to ", "In Review", " and links the PR."], ["When the last PR merges, Linear's GitHub integration moves it to ", "Done", ". ostra doesn't."]]
        .map(([a, b, c], i) => `<div style="display:grid;grid-template-columns:28px 1fr;font-size:14px;color:var(--muted);line-height:26px"><span class="mono faint">${i + 1}</span><span>${a}<b style="font-weight:500;color:var(--text)">${b}</b>${c}</span></div>`).join("")}
    </div>`;

  const boardPanel = ({ promptHere = true } = {}) => `
    <div class="group">
      <h5>Board</h5>
      <div class="prop"><span class="k">Team</span><span class="v">Calculator</span></div>
      <div class="prop"><span class="k">Key</span><span class="v mono">CALC</span></div>
      <div class="prop"><span class="k">Tickets</span><span class="v"><span class="mono">38</span> open</span></div>
      <div class="prop"><span class="k">Mode</span><span class="v"><span class="dot green"></span>Webhooks</span></div>
      <div class="prop"><span class="k">Last event</span><span class="v mono">2m ago</span></div>
      <div class="prop"><span class="k">Attached</span><span class="v mono">18 Nov 2026</span></div>
      <div class="prop"><span class="k">Prompt tasks</span><span class="v">${promptHere ? `${ic("ticket-plus")}Get their tickets here` : '<span class="faint">–</span>'}</span></div>
    </div>
    <div class="group">
      <h5>Linear</h5>
      <div class="prop"><span class="k">Workspace</span><span class="v">acme</span></div>
      <div class="prop"><span class="k">GitHub</span><span class="v"><span class="green" style="display:inline-flex">${ic("circle-check", "i14")}</span>Installed</span></div>
    </div>
    <div class="group">
      <h5>Statuses in CALC <span class="mono">8</span></h5>
      ${[["Triage", "circle-dashed", "Open"], ["Backlog", "circle", "Open"], ["Todo", "circle", "Open"], ["In Progress", "contrast", "Started"], ["In Review", "contrast", "In review"], ["Done", "circle-check", "Done"], ["Canceled", "circle-x", "–"], ["Duplicate", "circle-x", "–"]]
        .map(([n, i, s]) => `<div style="display:flex;align-items:center;gap:9px;height:26px;font-size:13.5px">${ic(i, "i14")}<span style="flex:1">${n}</span><span class="faint" style="font-size:12.5px">${s}</span></div>`).join("")}
    </div>`;

  // ── 2. Spend: Keys, a third section beside Projects and Models ──────────────────────────
  // acme-anthropic serves the default list; northwind-anthropic and globex-openrouter are clients'
  // own keys; spare-openai is on no list. The keys sum to the month's $1,842.17, as the projects do.
  const keys = [
    { name: "acme-anthropic", host: "api.anthropic.com", vendor: "anthropic", fresh: "52.1M", out: "4.8M", cr: "65.3M", cw: "6.2M", spent: "$1,170.85" },
    { name: "northwind-anthropic", host: "api.anthropic.com", vendor: "anthropic", fresh: "18.7M", out: "1.7M", cr: "24.2M", cw: "2.3M", spent: "$412.80" },
    { name: "globex-openrouter", host: "openrouter.ai", vendor: "openrouter", fresh: "5.8M", out: "1.2M", cr: "4.4M", cw: "–", spent: "$258.52", unpriced: "3.4M" },
    { name: "spare-openai", host: "api.openai.com", vendor: "openai", fresh: "–", out: "–", cr: "–", cw: "–", spent: "$0.00" },
  ];
  const keysTable = ({ selected = "northwind-anthropic", list = keys, zero = false, host = false } = {}) => `
    <table class="t sp keys" data-testid="spend-keys">
      <colgroup><col><col style="width:92px"><col style="width:72px"><col style="width:90px"><col style="width:94px"><col style="width:104px"></colgroup>
      <thead><tr><th>Key</th><th class="num">Fresh input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Spent</th></tr></thead>
      <tbody>${list.map((k) => {
        const z = (v) => (v === "–" || zero ? `<td class="num zero">–</td>` : `<td class="num">${v}</td>`);
        return `<tr${k.name === selected ? ' class="on"' : ""}>
          <td title="${k.host}"><span class="kname">${logo(k.vendor)}<span class="nm">${k.name}</span>${host ? `<span class="host">${k.host}</span>` : ""}</span></td>
          ${z(k.fresh)}${z(k.out)}${z(k.cr)}${z(k.cw)}
          <td class="num${k.spent === "$0.00" || zero ? " zero" : ""}">${k.unpriced && !zero ? `<span class="unp" title="${k.unpriced} tokens on acme/sql-coder-ft have no price and aren't in this figure">${ic("circle-alert")}${k.spent}</span>` : zero ? "$0.00" : k.spent}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
  const keyPanel = () => `
    <div class="eb">Key</div>
    <div class="ptitle mono">northwind-anthropic</div>
    <div class="psub"><span class="mono">api.anthropic.com</span> · Anthropic Messages</div>
    <div class="group" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
      <h5>November 2026</h5>
      <div class="prop"><span class="k">Spent</span><span class="v mono">$412.80</span></div>
      <div class="prop"><span class="k">Share</span><span class="v"><span class="mono">22%</span><span class="faint">of the organization's</span></span></div>
      <div class="prop"><span class="k">Tasks</span><span class="v mono">38</span></div>
    </div>
    <div class="group">
      <h5>Models on this key <span class="mono" style="margin-left:6px;margin-right:auto">2</span></h5>
      <div class="mline">${logo("anthropic")}<span>Claude Opus 5.5</span><span class="mono">$270.25</span></div>
      <div class="mline">${logo("anthropic")}<span>Claude Sonnet 5.5</span><span class="mono">$142.55</span></div>
    </div>
    <div class="group">
      <h5>Used by <span class="mono" style="margin-left:6px;margin-right:auto">1</span></h5>
      <div class="mline"><span class="psq" style="background:#5FA8E8"></span><span class="mono">northwind-portal</span><span class="f">own list · <span class="mono">$412.80</span></span></div>
      <p class="help" style="margin-top:6px">Budgets stay per project: northwind-portal's is <span class="mono">$800.00</span>. A key has no budget of its own.</p>
    </div>
    <span class="plink">The key on Models ${ic("arrow-right")}</span>`;
  const projectsTable = () => {
    const rows = [
      ["billing-platform", "#8C7CF0", "$612.40", "$600.00", 100, 98, "102%", `<span class="red">Reached · $12.40 over</span>`, true],
      ["calculator", "#6FB8AA", "$488.10", "$600.00", 81, null, "81%", `<span class="st-warn">${ic("triangle-alert")}Warned 16 Nov</span>`],
      ["northwind-portal", "#5FA8E8", "$412.80", "$800.00", 52, null, "52%", '<span class="faint">–</span>'],
      ["globex-shop", "#D96BA0", "$258.52", null, 0, null, "", '<span class="teal">Set budget</span>'],
      ["data-pipeline", "#D9826B", "$70.35", "$300.00", 23, null, "23%", '<span class="faint">–</span>'],
    ];
    return `<table class="t sp">
      <colgroup><col style="width:28%"><col style="width:96px"><col style="width:96px"><col><col style="width:168px"></colgroup>
      <thead><tr><th>Project</th><th class="num">Spent</th><th class="num">Budget</th><th>Used</th><th>Status</th></tr></thead>
      <tbody>${rows.map(([n, c, s, b, w, tick, p, st, red]) => `<tr>
        <td><span class="pn"><span class="psq" style="background:${c}"></span><span class="nm">${n}</span></span></td>
        <td class="num">${s}</td><td class="num">${b === null ? '<span class="faint" style="font-family:var(--sans);font-size:13.5px">No budget</span>' : b}</td>
        <td><span class="used"><span class="bar6${red ? " red" : ""}">${b === null ? "" : `<i style="width:${w}%"></i>`}${tick ? `<span class="tick end" style="left:${tick}%"></span>` : ""}</span><span class="s${red ? " red" : ""}">${p}</span></span></td>
        <td style="font-size:13.5px">${st}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  };

  // ── 3. GitHub: the Events row, the "Turn on" result, the dialogs ───────────────────────
  /** The App panel's Events row. `state`: nopublic | off | waiting | on | unknown. */
  const eventsRow = (state) => {
    const top = {
      nopublic: `<span class="muted">Off · no public address</span>`,
      off: `<span class="muted">Off</span><span class="teal">Turn on ${ic("arrow-right")}</span>`,
      waiting: `${ic("clock")}<span>Waiting for events</span>`,
      on: `<span class="dot green"></span><span>On</span><span class="faint" style="font-size:13px">· 10 events</span>`,
      unknown: `<span class="muted">Couldn't check</span>`,
    }[state];
    const sub = {
      nopublic: `GitHub can't reach this server. Set <code>OSTRA_CORE_PUBLIC_URL</code> to a public address and restart core, then turn them on here.`,
      off: `Without them, ostra learns of PR changes only on its periodic check, and never sees <span class="mono" style="font-size:12px">@ostra</span> in a PR comment.`,
      waiting: `Subscribe to 10 events in the App's settings on GitHub. <span class="teal">Which ones</span> · <span class="teal">Permissions and events ↗</span>`,
      on: `<span class="teal">New webhook secret</span>`,
      unknown: `GitHub didn't say which events the App takes. <span class="teal">Check again</span>`,
    }[state];
    return `<div class="prop k112"><span class="k">Events</span><span class="v evv">${top}</span></div><p class="evx">${sub}</p>`;
  };
  const appPanel = ({ state = "off", webhook = "https://ostra.acme.dev/webhooks/github/cn_8f2kq7" } = {}) => `
    <div data-testid="app-panel">
      <h6>App</h6>
      <div class="prop k112"><span class="k">Slug</span><span class="v mono">ostra-acme</span></div>
      <div class="prop k112"><span class="k">App ID</span><span class="v mono">1184207</span></div>
      <div class="prop k112"><span class="k">Owner</span><span class="v mono">acme</span></div>
      <div class="prop k112"><span class="k">Visibility</span><span class="v">Public</span></div>
      <div class="prop k112"><span class="k">Bot</span><span class="v mono">ostra-acme[bot]</span></div>
      <div class="prop k112"><span class="k">Webhook</span><span class="v"><span class="mono xs" title="${webhook}" style="overflow:hidden;text-overflow:ellipsis">${state === "nopublic" ? "http://localhost:4000/webhooks/github/cn_8f2kq7" : webhook}</span></span></div>
      ${eventsRow(state)}
      <div class="prop k112"><span class="k">Secrets</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span></div>
      <div class="prop k112"><span class="k">Member linking</span><span class="v">On</span></div>
      <div class="hr"></div>
      <h6>Permissions <span class="n">7</span></h6>
      ${[["checks", "write"], ["contents", "write"], ["pull_requests", "write"], ["issues", "write"], ["statuses", "write"], ["actions", "read"], ["metadata", "read"]].map(([k, v]) => `<div class="perm"><span class="k2">${k}</span><span>${v}</span></div>`).join("")}
      <span class="outl">Open on GitHub ${ic("arrow-up-right")}</span>
    </div>`;
  const events = ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_run", "check_suite", "status", "push", "workflow_run"];
  const settings = "github.com/organizations/acme/settings/apps/ostra-acme";
  /** The result of "Turn on", shown once. `copied`: the secret's copy button shows its check. */
  const onceGroup = ({ copied = false, replaced = false } = {}) => `
    <div class="once" data-testid="shown-once">
      <div class="eb">${replaced ? "New webhook secret" : "Turn on events"}</div>
      <div class="ptitle mono">ostra-acme</div>
      <p class="psub">${replaced ? "Paste it in the App's settings on GitHub. Until you do, deliveries fail." : "Set these in the App's settings on GitHub: it has no call that does it for ostra."}</p>
      <div class="step"><span class="num">1</span><div>
        <div class="hd">Webhook, under General<span class="teal">General ${ic("arrow-up-right")}</span></div>
        <div class="d">Tick <b style="font-weight:500;color:var(--text)">Active</b>, then paste both.</div>
        <div class="flab">Webhook URL</div>
        <div class="copyf"><span class="fv">https://ostra.acme.dev/webhooks/github/cn_8f2kq7</span><span class="cb" title="Copy">${ic("copy")}</span></div>
        <div class="flab">Webhook secret</div>
        <div class="copyf"><span class="fv">9f2c41d07a6b8e35c1f0d4a92b7e6c58</span><span class="cb${copied ? " done" : ""}" title="${copied ? "Copied" : "Copy"}">${ic(copied ? "check" : "copy")}</span></div>
        <div class="lock">${ic("lock")}<span>The secret is shown once. Copy it now: ostra keeps it in the secret store and never shows it again.</span></div>
      </div></div>
      ${replaced ? "" : `<div class="step"><span class="num">2</span><div>
        <div class="hd">Events, under Permissions<span class="teal">Permissions ${ic("arrow-up-right")}</span></div>
        <div class="d">Tick these ${events.length} under <b style="font-weight:500;color:var(--text)">Subscribe to events</b>, then save.</div>
        <ul class="evlist">${events.map((e) => `<li>${e}</li>`).join("")}</ul>
      </div></div>`}
      <div class="foot"><span class="btn">Done</span><span class="help">${replaced ? "Done once it's pasted and saved on GitHub." : "Events reads On once GitHub lists all ten."}</span></div>
    </div>`;
  const leaveDialog = (style) => `
    <div class="dlg" style="${style}" role="alertdialog">
      <h4>Leave without copying the secret?</h4>
      <p>ostra shows it only now. Without it in the App's settings, GitHub's deliveries can't be checked and ostra drops them. You'd make another with <b style="font-weight:500;color:var(--text)">New webhook secret</b>.</p>
      <div class="acts"><span class="btn">Stay</span><span class="btn danger">Leave</span></div>
    </div>`;
  const replaceDialog = (style) => `
    <div class="dlg" style="${style}" role="alertdialog">
      <h4>Replace the webhook secret?</h4>
      <p>GitHub keeps signing with the old secret until you paste the new one in <span class="mono">ostra-acme</span>'s settings. Until then every delivery fails and ostra drops it: PR changes wait for its periodic check, and <span class="mono">@ostra</span> comments are missed.</p>
      <div class="acts"><span class="btn">Cancel</span><span class="btn danger">Replace the secret</span></div>
    </div>`;
  const appSections = ({ state = "off", selected = true } = {}) => {
    const wst = {
      nopublic: '<span class="dot grey"></span>Events off',
      off: '<span class="dot grey"></span>Events off',
      waiting: `${ic("clock")}Waiting for events`,
      on: '<span class="dot green"></span>Webhook receiving',
      unknown: '<span class="dot grey"></span>Events off',
    }[state];
    return `
    <div class="appsec">
      <div class="line${selected ? " on" : ""}">${ic("github")}<span class="slug">ostra-acme</span><span class="own">owned by <span class="mono">acme</span> · public</span><span class="wst">${wst}</span></div>
      <div class="inst"><span class="acc">${ic("building-2")}acme</span><span class="kd">organization</span><span class="rp">All repositories</span><span class="stt">${ic("check")}Linked</span><span class="ac">owner</span></div>
      <div class="inst"><span class="acc">${ic("building-2")}globex</span><span class="kd">organization</span><span class="rp">2 repositories</span><span class="stt">${ic("check")}Linked</span><span class="ac teal">Unlink</span></div>
      ${state === "off" || state === "nopublic" ? `<div class="offnote">${ic("info")}<span>Made while this server had no public address, so GitHub sends it no events.${state === "off" ? ' <span class="teal">Turn them on →</span>' : ""}</span></div>` : ""}
    </div>
    <div class="appsec">
      <div class="line">${ic("github")}<span class="slug">northwind-ostra</span><span class="own">owned by <span class="mono">northwind-co</span> · private</span><span class="wst"><span class="dot green"></span>Webhook receiving</span></div>
      <div class="inst"><span class="acc">${ic("building-2")}northwind-co</span><span class="kd">organization</span><span class="rp">3 repositories</span><span class="stt">${ic("check")}Linked</span><span class="ac">owner</span></div>
    </div>
    <div class="strangers">${ic("info")}A stranger who installs a public App reaches nothing: ostra drops its events and lists none of its repos until you link it.</div>`;
  };

  // ── 4. Environment: the saved setup, and the new repo's draft ──────────────────────────
  const savedScript = [
    "set -euo pipefail",
    'case "$OSTRA_REPO" in',
    "  'acme/calculator-web')",
    "    corepack enable",
    "    pnpm install --frozen-lockfile",
    "    pnpm prisma generate",
    "    ;;",
    "  'acme/calculator-api')",
    "    corepack enable",
    "    pnpm install --frozen-lockfile",
    "    ;;",
    "esac",
  ];
  const newLines = ["  'acme/calculator-engine')", "    uv sync --frozen", "    ;;"];
  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const diffBlock = ({ plain = false } = {}) => {
    if (plain) {
      const L = (k, g, t) => `<div class="l ${k}"><span class="g">${g}</span><span>${esc(t)}</span></div>`;
      return `<div class="diff">
        ${L("a", "+", 'case "$OSTRA_REPO" in')}${L("a", "+", "  'acme/calculator-web')")}
        ${L("", "", "corepack enable")}${L("", "", "pnpm install --frozen-lockfile")}${L("", "", "pnpm prisma generate")}
        ${L("a", "+", "    ;;")}${L("a", "+", "  'acme/calculator-engine')")}${L("a", "+", "    uv sync --frozen")}${L("a", "+", "    ;;")}${L("a", "+", "esac")}
      </div>`;
    }
    return `<div class="diff">
      <div class="l u"><span class="g">${ic("chevrons-up-down")}</span><span>10 lines unchanged</span></div>
      <div class="l"><span class="g"></span><span>    ;;</span></div>
      ${newLines.map((t) => `<div class="l a"><span class="g">+</span><span>${esc(t)}</span></div>`).join("")}
      <div class="l"><span class="g"></span><span>esac</span></div>
    </div>`;
  };
  const varRows = () => `
    <div class="vrows">
      <div class="vr"><span class="g">+</span>${ic("variable")}<span>ENGINE_LOG_LEVEL</span><span class="v2">info</span><span></span></div>
      <div class="vr"><span class="g">+</span>${ic("key-round")}<span>ENGINE_API_KEY</span><span class="v2 e">no value yet</span><span class="chip">${ic("lock")}secret</span></div>
    </div>`;
  /** One new repo's draft. `role`: admin | member. `kind`: case (the saved script has a case) | plain | nothing. */
  const repoDraft = ({ role = "admin", kind = "case", phone = false } = {}) => {
    const acts = role === "admin"
      ? (kind === "nothing" ? '<span class="btn sm ghost">Dismiss</span>' : `<span class="btn sm ghost">Dismiss</span><span class="btn sm">Edit first</span><span class="btn sm">Apply</span>`)
      : "";
    const why = {
      case: `Its tasks run the saved setup as it is, and its <span class="mono">case</span> has no branch for this repo, so they set up nothing. Detection drafted the lines below.`,
      plain: `Its tasks run the saved setup as it is: the pnpm lines, in a Python repo. Applying gives each repo its own branch of a <span class="mono">case</span> on <span class="mono">OSTRA_REPO</span>.`,
      nothing: `Detection found nothing to set up in it: no lockfile or setup file ostra knows. Its tasks run the saved setup as it is.`,
    }[kind];
    const repo = kind === "nothing" ? "acme/calculator-docs" : "acme/calculator-engine";
    const body = kind === "nothing" ? "" : `
      <div class="lab">Setup script <span class="f">what Apply adds</span></div>
      ${diffBlock({ plain: kind === "plain" })}
      <div class="lab">Variables and secrets <span class="f">written to <span class="mono">.env</span></span></div>
      ${varRows()}`;
    return `<div class="rd">
      <div class="h"><span class="rn">${repo}</span>${phone ? "" : `<span class="by">added by Alex Kim · 20 min ago</span>`}<span class="acts">${phone ? "" : acts}</span></div>
      ${phone ? `<div class="by" style="font-size:13px;color:var(--faint)">added by Alex Kim · 20 min ago</div>` : ""}
      <p class="why">${why}</p>
      ${body}
      ${role === "admin" ? (kind === "nothing" ? "" : `<p class="foot">Applying saves the environment: new boxes get it, running tasks keep theirs, and the snapshot rebuilds.</p>`) : `<p class="foot">A project admin applies it, edits it first or dismisses it.</p>`}
      ${phone && role === "admin" ? `<div class="pacts"><span class="btn">Apply</span><span class="btn">Edit first</span></div><div class="pacts one"><span class="btn ghost">Dismiss</span></div>` : ""}
    </div>`;
  };
  const scriptEditor = ({ withNew = false } = {}) => {
    const lines = withNew ? [...savedScript.slice(0, 11).map((t) => [t, false]), ...newLines.map((t) => [t, true]), ["esac", false]] : savedScript.map((t) => [t, false]);
    return `<div class="ed">${lines.map(([t, n], i) => `<div class="l${n ? " new" : ""}"><span class="n">${i + 1}</span><span>${esc(t)}</span></div>`).join("")}</div>`;
  };
  const envPanel = ({ role = "admin" } = {}) => `
    <div class="group">
      <h5>Snapshot</h5>
      <div class="prop"><span class="k">Status</span><span class="v"><span class="dot green"></span>Ready <span class="faint">· since 2h</span></span></div>
      <div class="prop"><span class="k">In use</span><span class="v">built 2h ago on <span class="mono">build-01</span></span></div>
    </div>
    <div class="group">
      <h5>Environment</h5>
      <div class="prop"><span class="k">Status</span><span class="v"><span class="dot green"></span>Saved <span class="faint">· 2h ago</span></span></div>
      <div class="prop" style="align-items:start;padding-top:4px"><span class="k" style="line-height:20px">Repos</span><span class="v reps" style="flex-direction:column;align-items:stretch;gap:0">
        <span class="rep">acme/calculator-web</span>
        <span class="rep">acme/calculator-api</span>
        <span class="rep">acme/calculator-engine<span class="chip">new</span></span>
      </span></div>
      <div class="prop"><span class="k">Entries</span><span class="v">5 variables · 3 secrets · 1 file</span></div>
    </div>
    <div class="group found">
      <h5>Found in acme/calculator-engine</h5>
      <div class="it"><div class="f">uv.lock</div><div class="w">uv, install with --frozen</div></div>
      <div class="it"><div class="f">.python-version</div><div class="w">Python 3.12</div></div>
      <div class="it"><div class="f">.env.example</div><div class="w">2 variables, 1 looks like a secret</div></div>
    </div>
    <div class="group">
      <h5>Tools</h5>
      <div class="tools"><span class="chip">python 3.12</span><span class="chip">uv 0.5</span></div>
      <p class="help" style="margin-top:8px">Detected in the new repo. ${role === "admin" ? "Nothing here changes until you apply it." : ""}</p>
    </div>`;

  return { ic, m, logo, attachedRows, attachLine, promptSetting, boardMenu, mapping, boardPanel, keys, keysTable, keyPanel, projectsTable, eventsRow, appPanel, onceGroup, leaveDialog, replaceDialog, appSections, repoDraft, scriptEditor, envPanel, diffBlock, varRows };
})();
