// Post-v1 Trello targets (../README.md): the Trello parts as HTML, on milestone 11's tracker
// targets (`../../m11-trackers/html/tr.js`: the marks, the shell and the shared page styles).
// All data is demo data: Acme Corp, Globex, Northwind, calculator, CALC-…, PROJ-…, TR-…,
// Alex Kim, and the bot members ostra-acme and ostra-northwind.
window.TT = (() => {
  const { ic, m, logo } = T;
  const projSq = (c) => `<span class="psq" style="background:${c}"></span>`;
  const dtype = (k) => (k === "jira" ? "Jira Cloud" : k === "trello" ? "Trello · bot member" : "Linear");

  // ── The connections (Organization › Trackers) ─────────────────────────────────────────
  const conns = [
    { id: "acme-linear", kind: "linear", name: "Acme Linear", site: "acme", mode: "webhooks", last: "2m ago", status: "ok", boards: 4 },
    { id: "globex-jira", kind: "jira", name: "Globex Jira", site: "globex.atlassian.net", mode: "webhooks", last: "6m ago", status: "ok", boards: 2 },
    { id: "acme-trello", kind: "trello", name: "Acme Trello", site: "ostra-acme", mode: "webhooks", last: "3m ago", status: "ok", boards: 2 },
    { id: "northwind-trello", kind: "trello", name: "Northwind Trello", site: "ostra-northwind", mode: "polling", last: "1m ago", status: "ok", boards: 1 },
    { id: "acme-ops-jira", kind: "jira", name: "Acme Ops Jira", site: "acme-ops.atlassian.net", mode: "webhooks", last: "–", status: "pending", boards: 0 },
  ];
  const modeCell = (mode) =>
    mode === "webhooks"
      ? `<span class="mode">${ic("radio-tower")}Webhooks</span>`
      : `<span class="mode">${ic("refresh-cw")}Polling</span>`;
  const statusCell = (s) =>
    ({
      ok: `<span class="cst ok"><span class="dot green"></span>Connected</span>`,
      pending: `<span class="stack2"><span class="cst pend"><span class="ring"></span>Pending</span><span class="why">No delivery yet</span></span>`,
      failed: `<span class="stack2"><span class="cst bad"><span class="dot red"></span>Failed</span><span class="why">Token refused</span></span>`,
      revoked: `<span class="stack2"><span class="cst bad"><span class="dot red"></span>Failed</span><span class="why">Token revoked</span></span>`,
      silent: `<span class="cst ok"><span class="redi">${ic("triangle-alert")}</span>Silent</span>`,
    })[s];

  const connTable = ({ selected = "acme-trello", list = conns } = {}) => `
    <table class="t conns" data-testid="tracker-connections">
      <colgroup><col><col style="width:178px"><col style="width:108px"><col style="width:88px"><col style="width:118px"></colgroup>
      <thead><tr><th>Connection</th><th>Workspace, site or bot</th><th>Mode</th><th>Last event</th><th>Status</th></tr></thead>
      <tbody>${list.map((c) => `<tr${c.id === selected ? ' class="on"' : ""}>
        <td><span class="cname">${logo(c.kind, 20)}<span class="stack"><span class="nm">${c.name}</span><span class="kd">${dtype(c.kind)}</span></span></span></td>
        <td><span class="site">${c.site}</span></td>
        <td>${modeCell(c.mode)}</td>
        <td class="when">${c.last === "–" ? '<span class="faint">–</span>' : c.last}</td>
        <td>${statusCell(c.status)}</td>
      </tr>`).join("")}</tbody>
    </table>`;

  const connPanel = (id = "acme-trello") => {
    if (id !== "acme-trello") return "";
    return `
      <div class="chead">${logo("trello", 28)}<div><div class="t1">Acme Trello</div><div class="t2">Trello · bot member ${m("ostra-acme")}</div></div></div>
      <div class="group" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
        <h5>Connection</h5>
        <div class="prop"><span class="k">Status</span><span class="v"><span class="dot green"></span>Connected <span class="faint">· since 14 Nov</span></span></div>
        <div class="prop"><span class="k">Mode</span><span class="v">Webhooks</span></div>
        <div class="prop"><span class="k">Last event</span><span class="v"><span class="mono">updateCard</span><span class="faint">· TR-12</span></span></div>
        <div class="prop"><span class="k">Signs in as</span><span class="v"><span class="mono">ostra-acme</span><span class="faint">· bot member</span></span></div>
        <div class="prop"><span class="k">Token</span><span class="v">Never expires</span></div>
      </div>
      <div class="group">
        <h5>Boards on it <span class="n">2</span></h5>
        <div class="uline">${projSq("#6FB8AA")}<span>calculator</span><span class="f">Calculations · <span class="mono">TR</span></span></div>
        <div class="uline">${projSq("#D96BA0")}<span>globex-shop</span><span class="f">Retail · <span class="mono">RT</span></span></div>
      </div>
      <div class="group">
        <h5>What Trello does here</h5>
        <div class="prop"><span class="k">Moves status</span><span class="v">Directly, by list</span></div>
        <div class="prop"><span class="k">Sub-tasks</span><span class="v faint">– not in Trello</span></div>
        <div class="prop"><span class="k">Rich text</span><span class="v">Markdown</span></div>
        <div class="prop"><span class="k">Files</span><span class="v">Attachments</span></div>
        <div class="prop"><span class="k">Agent mode</span><span class="v faint">– not in Trello</span></div>
      </div>
      <span class="plink">Open Acme Trello ${ic("arrow-right")}</span>`;
  };

  // ── "Connect a tracker": Trello enabled, only Notion coming soon ─────────────────────
  const kinds = ({ selected = "trello" } = {}) => `
    <div class="kinds">
      <div class="kind${selected === "linear" ? " on" : ""}"><span class="radio"></span>
        <div class="top">${logo("linear", 32)}<div><div class="nm">Linear</div><div class="sub">Linear's own app, per workspace</div></div></div>
        <div class="d">You create the app in Linear, paste its values and authorize it. Webhooks, or polling without a public address.</div>
        <div class="caps"><span class="chip">Agent mode</span><span class="chip">Sub-issues</span><span class="chip">Magic words</span></div>
      </div>
      <div class="kind${selected === "jira" ? " on" : ""}"><span class="radio"></span>
        <div class="top">${logo("jira", 32)}<div><div class="nm">Jira</div><div class="sub">Jira Cloud, by service account</div></div></div>
        <div class="d">A service account's scoped API token, and an admin webhook signed with a secret ostra makes.</div>
        <div class="caps"><span class="chip">Workflow transitions</span><span class="chip">Sub-tasks</span><span class="chip">JQL filter</span></div>
      </div>
      <div class="kind${selected === "trello" ? " on" : ""}"><span class="radio"></span>
        <div class="top">${logo("trello", 32)}<div><div class="nm">Trello</div><div class="sub">Trello, by bot member</div></div></div>
        <div class="d">The organization's own app, and a bot member whose token never expires. Webhooks, or polling without a public address.</div>
        <div class="caps"><span class="chip">Lists as statuses</span><span class="chip">Cards</span><span class="chip">Attachments</span></div>
      </div>
      <div class="kind off" aria-disabled="true">${logo("notion", 32)}<span class="soon">Coming soon</span>
        <div class="top"><div><div class="nm">Notion</div><div class="sub">Later, after Trello</div></div></div>
        <div class="d">Notion's properties and webhook verification need a spike before ostra can map its pages.</div>
        <div class="caps"><span class="chip">Not yet</span></div>
      </div>
    </div>`;
  const pickerDialog = ({ selected = "trello" } = {}) => `
    <div class="dlg wide tl-picker" role="dialog" aria-label="Connect a tracker">
      <h4>Connect a tracker</h4>
      <p class="dsub">Each connection is one workspace, site or bot member, with its own token. Connect one per client.</p>
      ${kinds({ selected })}
      <div class="acts"><span class="left"><span class="kbd">←</span> <span class="kbd">→</span> to pick</span><span class="btn">Cancel</span><span class="btn primary">Continue with Trello</span></div>
    </div>`;

  // ── Connecting Trello: two steps ───────────────────────────────────────────────────────
  const tick = (look, n) => (look === "done" ? `<span class="tick done">${ic("check")}</span>` : `<span class="tick ${look}">${n}</span>`);

  const stepApp = (look) => (look === "done"
    ? `<div class="stp settled">${tick("done")}<div><div class="st1">The app <span class="val">4f2c…e91</span><span class="r">Change</span></div><div class="sb">Acme's own Trello app. This connection is called <b>Acme Trello</b>.</div></div></div>`
    : `<div class="stp">${tick(look, 1)}<div>
        <div class="st1">The app<span class="r">Trello's apps ${ic("arrow-up-right")}</span></div>
        <div class="sb">Create the organization's own app at <b>trello.com/apps/admin</b>, then paste its key and secret. Trello's consent page proves the key; the secret only signs deliveries.</div>
        <div class="form">
          <div class="fl"><span class="lb">API key<span class="f">public: it travels in the consent URL</span></span><span class="inp focus">4f2c8a1d7b6e0f35c9d2</span></div>
          <div class="fl"><span class="lb">API secret<span class="f">signs each delivery</span></span><span class="inp">••••••••••••••••••••••••••••<span class="end">${ic("eye-off")}</span></span></div>
          <div class="fl"><span class="lb">Name<span class="f">what boards and cards call it</span></span><span class="inp" style="font-family:var(--sans);font-size:14px">Acme Trello</span></div>
          <div class="acts-row"><span class="btn primary">Save and continue</span><span class="help">The key is stored on the connection; the secret goes to the secret store.</span></div>
        </div></div></div>`);

  const stepToken = (look, { mode = "consent", refused = false, taken = false, polling = false } = {}) => {
    if (look === "done") return `<div class="stp settled">${tick("done")}<div><div class="st1">The bot member and its token <span class="r">Replace</span></div><div class="sb"><span class="mono">ostra-acme</span> sees 5 open boards. The token is in the secret store and doesn't expire.</div></div></div>`;
    if (look === "later") return `<div class="stp">${tick("later", 2)}<div><div class="st1" style="color:var(--muted)">The bot member and its token</div></div></div>`;
    const body = mode === "consent"
      ? `<div class="consent">
          <div class="ctop">${logo("trello", 24)}<div><div class="cn">Authorize the bot member on Trello</div><div class="cs">The consent page asks for <b>read</b> and <b>write</b>, and a token that never expires.</div></div></div>
          <div class="cbody">The page returns the token in the URL fragment. ostra reads it there, checks it, and never logs it. A token that's pasted by hand is checked the same way.</div>
          <div class="acts-row"><span class="btn primary">${ic("external-link")}Authorize on Trello</span><span class="teal ctl2">Paste a token instead</span></div>
        </div>
        <div class="form" style="max-width:600px">
          <div class="fl"><span class="lb">Bot member's token<span class="f">or let the consent page return it</span></span><span class="inp">••••••••••••••••••••••••••••••••••••••••<span class="end">${ic("eye-off")}</span></span></div>
          <div class="acts-row"><span class="btn">Check the token</span><span class="help">ostra reads back the member and the boards it can see. Nothing is saved until you continue.</span></div>
        </div>`
      : refused
        ? `<div class="readback">
            <div class="rbh">What ostra read back<span class="r">just now</span></div>
            <div class="rb warn">${ic("circle-x")}<span>Trello refused the token: <span class="mono">401 Unauthorized</span>. Check that the token belongs to <span class="mono">ostra-acme</span> and hasn't been revoked.</span></div>
          </div>
          <div class="acts-row" style="margin-top:12px"><span class="btn primary">Check the token</span></div>`
        : `<div class="readback">
            <div class="rbh">What ostra read back<span class="r">just now</span></div>
            <div class="rb"><span class="ok">${ic("check")}</span><span>Signs in as <span class="mono">ostra-acme</span> <span class="f">· ostra Acme, a bot member, not a person</span></span></div>
            <div class="rb"><span class="ok">${ic("check")}</span><span>Sees 5 open boards and 1 closed: <span class="mono">Calculations</span>, Retail, Roadmap, Hiring, Ops</span></div>
            <div class="rb"><span class="ok">${ic("check")}</span><span>The token never expires. It isn't stored until you continue.</span></div>
          </div>
          ${taken
            ? `<div class="readback" style="border-color:var(--red)"><div class="rb warn" style="border-top:0">${ic("circle-x")}<span><span class="mono">ostra-northwind</span> is already connected, as <b style="font-weight:500">Northwind Trello</b>. A bot member can only have one connection. <span class="teal">Open it →</span></span></div></div>`
            : ""}
          <div class="acts-row" style="margin-top:12px"><span class="btn primary">Save and continue</span><span class="btn">Check again</span><span class="help">Saved to the secret store, never shown again.</span></div>`;
    return `<div class="stp">${tick(look, 2)}<div>
      <div class="st1">The bot member and its token<span class="r">The bot member ${ic("arrow-up-right")}</span></div>
      <div class="sb">Add a dedicated member to the boards ostra works, and authorize it as <b>ostra-acme</b>. It is never a person's account, and its token doesn't expire.</div>
      ${body}
      ${polling ? `<div class="infol" style="margin-top:14px">${ic("refresh-cw")}<span>This server's address isn't public, so Trello gets no webhook. ostra asks each attached board for changes every 60 s instead: <b style="font-weight:500;color:var(--text)">a card's change reaches ostra up to a minute late.</b></span></div><div class="acts-row" style="margin-top:12px"><span class="btn primary">Finish</span><span class="help">Connects Acme Trello by polling. Its boards can be attached at once.</span></div>` : ""}
    </div></div>`;
  };

  const tokenPanel = ({ polling = false, checked = false } = {}) => `
    <div class="group">
      <h5>Mode</h5>
      <div class="prop"><span class="k">Events</span><span class="v">${polling ? `${ic("refresh-cw", "i14")}Polling every 60 s` : `${ic("radio-tower", "i14")}Webhooks`}</span></div>
      <p class="help" style="margin-top:4px">${polling ? "This server's address isn't public: a private-network address can't be reached from Trello." : "ostra makes one webhook per attached board and deletes it on detach. Every board is also polled every 5 min."}</p>
    </div>
    <div class="group">
      <h5>The token needs <span class="n">2</span></h5>
      <div class="scp">read<span class="f">boards, lists, cards</span></div>
      <div class="scp">write<span class="f">lists, comments, attachments</span></div>
      <p class="help" style="margin-top:6px">The consent page asks for <span class="mono">expiration=never</span>. A token reads only the granting member's email, so mentions are off. Checklists stay in the card's description.</p>
    </div>
    ${checked ? `<div class="group">
      <h5>It sees <span class="n">6</span></h5>
      <div class="uline"><span>Calculations</span><span class="f">open</span></div>
      <div class="uline"><span>Retail</span><span class="f">open</span></div>
      <div class="uline"><span>Roadmap</span><span class="f">open</span></div>
      <div class="uline"><span>Hiring</span><span class="f">open</span></div>
      <div class="uline"><span>Ops</span><span class="f">open</span></div>
      <div class="uline" style="color:var(--faint)"><span>Archive 2025</span><span class="f">closed</span></div>
    </div>` : `<div class="group">
      <h5>It sees</h5>
      <p class="help" style="line-height:1.5">Nothing yet: the token isn't stored until it's checked. The read-back names the member and every board it can see.</p>
    </div>`}`;

  // ── A Trello connection's settings ────────────────────────────────────────────────────
  const trelloSettings = () => `
    <div class="section first">
      <div class="shead"><h3>Connection</h3></div>
      <div class="conn-row"><span class="dot green"></span><span class="green" style="font-weight:500">Connected</span><span class="mono">ostra-acme</span><span class="muted">ostra Acme · bot member</span><span class="e">since 14 Nov</span></div>
    </div>
    <div class="section">
      <div class="shead"><h3>Events</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Mode</span><span class="v">${ic("radio-tower")}Webhooks: receiving</span><span class="e"></span></div>
        <div class="r"><span class="k">Webhooks</span><span class="v">1 on <b style="font-weight:500">Calculations</b><span class="muted">· one per attached board</span></span><span class="e"><span class="teal">Re-register webhooks</span></span></div>
        <div class="r"><span class="k">Webhook URL</span><span class="v"><span class="url">https://ostra.acme.dev/webhooks/trello/cn_9k2m4p</span></span><span class="e"><span class="teal">Copy</span></span></div>
        <div class="r"><span class="k">App secret</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span><span class="e"><span class="teal">Replace the app secret</span></span></div>
        <div class="r"><span class="k">Last event</span><span class="v"><span class="mono">updateCard</span><span class="muted">TR-12 moved to Doing</span></span><span class="e">3 min ago</span></div>
        <div class="r"><span class="k">Backstop</span><span class="v muted">Every board is also polled every 5 min, so a missed delivery is found.</span><span class="e"></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Bot member</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Signs in as</span><span class="v"><span class="mono">ostra-acme</span><span class="muted">· ostra Acme</span></span><span class="e"></span></div>
        <div class="r"><span class="k">Token</span><span class="v"><span class="dot green"></span><span class="green">Healthy</span><span class="muted">· never expires</span></span><span class="e"><span class="teal">Replace</span></span></div>
        <div class="r"><span class="k">Reaches</span><span class="v">5 open boards<span class="muted">· 1 closed</span></span><span class="e">checked 2h ago<span class="teal">Check again</span></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Disconnect</h3></div>
      <div class="danger-row"><span>Deletes the webhook on Calculations, revokes the token at Trello and deletes the app secret. Boards, cards and tasks stay, read-only.</span><span class="btn">Disconnect</span></div>
    </div>`;
  const trelloSettingsPanel = () => `
    <div class="group">
      <h5>App</h5>
      <div class="prop"><span class="k">App key</span><span class="v mono">4f2c8a1d7b6e0f35c9d2</span></div>
      <div class="prop"><span class="k">Workspace</span><span class="v">Acme · Trello</span></div>
      <div class="prop"><span class="k">Secrets</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span></div>
    </div>
    <div class="group">
      <h5>Scopes <span class="n">2</span></h5>
      <div class="scp">read<span class="f">${ic("check", "i13")}</span></div>
      <div class="scp">write<span class="f">${ic("check", "i13")}</span></div>
    </div>
    <div class="group">
      <h5>Boards on it <span class="n">2</span></h5>
      <div class="uline">${projSq("#6FB8AA")}<span>calculator</span><span class="f">Calculations · <span class="mono">TR</span></span></div>
      <div class="uline">${projSq("#D96BA0")}<span>globex-shop</span><span class="f">Retail · <span class="mono">RT</span></span></div>
    </div>
    <div class="group">
      <h5>What Trello does here</h5>
      <div class="prop"><span class="k">Moves status</span><span class="v">Directly, by list</span></div>
      <div class="prop"><span class="k">Rich text</span><span class="v">Markdown</span></div>
      <div class="prop"><span class="k">Files</span><span class="v">Attachments</span></div>
    </div>`;

  // ── Boards: a Trello board, its prefix and its list mapping ───────────────────────────
  const boards = [
    { kind: "linear", name: "Calculator", via: "Acme Linear · team", key: "CALC", open: 38, act: `<span class="dot green"></span>Last event ${m("2m ago")}` },
    { kind: "jira", name: "Globex Calculator", via: "Globex Jira · project", key: "PROJ", open: 9, act: `<span class="dot green"></span>Last event ${m("6m ago")}` },
    { kind: "trello", name: "Calculations", via: "Acme Trello · board", key: "TR", open: 12, act: `<span class="dot green"></span>Last event ${m("3m ago")}` },
  ];
  const boardRows = ({ selected = "TR", admin = true, list = boards } = {}) => `
    <div class="brows">${list.map((b) => `
      <div class="brow k${b.key === selected ? " on" : ""}${b.paused ? " paused" : ""}">${logo(b.kind, 18)}
        <span class="nm2"><span class="nm">${b.name}</span><span class="via">${b.via}</span></span><span class="ky">${b.key}</span>
        <span class="tk">${m(b.open)} open</span><span class="act">${b.act}</span>
        <span class="end2">${admin ? '<span class="btn xs ghost">Detach</span>' : ""}</span>
      </div>`).join("")}
    </div>`;
  const attachLine = ({ open = false, trello = true } = {}) => `
    <div class="attachl">Attach <span class="select${open ? " open" : ""}" style="width:300px">${logo("trello", 15)}Calculations${ic("chevron-down", "chev")}</span><span class="btn sm">Attach</span></div>
    ${trello ? `<div class="prefixline"><span class="pl">Prefix</span><span class="pinp">TR</span><span class="phelp">Cards show as <b class="mono">TR-12</b>. Two to eight letters or digits, unique in this project.</span></div>` : ""}`;
  const attachMenu = (style) => `
    <div class="menu attach" style="${style}">
      <div class="gh">${logo("linear", 14)}Acme Linear<span class="s">teams</span></div>
      <div class="mi">${ic("square-kanban")}Mobile <span class="mono">· MOB</span></div>
      <div class="mi">${ic("square-kanban")}Billing <span class="mono">· BIL</span></div>
      <div class="menu-sep" style="margin:4px -4px"></div>
      <div class="gh">${logo("jira", 14)}Globex Jira<span class="s">projects</span></div>
      <div class="mi">${ic("square-kanban")}Operations <span class="mono">· OPS</span></div>
      <div class="mi dim">${ic("square-kanban")}Globex Calculator <span class="mono">· PROJ</span><span class="r">attached</span></div>
      <div class="menu-sep" style="margin:4px -4px"></div>
      <div class="gh">${logo("trello", 14)}Acme Trello<span class="s">boards</span></div>
      <div class="mi on">${ic("square-kanban")}Calculations<span class="ck">${ic("check", "i14")}</span></div>
      <div class="mi">${ic("square-kanban")}Roadmap</div>
      <div class="mi dim">${ic("square-kanban")}Retail<span class="r">attached</span></div>
      <div class="menu-sep" style="margin:4px -4px"></div>
      <div class="gh">${logo("trello", 14)}Northwind Trello<span class="s">pending</span></div>
      <div class="mi dim" style="height:28px;font-size:13px">Finish connecting it on Trackers first</div>
    </div>`;
  const catSel = (cat, name) => `<div class="ctl lc"><span class="stcat ${cat}"></span>${name}${ic("chevron-down", "chev")}</div>`;
  const trelloMapping = () => `
    <div class="prefixrow"><span class="k">Prefix</span><span class="pinp focus">TR</span><span class="help">Cards show as <b class="mono">TR-12</b>. Two to eight letters or digits, unique in this project.</span></div>
    <div class="mapgrid">
      <div class="mrows">
        <div class="mrow"><div><div class="n">Open</div><div class="h">Cards the Inbox shows</div></div>
          <div class="ctl" style="padding-left:5px;max-width:300px"><span class="chipst"><span class="stcat new"></span>Backlog<span class="x">${ic("x")}</span></span><span class="chipst"><span class="stcat new"></span>To Do<span class="x">${ic("x")}</span></span>${ic("chevron-down", "chev")}</div></div>
        <div class="mrow tr"><div><div class="n">Started</div><div class="h">When the task starts</div></div><div class="ctl" style="max-width:300px"><span class="stcat ind"></span>Doing${ic("chevron-down", "chev")}</div></div>
        <div class="mrow tr"><div><div class="n">In review</div><div class="h">At the task's first PR</div></div><div class="ctl" style="max-width:300px"><span class="stcat ind"></span>Review${ic("chevron-down", "chev")}</div></div>
        <div class="mrow tr"><div><div class="n">Done</div><div class="h">When the last PR merges</div></div><div class="ctl" style="max-width:300px"><span class="stcat done"></span>Done${ic("chevron-down", "chev")}</div></div>
        <div class="mrow"><div><div class="n">Done is moved by</div></div><div><span class="seg"><span class="on">ostra</span></span><div class="help" style="margin-top:4px">Trello has no GitHub integration to move a card.</div></div></div>
      </div>
      <div class="lside">
        <div class="shead"><h3>Lists on Calculations</h3><span class="n">6</span></div>
        <div class="ltable">
          ${[["Backlog", "new", "To Do", "Open"], ["To Do", "new", "To Do", "Open"], ["Doing", "ind", "In progress", "Started"], ["Review", "ind", "In progress", "In review"], ["Done", "done", "Done", "Done"], ["Won't do", "cancel", "Cancelled", "–"]]
            .map(([n, c, cat, step]) => `<div class="lrow"><span class="ln">${n}</span><span class="lc2">${catSel(c, cat)}</span><span class="ls">${step}</span></div>`).join("")}
        </div>
        <p class="help" style="margin-top:8px;line-height:1.45">Each list carries the category its cards take. ostra writes the chosen list directly: a list always takes a card, so there is no unreachable status.</p>
      </div>
    </div>`;
  const trelloBoardPanel = () => `
    <div class="group">
      <h5>Board</h5>
      <div class="prop"><span class="k">Board</span><span class="v">Calculations</span></div>
      <div class="prop"><span class="k">Prefix</span><span class="v mono">TR</span></div>
      <div class="prop"><span class="k">Tracker</span><span class="v">${logo("trello", 16)}Acme Trello</span></div>
      <div class="prop"><span class="k">Cards</span><span class="v"><span class="mono">12</span> open</span></div>
      <div class="prop"><span class="k">Mode</span><span class="v"><span class="dot green"></span>Webhooks</span></div>
      <div class="prop"><span class="k">Last event</span><span class="v mono">3m ago</span></div>
    </div>
    <div class="group">
      <h5>Lists on Calculations <span class="n">6</span></h5>
      ${[["new", "Backlog", "To Do"], ["new", "To Do", "To Do"], ["ind", "Doing", "In progress"], ["ind", "Review", "In progress"], ["done", "Done", "Done"], ["cancel", "Won't do", "Cancelled"]]
        .map(([c, n, f]) => `<div class="wf"><span class="stcat ${c}"></span><span>${n}</span><span class="f">${f}</span></div>`).join("")}
    </div>
    <div class="group">
      <h5>What Trello does here</h5>
      <div class="prop"><span class="k">Moves status</span><span class="v">Directly, by list</span></div>
      <div class="prop"><span class="k">Sub-tasks</span><span class="v faint">– not in Trello</span></div>
      <div class="prop"><span class="k">Files</span><span class="v">Attachments</span></div>
    </div>`;

  // ── Ticket marks ───────────────────────────────────────────────────────────────────────
  const tkey = (kind, key, { mono = true, size = 14 } = {}) => `<span class="tkey" title="${T.NAME[kind]}">${logo(kind, size, mono)}${key}</span>`;

  return { conns, connTable, connPanel, kinds, pickerDialog, tick, stepApp, stepToken, tokenPanel, trelloSettings, trelloSettingsPanel, boards, boardRows, attachLine, attachMenu, trelloMapping, trelloBoardPanel, tkey, catSel };
})();
