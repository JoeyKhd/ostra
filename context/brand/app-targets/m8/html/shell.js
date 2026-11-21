// The double-sidebar shell of the milestone 8 targets (app-shell.md): the rail and the contextual
// panel, filled from <body data-*>. `?theme=light` sets the light tokens. All data is demo data.
//   data-space   home | needs-you | projects | org | settings   (the rail's lit space)
//   data-panel   home | project | org | none                    (the contextual panel; none = collapsed)
//   data-active  the panel row that is the page (tasks, overview, skills, ...)
//   data-live    the live task that is open (its row is selected)
//   data-peek    a space whose panel shows over the page, the panel being collapsed (hover)
(() => {
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  for (const [k, v] of q) if (k !== "theme") document.body.dataset[k] = v;
  const d = document.body.dataset;
  const ic = (name) => `<i data-lucide="${name}"></i>`;
  const on = (id) => (id === d.active ? " on" : "");

  // ── the rail ──
  const space = (id, icon, label, extra = "") =>
    `<div class="space${d.space === id ? " on" : ""}${d.peek === id ? " hover" : ""}" data-space="${id}">${ic(icon)}<span>${label}</span>${extra}</div>`;
  const rail = `
    <div class="org" title="Acme Corp"><span class="mark"></span><span class="mono-chip">A</span></div>
    <div class="tool new" title="New task (c)">${ic("plus")}</div>
    <div class="tool" title="Search (⌘K)">${ic("search")}</div>
    <div class="rule"></div>
    ${space("home", "house", "Home")}
    ${space("needs-you", "bell", "Needs you", '<span class="count">5</span>')}
    ${space("projects", "folder", "Projects")}
    ${space("org", "building-2", "Org")}
    <div class="foot">
      <div class="tool${d.space === "settings" ? " on" : ""}" title="Settings">${ic("settings")}</div>
      <div class="me">AK</div>
    </div>`;

  // ── the panels ──
  const nav = (id, icon, label, end = "") => `<div class="nav${on(id)}">${ic(icon)}<span>${label}</span>${end ? `<span class="end">${end}</span>` : ""}</div>`;
  const n = (x) => `<span class="n">${x}</span>`;
  const live = (id, mark, title, doing) =>
    `<div class="live${d.live === id ? " on" : ""}"><span class="st">${mark}</span><span class="t">${title}</span><span class="d">${doing}</span></div>`;
  const amber = '<span class="dot amber"></span>';
  const green = '<span class="dot green"></span>';
  const spin = '<span class="spin"></span>';
  const head = (title, acts) => `<div class="head">${title}<span class="acts">${acts}</span></div>`;
  const hide = `<span class="ib" title="Hide the sidebar ([)">${ic("panel-left-close")}</span>`;

  const panels = {
    home: () => `
      ${head('<h2>Acme Corp</h2>', hide)}
      <div class="body">
        ${nav("overview", "layout-dashboard", "Overview")}
        ${nav("board", "square-kanban", "Board")}
        ${nav("tasks", "list-checks", "All tasks")}
        <div class="sec">Yours, live <span class="n">4</span></div>
        ${live("calc-161", amber, "Add history panel", 'CALC-161 · <span class="amber-t">Needs you · approval</span>')}
        ${live("bil-88", green, "Prorate seat changes", "BIL-88 · Editing proration.ts")}
        ${live("web-311", green, "Fix cart badge count", "WEB-311 · Running pnpm test")}
        ${live("mob-57", spin, "Crash in the share sheet", "MOB-57 · Preparing the box")}
        <div class="sec">Recent</div>
        ${nav("r1", "circle-check", '<span class="mono faint" style="font-size:12.5px;margin-right:2px">CALC-150</span> Export history as CSV')}
        ${nav("r2", "git-pull-request", '<span class="mono faint" style="font-size:12.5px;margin-right:2px">WEB-298</span> Gift card balance')}
        ${nav("r3", "circle-check", '<span class="mono faint" style="font-size:12.5px;margin-right:2px">DATA-41</span> Backfill events')}
      </div>`,
    project: () => `
      ${head('<span class="switch"><span class="pdot" style="background:#6FB8AA"></span><h2>calculator</h2>' + ic("chevrons-up-down") + "</span>", `<span class="ib" title="New task in calculator">${ic("plus")}</span>${hide}`)}
      <div class="body">
        ${nav("tasks", "list-checks", "Tasks", n(12))}
        ${nav("needs-approval", "shield-question", "Needs approval", '<span class="count">2</span>')}
        ${nav("inbox", "inbox", "Inbox", n(4))}
        ${nav("boards", "square-kanban", "Boards")}
        ${nav("environment", "box", "Environment")}
        ${nav("automations", "zap", "Automations")}
        ${nav("memory", "book-open", "Memory", n(2))}
        ${nav("insights", "chart-no-axes-column", "Insights")}
        ${nav("settings", "settings", "Settings")}
        <div class="sec">Live <span class="n">5</span><span class="r">${ic("list-filter")}</span></div>
        ${live("calc-192", green, "Add a history panel", "CALC-192 · Editing panel.tsx")}
        ${live("calc-161", amber, "Keep the last 50 results", 'CALC-161 · <span class="amber-t">Needs you · approval</span>')}
        ${live("calc-142", amber, "Retry webhook delivery", 'CALC-142 · <span class="amber-t">Question</span>')}
        ${live("calc-170", green, "Fix rounding in percent mode", "CALC-170 · Running pnpm test")}
        ${live("calc-177", spin, "Add a CONTRIBUTING.md", "CALC-177 · Preparing the box")}
        <div class="sec">Other projects</div>
        <div class="nav"><span class="pdot" style="background:#8C7CF0"></span><span>billing-platform</span><span class="end"><span class="adot"></span></span></div>
        <div class="nav"><span class="pdot" style="background:#D9826B"></span><span>web-storefront</span></div>
        <div class="nav"><span class="pdot" style="background:#5FA8E8"></span><span>mobile-app</span><span class="end"><span class="adot"></span></span></div>
        <div class="nav">${ic("ellipsis")}<span>All 18 projects</span></div>
      </div>`,
    org: () => `
      ${head("<h2>Organization</h2>", hide)}
      <div class="body">
        ${nav("insights", "chart-no-axes-column", "Insights")}
        ${nav("spend", "wallet", "Spend")}
        ${nav("memory", "book-open", "Memory", n(3))}
        <div class="sec">Fleet</div>
        ${nav("runners", "server", "Runners", n(238))}
        ${nav("box-sizes", "box", "Box sizes")}
        ${nav("registry", "container", "Registry")}
        <div class="sec">Agents</div>
        ${nav("agent-profiles", "sliders-horizontal", "Agent profiles", n(6))}
        ${nav("skills", "blocks", "Skills and MCP", n(14))}
        ${nav("models", "cpu", "Models")}
        <div class="sec">Connections</div>
        ${nav("github", "git-pull-request", "GitHub")}
        ${nav("linear", "ticket", "Linear")}
        <div class="sec">People</div>
        ${nav("members", "users", "Members", n(24))}
        ${nav("audit", "scroll-text", "Audit log")}
        <div class="sec">Instance</div>
        ${nav("accounts", "circle-user-round", "Accounts")}
        ${nav("storage", "hard-drive", "Storage")}
        ${nav("email", "mail", "Email")}
      </div>`,
  };

  const railEl = document.querySelector("nav.rail");
  if (railEl) railEl.innerHTML = rail;
  const ctxEl = document.querySelector("aside.ctx");
  if (ctxEl && panels[d.panel]) ctxEl.innerHTML = panels[d.panel]() + '<span class="resize"></span>';
  else if (ctxEl) ctxEl.remove();
  // Collapsed: the top bar gains the toggle that docks the panel again, and a peek floats over the page.
  const bar = document.querySelector(".main .bar");
  if (d.panel === "none" && bar) bar.insertAdjacentHTML("afterbegin", `<span class="ib" style="margin-left:-8px" title="Show the sidebar ([)">${ic("panel-left-open")}</span>`);
  if (d.peek && panels[d.peek]) {
    document.querySelector(".app").insertAdjacentHTML("beforeend", `<aside class="peek">${panels[d.peek]().replace(hide, `<span class="ib" title="Keep it open ([)">${ic("panel-left-open")}</span>`)}</aside>`);
  }

  window.addEventListener("load", () => {
    lucide.createIcons();
    document.body.dataset.ready = "1";
  });
})();
