// Milestone 11's tracker targets (../README.md): the parts as HTML, shared by every page here.
// The marks are the vendors' own SVGs (logos/, and ../README.md "The marks"). All data is demo
// data: Acme Corp, Globex, Northwind, calculator, CALC-…, PROJ-…, Sam Rivera, Alex Kim.
window.T = (() => {
  const ic = (name, cls = "") => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ""}></i>`;
  const m = (t) => `<span class="mono">${t}</span>`;

  // ── The marks ───────────────────────────────────────────────────────────────────────────
  // Linear and Notion: Simple Icons 16.30.0 (the vendors' marks as one path). Jira and Trello:
  // Atlassian's own, from @atlaskit/logo 23.3.3 (the tile and its glyph, and the one-colour cut-out).
  const P = {
    linear: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    notion: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
    tile: "M0 6a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6z",
    jira: "M9.051 15.434H7.734c-1.988 0-3.413-1.218-3.413-3h7.085c.367 0 .605.26.605.63v7.13c-1.772 0-2.96-1.435-2.96-3.434zm3.5-3.543h-1.318c-1.987 0-3.413-1.196-3.413-2.978h7.085c.367 0 .627.239.627.608v7.13c-1.772 0-2.981-1.435-2.981-3.434zm3.52-3.522h-1.317c-1.987 0-3.413-1.217-3.413-3h7.085c.367 0 .605.262.605.61v7.129c-1.771 0-2.96-1.435-2.96-3.434z",
    jiraMono: "M18 0a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6zM4.321 12.434c0 1.782 1.425 3 3.412 3h1.319v1.326c0 2 1.188 3.433 2.959 3.433v-7.129c0-.369-.238-.63-.605-.63zm3.5-3.52c0 1.781 1.425 2.977 3.412 2.977h1.318v1.326c0 2 1.21 3.433 2.98 3.433V9.521c0-.369-.259-.608-.626-.608zm3.52-3.544c0 1.782 1.426 3 3.413 3h1.317v1.304c0 2 1.188 3.433 2.96 3.433V5.98c0-.348-.238-.609-.605-.609z",
    trello: "M9.39 18.23a.95.95 0 0 0 .95-.95V5.38a.95.95 0 0 0-.95-.95H5.38a.95.95 0 0 0-.95.95v11.91c0 .52.42.95.95.95zm9.23-5.46a.95.95 0 0 0 .95-.95V5.38a.95.95 0 0 0-.95-.95h-4.01a.95.95 0 0 0-.95.95v6.44c0 .52.42.95.95.95z",
    trelloMono: "M18 0a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6zM5.379 4.43a.95.95 0 0 0-.948.949v11.907c0 .523.424.948.948.948H9.39a.95.95 0 0 0 .947-.948V5.38a.95.95 0 0 0-.947-.948zm9.23 0a.95.95 0 0 0-.947.949v6.44c0 .523.423.948.947.949h4.012a.95.95 0 0 0 .948-.949V5.38a.95.95 0 0 0-.948-.948z",
  };
  const BRAND = { linear: "#5E6AD2", jira: "#1868DB", trello: "#1558BC" };
  const NAME = { linear: "Linear", jira: "Jira", trello: "Trello", notion: "Notion" };
  /** A tracker's mark: its brand colours, or `mono` in the current colour. */
  const logo = (kind, size = 18, mono = false) => {
    const a = `class="tl${mono ? " mono" : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="${NAME[kind]}"`;
    if (kind === "linear") return `<svg ${a}><path fill="${mono ? "currentColor" : BRAND.linear}" d="${P.linear}"/></svg>`;
    if (kind === "notion") return `<svg ${a}><path fill="${mono ? "currentColor" : "var(--text)"}" d="${P.notion}"/></svg>`;
    if (mono) return `<svg ${a}><path fill="currentColor" d="${P[`${kind}Mono`]}"/></svg>`;
    return `<svg ${a}><path fill="${BRAND[kind]}" d="${P.tile}"/><path fill="#fff" d="${P[kind]}"/></svg>`;
  };

  // ── The shell: Organization's Connections become GitHub and Trackers ───────────────────
  const orgNav = () => {
    const d = document.body.dataset;
    for (const el of document.querySelectorAll("aside.ctx .nav, aside.peek .nav")) {
      if (el.textContent.trim() === "Linear") {
        el.outerHTML = `<div class="nav${d.active === "trackers" ? " on" : ""}">${ic("ticket")}<span>Trackers</span><span class="end"><span class="n">${d.conns ?? "4"}</span></span></div>`;
      }
    }
  };
  /** Home for a new organization: no live tasks yet. */
  const homeNav = () => {
    const body = document.querySelector("aside.ctx .body");
    if (!body) return;
    body.innerHTML = `
      <div class="nav on">${ic("layout-dashboard")}<span>Overview</span></div>
      <div class="nav">${ic("square-kanban")}<span>Board</span></div>
      <div class="nav">${ic("list-checks")}<span>All tasks</span></div>
      <div class="sec">Yours, live</div>
      <div class="nav" style="color:var(--faint)"><span>Nothing running yet</span></div>`;
  };

  // ── Organization › Trackers ─────────────────────────────────────────────────────────────
  const conns = [
    { id: "acme-linear", kind: "linear", name: "Acme Linear", site: "acme", siteNote: "linear.app/acme", mode: "webhooks", last: "2m ago", status: "ok", boards: 4 },
    { id: "globex-jira", kind: "jira", name: "Globex Jira", site: "globex.atlassian.net", mode: "webhooks", last: "6m ago", status: "ok", boards: 2 },
    { id: "acme-jira", kind: "jira", name: "Acme Ops Jira", site: "acme-ops.atlassian.net", mode: "webhooks", last: "–", status: "pending", boards: 0 },
    { id: "northwind-linear", kind: "linear", name: "Northwind Linear", site: "northwind", mode: "polling", last: "3h ago", status: "failed", boards: 1 },
  ];
  const modeCell = (mode) =>
    mode === "webhooks" ? `<span class="mode">${ic("radio-tower")}Webhooks</span>` : `<span class="mode">${ic("refresh-cw")}Polling</span>`;
  const statusCell = (s) =>
    ({
      ok: `<span class="cst ok"><span class="dot green"></span>Connected</span>`,
      pending: `<span class="stack2"><span class="cst pend"><span class="ring"></span>Pending</span><span class="why">No delivery yet</span></span>`,
      failed: `<span class="stack2"><span class="cst bad"><span class="dot red"></span>Failed</span><span class="why">Token refused</span></span>`,
      silent: `<span class="cst ok">${'<span class="redi">' + ic("triangle-alert") + '</span>'}Silent</span>`,
      expiring: `<span class="cst ok">${'<span class="redi">' + ic("triangle-alert") + '</span>'}Token expires</span>`,
    })[s];
  const connTable = ({ selected = "globex-jira", list = conns } = {}) => `
    <table class="t conns" data-testid="tracker-connections">
      <colgroup><col><col style="width:188px"><col style="width:112px"><col style="width:92px"><col style="width:118px"></colgroup>
      <thead><tr><th>Connection</th><th>Workspace or site</th><th>Mode</th><th>Last event</th><th>Status</th></tr></thead>
      <tbody>${list.map((c) => `<tr${c.id === selected ? ' class="on"' : ""}>
        <td><span class="cname">${logo(c.kind, 20)}<span class="stack"><span class="nm">${c.name}</span><span class="kd">${c.kind === "jira" ? "Jira Cloud" : "Linear"}</span></span></span></td>
        <td><span class="site">${c.site}</span></td>
        <td>${modeCell(c.mode)}</td>
        <td class="when">${c.last === "–" ? '<span class="faint">–</span>' : c.last}</td>
        <td>${statusCell(c.status)}</td>
      </tr>`).join("")}</tbody>
    </table>`;

  const projSq = (c) => `<span class="psq" style="background:${c}"></span>`;
  /** The properties panel for the selected connection (Organization › Trackers). */
  const connPanel = (id = "globex-jira") => {
    if (id === "globex-jira") return `
      <div class="chead">${logo("jira", 28)}<div><div class="t1">Globex Jira</div><div class="t2">Jira Cloud · ${m("globex.atlassian.net")}</div></div></div>
      <div class="group" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
        <h5>Connection</h5>
        <div class="prop"><span class="k">Status</span><span class="v"><span class="dot green"></span>Connected <span class="faint">· since 14 Nov</span></span></div>
        <div class="prop"><span class="k">Mode</span><span class="v">Webhooks</span></div>
        <div class="prop"><span class="k">Last event</span><span class="v"><span class="mono">6m ago</span><span class="faint">· PROJ-14</span></span></div>
        <div class="prop"><span class="k">Signs in as</span><span class="v"><span class="mono">ostra-bot</span><span class="faint">· service account</span></span></div>
        <div class="prop"><span class="k">Token</span><span class="v">Expires <span class="mono">14 Sep 2027</span></span></div>
      </div>
      <div class="group">
        <h5>Boards on it <span class="n">2</span></h5>
        <div class="uline">${projSq("#6FB8AA")}<span>calculator</span><span class="f">Globex Calculator · <span class="mono">PROJ</span></span></div>
        <div class="uline">${projSq("#D96BA0")}<span>globex-shop</span><span class="f">Globex Shop · <span class="mono">SHOP</span></span></div>
      </div>
      <div class="group">
        <h5>What Jira does here</h5>
        <div class="prop"><span class="k">Moves status</span><span class="v">By workflow transitions</span></div>
        <div class="prop"><span class="k">Sub-tasks</span><span class="v">Yes</span></div>
        <div class="prop"><span class="k">Rich text</span><span class="v">ADF, converted</span></div>
        <div class="prop"><span class="k">Agent mode</span><span class="v faint">– not in Jira</span></div>
      </div>
      <span class="plink">Open Globex Jira ${ic("arrow-right")}</span>`;
    return "";
  };

  /** The kinds, as tiles: Linear and Jira to pick; Trello and Notion shown, disabled, "Coming soon". */
  const kinds = ({ selected = "jira" } = {}) => `
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
    </div>
    <div class="kinds later-row" aria-label="Coming soon">
      <div class="kind later" aria-disabled="true">${logo("trello", 22)}<span class="nm">Trello</span><span class="soon">Coming soon</span></div>
      <div class="kind later" aria-disabled="true">${logo("notion", 22)}<span class="nm">Notion</span><span class="soon">Coming soon</span></div>
    </div>`;
  const pickerDialog = ({ style = "", selected = "jira" } = {}) => `
    <div class="dlg wide" style="${style}" role="dialog" aria-label="Connect a tracker">
      <h4>Connect a tracker</h4>
      <p class="dsub" style="margin-top:4px">Each connection is one Linear workspace or one Jira site, with its own token. Connect one per client.</p>
      ${kinds({ selected })}
      <div class="acts"><span class="left"><span class="kbd">←</span> <span class="kbd">→</span> to pick</span><span class="btn">Cancel</span><span class="btn primary">Continue with ${NAME[selected]}</span></div>
    </div>`;

  // ── Connecting Jira: the numbered steps ─────────────────────────────────────────────────
  const tick = (look, n) => (look === "done" ? `<span class="tick done">${ic("check")}</span>` : `<span class="tick ${look}">${n}</span>`);
  const scopes = [
    ["read:jira-work", "tickets, comments, transitions"],
    ["write:jira-work", "status, comments, links"],
    ["read:jira-user", "people, by account ID"],
    ["read:workflow:jira", "the mapping's check"],
  ];
  const jiraEvents = ["Issue created", "Issue updated", "Issue deleted", "Comment created", "Comment updated", "Comment deleted"];
  const readback = ({ partial = false, failed = false } = {}) => {
    if (failed) return `<div class="readback">
      <div class="rbh">What ostra read back<span class="r">just now</span></div>
      <div class="rb warn">${ic("circle-x")}<span>Jira refused the token: <span class="mono">401 Unauthorized</span>. Check the email is the service account's, and that the token isn't expired or revoked.</span></div>
    </div>`;
    return `<div class="readback">
      <div class="rbh">What ostra read back<span class="r">just now</span></div>
      <div class="rb"><span class="ok">${ic("check")}</span><span>Signs in as <span class="mono">ostra-bot</span> <span class="f">· a service account, not a person</span></span></div>
      <div class="rb"><span class="ok">${ic("check")}</span><span>Sees 3 projects: <span class="mono">PROJ</span>, <span class="mono">SHOP</span>, <span class="mono">OPS</span></span></div>
      ${partial
        ? `<div class="rb warn">${ic("triangle-alert")}<span>Can't transition or comment in <span class="mono">OPS</span>. Grant <b style="font-weight:500">Transition issues</b> and <b style="font-weight:500">Add comments</b> in its permission scheme, or leave OPS unattached.</span></div>
           <div class="rb warn">${ic("triangle-alert")}<span>Can't read workflows: without <span class="mono">read:workflow:jira</span>, the status mapping can't warn about a missing transition.</span></div>`
        : `<div class="rb"><span class="ok">${ic("check")}</span><span>Can browse, create, edit, transition and comment in all 3</span></div>
           <div class="rb"><span class="ok">${ic("check")}</span><span>Reads their workflows, so the status mapping can check each transition</span></div>`}
    </div>`;
  };
  const stepSite = (look) => look === "done"
    ? `<div class="stp settled">${tick("done")}<div><div class="st1">The site <span class="val">globex.atlassian.net</span><span class="r">Change</span></div><div class="sb">Jira Cloud. This connection is called <b>Globex Jira</b>.</div></div></div>`
    : `<div class="stp">${tick(look, 1)}<div>
        <div class="st1">The site</div>
        <div class="sb">The Jira Cloud site this client works in. ostra finds its cloud ID from it.</div>
        <div class="form">
          <div class="fl"><span class="lb">Site</span><span class="inp focus"><span class="pre">https://</span>globex<span class="pre">.atlassian.net</span></span></div>
          <div class="fl"><span class="lb">Name<span class="f">what boards and tickets call it</span></span><span class="inp" style="font-family:var(--sans);font-size:14px">Globex Jira</span></div>
          <div class="acts-row"><span class="btn primary">Find the site</span></div>
        </div></div></div>`;
  const stepToken = (look, { readbackOpts = {}, checked = true } = {}) => {
    if (look === "done") return `<div class="stp settled">${tick("done")}<div><div class="st1">The service account and its token <span class="r">Replace</span></div><div class="sb"><span class="mono">ostra-bot</span> sees 3 projects. The token is in the secret store and expires on 14 Sep 2027.</div></div></div>`;
    if (look === "later") return `<div class="stp">${tick("later", 2)}<div><div class="st1" style="color:var(--muted)">The service account and its token</div></div></div>`;
    return `<div class="stp">${tick(look, 2)}<div>
      <div class="st1">The service account and its token<span class="r">Service accounts ${ic("arrow-up-right")}</span></div>
      <div class="sb">In <b>admin.atlassian.com › Directory › Service accounts</b>, create one for ostra and give it the Jira projects it should see. Then create a scoped API token for it, with these scopes:</div>
      <div class="scopes">${scopes.map(([s]) => `<span class="chip">${s}</span>`).join("")}</div>
      <div class="form">
        <div class="fl"><span class="lb">Service account email</span><span class="inp">ostra-bot@serviceaccount.atlassian.com</span></div>
        <div class="row2">
          <div class="fl"><span class="lb">Scoped API token</span><span class="inp">••••••••••••••••••••••••••••<span class="end">${ic("eye-off")}</span></span></div>
          <div class="fl"><span class="lb">Expires</span><span class="inp" style="font-family:var(--sans);font-size:14px">14 Sep 2027</span></div>
        </div>
      </div>
      ${checked ? readback(readbackOpts) : ""}
      <div class="acts-row" style="margin-top:12px">${checked && !readbackOpts.failed
        ? `<span class="btn primary">Save and continue</span><span class="btn">Check again</span>`
        : `<span class="btn primary">Check the token</span>`}<span class="help">${checked && !readbackOpts.failed ? "Saved to the secret store, never shown again." : "ostra reads back who it is and what it reaches. Nothing is saved until you continue."}</span></div>
    </div></div>`;
  };
  const stepWebhook = (look, { polling = false, badSig = false, compact = false } = {}) => {
    if (look === "later") return `<div class="stp">${tick("later", 3)}<div><div class="st1" style="color:var(--muted)">${polling ? "Events" : "The admin webhook"}</div><div class="sb">${polling ? "Polling: this server's address isn't public." : "ostra shows a URL and a secret to paste in Jira."}</div></div></div>`;
    if (polling) return `<div class="stp">${tick(look, 3)}<div>
      <div class="st1">Events: polling</div>
      <div class="infol" style="margin-top:6px">${ic("refresh-cw")}<span>This server's address isn't public (a private-network address can't be reached from Jira), so Jira gets no webhook. ostra asks Jira for changes every 60 s instead: <b style="font-weight:500;color:var(--text)">a ticket's change reaches ostra up to a minute late.</b></span></div>
      <div class="infol" style="margin-top:8px">${ic("info")}<span>To receive webhooks, set <span class="mono">OSTRA_CORE_PUBLIC_URL</span> to a public https address and restart core. This step then asks for the webhook.</span></div>
      <div class="acts-row" style="margin-top:14px"><span class="btn primary">Finish</span><span class="help">Connects Globex Jira by polling. Its boards can be attached at once.</span></div>
    </div></div>`;
    return `<div class="stp">${tick(look, 3)}<div>
      <div class="st1">The admin webhook<span class="r">WebHooks in Jira ${ic("arrow-up-right")}</span></div>
      <div class="sb">In Jira, open <b>Settings › System › WebHooks</b> and press <b>Create a WebHook</b>. A Jira admin fills it in with these:</div>
      ${compact ? "" : `
      <div class="cfield"><span class="k">URL</span><div class="copyf"><span class="fv">https://ostra.acme.dev/webhooks/jira/cn_4r8tz2</span><span class="cb" title="Copy">${ic("copy")}</span></div></div>
      <div class="cfield"><span class="k">Secret</span><div class="copyf"><span class="fv">b81f6c2e94d0a7f35e1c8b29d64a0f17</span><span class="cb done" title="Copied">${ic("check")}</span></div></div>
      <div class="cfield" style="align-items:start"><span class="k" style="margin-top:4px">Events</span><div><div class="evt">${jiraEvents.map((e) => `<span class="chip">${ic("check")}${e}</span>`).join("")}</div><div class="help" style="margin-top:6px">Leave <b style="font-weight:500;color:var(--muted)">Exclude body</b> unticked.</div></div></div>
      <div class="cfield"><span class="k">JQL <span class="faint" style="font-weight:400">optional</span></span><div class="copyf"><span class="fv">project in (PROJ, SHOP, OPS)</span><span class="cb" title="Copy">${ic("copy")}</span></div></div>
      <div class="lock" style="max-width:640px">${ic("lock")}<span>The secret signs each delivery. ostra keeps it in the secret store and shows it until the first delivery arrives; after that you can only rotate it. The JQL only narrows what Jira sends: each board's rules still decide.</span></div>
`}
      ${badSig
        ? `<div class="wait" style="border-color:var(--red)">${'<span class="redi">' + ic("triangle-alert") + '</span>'}<span>A delivery came at <span class="mono">14:06</span> with a signature that doesn't match. Paste the secret in Jira again.</span><span class="r">Make a new secret</span></div>`
        : `<div class="wait"><span class="spin"></span><span>Waiting for the first delivery… <span class="f">Change any ticket in PROJ to send one.</span></span><span class="r">Use polling instead</span></div>`}
    </div></div>`;
  };
  /** The new connection's panel: what ostra asks of Jira. */
  const jiraNewPanel = ({ polling = false } = {}) => `
    <div class="group">
      <h5>Mode</h5>
      <div class="prop"><span class="k">Events</span><span class="v">${polling ? `${ic("refresh-cw", "i14")}Polling every 60 s` : `${ic("radio-tower", "i14")}Webhooks`}</span></div>
      <p class="help" style="margin-top:4px">${polling ? "This server's address isn't public: a private-network address can't be reached from Jira." : "Jira sends each change as it happens. Every board is also polled every 5 min, so a missed delivery is found."}</p>
    </div>
    <div class="group">
      <h5>The token needs <span class="n">4</span></h5>
      ${scopes.map(([s, f]) => `<div class="scp">${s}<span class="f">${f}</span></div>`).join("")}
    </div>
    ${polling ? "" : `<div class="group">
      <h5>Webhook events <span class="n">6</span></h5>
      ${jiraEvents.map((e) => `<div class="scp" style="font-family:var(--sans);font-size:13.5px">${e}</div>`).join("")}
    </div>`}
    <div class="group">
      <h5>It sees <span class="n">3</span></h5>
      <div class="uline"><span class="mono">PROJ</span><span>Globex Calculator</span></div>
      <div class="uline"><span class="mono">SHOP</span><span>Globex Shop</span></div>
      <div class="uline"><span class="mono">OPS</span><span>Operations</span></div>
      <p class="help" style="margin-top:6px">A project's Boards attach them once this connection is connected.</p>
    </div>`;

  // ── A connection's settings ─────────────────────────────────────────────────────────────
  const jiraSettings = () => `
    <div class="section first">
      <div class="shead"><h3>Connection</h3></div>
      <div class="conn-row"><span class="dot green"></span><span class="green" style="font-weight:500">Connected</span><span class="mono">globex.atlassian.net</span><span class="muted">Globex</span><span class="e">since 14 Nov</span></div>
    </div>
    <div class="section">
      <div class="shead"><h3>Events</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Mode</span><span class="v">${ic("radio-tower")}Webhooks: receiving</span><span class="e"></span></div>
        <div class="r"><span class="k">Webhook URL</span><span class="v"><span class="url">https://ostra.acme.dev/webhooks/jira/cn_4r8tz2</span></span><span class="e"><span class="teal">Copy</span></span></div>
        <div class="r"><span class="k">Webhook secret</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span><span class="e"><span class="teal">Rotate the secret</span></span></div>
        <div class="r"><span class="k">Last event</span><span class="v"><span class="mono">issue_updated</span><span class="muted">PROJ-14 updated</span></span><span class="e">6 min ago</span></div>
        <div class="r"><span class="k">Backstop</span><span class="v muted">Every board is also polled every 5 min, so a missed delivery is found.</span><span class="e"></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Service account</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Signs in as</span><span class="v"><span class="mono">ostra-bot@serviceaccount.atlassian.com</span></span><span class="e"></span></div>
        <div class="r"><span class="k">Token</span><span class="v"><span class="dot green"></span><span class="green">Healthy</span><span class="muted">· expires 14 Sep 2027, in 295 days</span></span><span class="e"><span class="teal">Replace</span></span></div>
        <div class="r"><span class="k">Reaches</span><span class="v">3 projects<span class="muted">· browse, create, edit, transition, comment</span></span><span class="e">checked 2h ago<span class="teal">Check again</span></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Disconnect</h3></div>
      <div class="danger-row"><span>Stops the webhook and polling for its 2 boards and deletes the token from the secret store. Boards, tickets and tasks stay, read-only.</span><span class="btn">Disconnect</span></div>
    </div>`;
  const jiraSettingsPanel = () => `
    <div class="group">
      <h5>Site</h5>
      <div class="prop"><span class="k">Site</span><span class="v mono">globex.atlassian.net</span></div>
      <div class="prop"><span class="k">Cloud ID</span><span class="v mono">a3f9…c12e</span></div>
      <div class="prop"><span class="k">Product</span><span class="v">Jira Cloud</span></div>
      <div class="prop"><span class="k">Workflows</span><span class="v">Readable</span></div>
    </div>
    <div class="group">
      <h5>Scopes <span class="n">4</span></h5>
      ${scopes.map(([s]) => `<div class="scp">${s}<span class="f">${ic("check", "i13")}</span></div>`).join("")}
    </div>
    <div class="group">
      <h5>Webhook events <span class="n">6</span></h5>
      ${jiraEvents.map((e) => `<div class="scp" style="font-family:var(--sans);font-size:13.5px">${e}</div>`).join("")}
    </div>
    <div class="group">
      <h5>Boards on it <span class="n">2</span></h5>
      <div class="uline">${projSq("#6FB8AA")}<span>calculator</span><span class="f"><span class="mono">PROJ</span></span></div>
      <div class="uline">${projSq("#D96BA0")}<span>globex-shop</span><span class="f"><span class="mono">SHOP</span></span></div>
    </div>`;

  const linearSettings = () => `
    <div class="section first">
      <div class="shead"><h3>Connection</h3></div>
      <div class="conn-row"><span class="dot green"></span><span class="green" style="font-weight:500">Connected</span><span class="mono">acme</span><span class="muted">Acme</span><span class="e">since 12 Nov</span></div>
    </div>
    <div class="section">
      <div class="shead"><h3>Events</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Mode</span><span class="v">${ic("radio-tower")}Webhooks: receiving</span><span class="e"></span></div>
        <div class="r"><span class="k">Webhook URL</span><span class="v"><span class="url">https://ostra.acme.dev/webhooks/linear/cn_7m2xq9</span></span><span class="e"><span class="teal">Copy</span></span></div>
        <div class="r"><span class="k">Last event</span><span class="v"><span class="mono">Issue</span><span class="muted">CALC-161 updated</span></span><span class="e">2 min ago</span></div>
        <div class="r"><span class="k">Backstop</span><span class="v muted">Every board is also polled every 5 min, so a missed delivery is found.</span><span class="e"></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Token</h3></div>
      <div class="kv">
        <div class="r"><span class="k">Access token</span><span class="v"><span class="dot green"></span><span class="green">Healthy</span><span class="muted">· expires in 21 h, refreshed an hour before</span></span><span class="e"></span></div>
        <div class="r"><span class="k">Refresh token</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span><span class="e"></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Agent mode</h3><span class="sec-note" style="color:var(--faint)">Linear only</span></div>
      <div class="kv">
        <div class="r"><span class="k">State</span><span class="v"><span class="dot green"></span>On<span class="muted">· turned on 12 Nov by Alex Kim</span></span><span class="e"></span></div>
        <div class="r"><span class="k">Start from Linear</span><span class="v">Calculator<span class="muted">· takes the Calculator team's delegations</span></span><span class="e"><span class="teal">Boards</span></span></div>
      </div>
    </div>
    <div class="section">
      <div class="shead"><h3>Disconnect</h3></div>
      <div class="danger-row"><span>Revokes the token at Linear and stops its 4 boards. Boards and their tickets stay, read-only.</span><span class="btn">Disconnect</span></div>
    </div>`;
  const linearSettingsPanel = () => `
    <div class="group">
      <h5>App</h5>
      <div class="prop"><span class="k">App user</span><span class="v mono">ostra</span></div>
      <div class="prop"><span class="k">Secrets</span><span class="v">${ic("lock", "i13")}<span class="muted">In the secret store</span></span></div>
    </div>
    <div class="group">
      <h5>Scopes <span class="n">6</span></h5>
      ${["read", "write", "issues:create", "comments:create", "app:assignable", "app:mentionable"].map((s) => `<div class="scp">${s}</div>`).join("")}
    </div>
    <div class="group">
      <h5>Webhook events <span class="n">6</span></h5>
      ${["Issue", "Comment", "Attachment", "IssueLabel", "OAuthAuthorization", "AgentSessionEvent"].map((s) => `<div class="scp">${s}</div>`).join("")}
    </div>
    <div class="group">
      <h5>Boards on it <span class="n">4</span></h5>
      <div class="uline">${projSq("#6FB8AA")}<span>calculator</span><span class="f"><span class="mono">CALC</span></span></div>
      <div class="uline">${projSq("#D9826B")}<span>web-storefront</span><span class="f"><span class="mono">WEB</span></span></div>
      <div class="uline">${projSq("#5FA8E8")}<span>mobile-app</span><span class="f"><span class="mono">MOB</span></span></div>
      <div class="uline">${projSq("#8C7CF0")}<span>billing-platform</span><span class="f"><span class="mono">BIL</span></span></div>
    </div>`;

  // ── Boards: mixed trackers ──────────────────────────────────────────────────────────────
  const boards = [
    { kind: "linear", name: "Calculator", via: "Acme Linear · team", key: "CALC", open: 38, act: `<span class="dot green"></span>Last event ${m("2m ago")}` },
    { kind: "jira", name: "Globex Calculator", via: "Globex Jira · project", key: "PROJ", open: 9, act: `<span class="dot green"></span>Last event ${m("6m ago")}` },
  ];
  const boardRows = ({ selected = "PROJ", admin = true, list = boards } = {}) => `
    <div class="brows">${list.map((b) => `
      <div class="brow k${b.key === selected ? " on" : ""}${b.paused ? " paused" : ""}">${logo(b.kind, 18)}
        <span class="nm2"><span class="nm">${b.name}</span><span class="via">${b.via}</span></span><span class="ky">${b.key}</span>
        <span class="tk">${m(b.open)} open</span><span class="act">${b.act}</span>
        <span class="end2">${admin ? '<span class="btn xs ghost">Detach</span>' : ""}</span>
      </div>`).join("")}
    </div>`;
  const attachLine = ({ open = false } = {}) => `
    <div class="attachl">Attach <span class="select${open ? " open" : ""}" style="width:300px">${logo("jira", 15)}Globex Shop <span class="mono">· SHOP</span>${ic("chevron-down", "chev")}</span><span class="btn sm">Attach</span></div>`;
  const attachMenu = (style) => `
    <div class="menu attach" style="${style}">
      <div class="gh">${logo("linear", 14)}Acme Linear<span class="s">teams</span></div>
      <div class="mi">${ic("square-kanban")}Mobile <span class="mono">· MOB</span></div>
      <div class="mi">${ic("square-kanban")}Billing <span class="mono">· BIL</span></div>
      <div class="menu-sep" style="margin:4px -4px"></div>
      <div class="gh">${logo("jira", 14)}Globex Jira<span class="s">projects</span></div>
      <div class="mi on">${ic("square-kanban")}Globex Shop <span class="mono">· SHOP</span><span class="ck">${ic("check", "i14")}</span></div>
      <div class="mi">${ic("square-kanban")}Operations <span class="mono">· OPS</span></div>
      <div class="mi dim">${ic("square-kanban")}Globex Calculator <span class="mono">· PROJ</span><span class="r">attached</span></div>
      <div class="menu-sep" style="margin:4px -4px"></div>
      <div class="gh">${logo("jira", 14)}Acme Ops Jira<span class="s">pending</span></div>
      <div class="mi dim" style="height:28px;font-size:13px">Finish connecting it on Trackers first</div>
    </div>`;
  const promptOff = () => `<div class="pset"><span class="sw" role="switch" aria-checked="false"></span>
      <div><div class="lb">Make a ticket for every prompt task</div><div class="ex">Off: a prompt task makes no ticket. A member can still use <b>Create ticket</b> on one.</div></div></div>`;
  const statusSel = (cat, name, w = 300) => `<div class="ctl" style="max-width:${w}px"><span class="stcat ${cat}"></span>${name}${ic("chevron-down", "chev")}</div>`;
  const jiraMapping = () => `
    <div class="mrows">
      <div class="mrow"><div><div class="n">Open</div><div class="h">Tickets the Inbox shows</div></div>
        <div class="ctl" style="padding-left:5px;max-width:400px"><span class="chipst"><span class="stcat new"></span>To Do<span class="x">${ic("x")}</span></span><span class="chipst"><span class="stcat new"></span>Backlog<span class="x">${ic("x")}</span></span>${ic("chevron-down", "chev")}</div></div>
      <div class="mrow tr"><div><div class="n">Started</div><div class="h">When the task starts</div></div><div>${statusSel("ind", "In Progress")}<div class="via-line">${ic("corner-down-right")}<span>by <b>Start progress</b>, from To Do or Backlog</span></div></div></div>
      <div class="mrow tr"><div><div class="n">In review</div><div class="h">At the task's first PR</div></div><div>${statusSel("ind", "In Review")}<div class="via-line">${ic("corner-down-right")}<span>by <b>Ready for review</b>, from In Progress</span></div>
        <div class="warnl">${ic("triangle-alert")}<span>No transition reaches In Review from <b style="font-weight:500">Blocked</b>. A ticket there stays put, and ostra says so in its comment. <span class="teal">Workflow in Jira ↗</span></span></div></div></div>
      <div class="mrow tr"><div><div class="n">Done</div><div class="h">When the last PR merges</div></div><div>${statusSel("done", "Done")}<div class="via-line">${ic("corner-down-right")}<span>by <b>Done</b>, from any status</span></div></div></div>
      <div class="mrow"><div><div class="n">Done is moved by</div></div><div style="display:flex;align-items:center;gap:14px"><span class="seg"><span>Jira automation</span><span class="on">ostra</span></span><span class="help" style="max-width:300px;line-height:1.4">Jira's GitHub integration links the PR, but moves nothing without an automation rule.</span></div></div>
    </div>`;
  const jiraBoardPanel = () => `
    <div class="group">
      <h5>Board</h5>
      <div class="prop"><span class="k">Project</span><span class="v">Globex Calculator</span></div>
      <div class="prop"><span class="k">Key</span><span class="v mono">PROJ</span></div>
      <div class="prop"><span class="k">Tracker</span><span class="v">${logo("jira", 16)}Globex Jira</span></div>
      <div class="prop"><span class="k">Tickets</span><span class="v"><span class="mono">9</span> open</span></div>
      <div class="prop"><span class="k">Mode</span><span class="v"><span class="dot green"></span>Webhooks</span></div>
      <div class="prop"><span class="k">Last event</span><span class="v mono">6m ago</span></div>
    </div>
    <div class="group">
      <h5>Workflow for PROJ <span class="n">6</span></h5>
      ${[["new", "To Do", "To Do"], ["new", "Backlog", "To Do"], ["ind", "In Progress", "In progress"], ["ind", "Blocked", "In progress"], ["ind", "In Review", "In progress"], ["done", "Done", "Done"]]
        .map(([c, n, f]) => `<div class="wf"><span class="stcat ${c}"></span><span>${n}</span><span class="f">${f}</span></div>`).join("")}
    </div>
    <div class="group">
      <h5>Transitions <span class="n">5</span></h5>
      ${[["Start progress", "To Do, Backlog", "In Progress"], ["Block", "In Progress", "Blocked"], ["Unblock", "Blocked", "In Progress"], ["Ready for review", "In Progress", "In Review"], ["Done", "any", "Done"]]
        .map(([n, a, b]) => `<div class="wf" style="height:24px"><span style="font-size:13.5px">${n}</span><span class="f">${a} → ${b}</span></div>`).join("")}
    </div>`;
  const linearMapping = () => `
    <div class="mrows">
      <div class="mrow"><div><div class="n">Open</div><div class="h">Tickets the Inbox shows</div></div>
        <div class="ctl" style="padding-left:5px;max-width:400px"><span class="chipst">${ic("circle-dashed", "i13")}Triage<span class="x">${ic("x")}</span></span><span class="chipst">${ic("circle", "i13")}Backlog<span class="x">${ic("x")}</span></span><span class="chipst">${ic("circle", "i13")}Todo<span class="x">${ic("x")}</span></span>${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Started</div><div class="h">When the task starts</div></div><div class="ctl" style="max-width:300px">${ic("contrast")}In Progress${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">In review</div><div class="h">At the task's first PR</div></div><div class="ctl" style="max-width:300px">${ic("contrast")}In Review${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Done</div><div class="h">When the last PR merges</div></div><div class="ctl" style="max-width:300px">${ic("circle-check")}Done${ic("chevron-down", "chev")}</div></div>
      <div class="mrow"><div><div class="n">Done is moved by</div></div><div style="display:flex;align-items:center;gap:16px"><span class="seg"><span class="on">Linear's GitHub integration</span><span>ostra</span></span><span style="display:inline-flex;align-items:center;gap:7px;font-size:14px"><span class="green" style="display:inline-flex">${ic("circle-check", "i14")}</span>Integration installed</span></div></div>
      <div class="mrow"><div><div class="n">Magic word</div><div class="h">In each PR's body · Linear only</div></div><div style="display:flex;align-items:center;gap:16px"><span class="seg"><span class="on" style="padding:0 18px">Closes</span><span style="padding:0 18px">Refs</span></span><span class="mono faint" style="font-size:13.5px">Closes CALC-142</span></div></div>
    </div>`;
  const linearBoardPanel = () => `
    <div class="group">
      <h5>Board</h5>
      <div class="prop"><span class="k">Team</span><span class="v">Calculator</span></div>
      <div class="prop"><span class="k">Key</span><span class="v mono">CALC</span></div>
      <div class="prop"><span class="k">Tracker</span><span class="v">${logo("linear", 16)}Acme Linear</span></div>
      <div class="prop"><span class="k">Tickets</span><span class="v"><span class="mono">38</span> open</span></div>
      <div class="prop"><span class="k">Mode</span><span class="v"><span class="dot green"></span>Webhooks</span></div>
      <div class="prop"><span class="k">Last event</span><span class="v mono">2m ago</span></div>
      <div class="prop"><span class="k">Agent mode</span><span class="v">Takes delegations</span></div>
    </div>
    <div class="group">
      <h5>Statuses in CALC <span class="n">8</span></h5>
      ${[["Triage", "circle-dashed", "Open"], ["Backlog", "circle", "Open"], ["Todo", "circle", "Open"], ["In Progress", "contrast", "Started"], ["In Review", "contrast", "In review"], ["Done", "circle-check", "Done"], ["Canceled", "circle-x", "–"], ["Duplicate", "circle-x", "–"]]
        .map(([n, i, s]) => `<div style="display:flex;align-items:center;gap:9px;height:26px;font-size:13.5px">${ic(i, "i14")}<span style="flex:1">${n}</span><span class="faint" style="font-size:12.5px">${s}</span></div>`).join("")}
    </div>`;

  // ── Tickets ─────────────────────────────────────────────────────────────────────────────
  /** A ticket's key with its tracker's mark. `mono`: the mark in the key's own colour. */
  const tkey = (kind, key, { mono = true, size = 14, cls = "" } = {}) => `<span class="tkey ${cls}" title="${NAME[kind]}">${logo(kind, size, mono)}${key}</span>`;

  return { ic, m, logo, NAME, orgNav, homeNav, conns, connTable, connPanel, statusCell, modeCell, kinds, pickerDialog, tick, readback, stepSite, stepToken, stepWebhook, jiraNewPanel, jiraSettings, jiraSettingsPanel, linearSettings, linearSettingsPanel, boards, boardRows, attachLine, attachMenu, promptOff, jiraMapping, jiraBoardPanel, linearMapping, linearBoardPanel, tkey, scopes, jiraEvents, projSq };
})();
