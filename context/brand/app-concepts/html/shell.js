// Fills <aside class="side" data-active="..."> with the shared sidebar, then draws the Lucide icons.
// data-active: "home", "needs-you", "my-tasks", "calculator/<page>", or an organization page such as "runner-pools".
(() => {
  const side = document.querySelector("aside.side");
  const active = side?.dataset.active ?? "";
  const [proj, page] = active.split("/");
  const on = (id) => (id === active ? " on" : "");
  const nav = (id, icon, label, extra = "") =>
    `<div class="nav${on(id)}"><i data-lucide="${icon}"></i> ${label}${extra}</div>`;

  const projects = [
    ["calculator", "#6FB8AA", true],
    ["billing-platform", "#8C7CF0", true],
    ["web-storefront", "#E0A458", true],
    ["mobile-app", "#5FA8E8", true],
    ["data-pipeline", "#C27BA0", false],
  ];
  const projectPages = [
    ["tasks", "list-checks", "Tasks", '<span class="n">17</span>'],
    ["inbox", "inbox", "Inbox", '<span class="n">4</span>'],
    ["environment", "box", "Environment", ""],
    ["automations", "zap", "Automations", ""],
    ["repos", "git-branch", "Repos", ""],
    ["settings", "settings-2", "Settings", ""],
  ];

  const projectHtml = projects
    .map(([name, colour, needsYou]) => {
      const open = name === proj && page;
      const head = `<div class="nav${open ? " parent" : ""}">${open ? '<i data-lucide="chevron-down" class="caret"></i>' : ""}<span class="pdot" style="background:${colour}"></span> ${name}${needsYou ? '<span class="adot"></span>' : ""}</div>`;
      if (!open) return head;
      return head + projectPages.map(([id, icon, label, extra]) => `<div class="nav sub${on(`${name}/${id}`)}"><i data-lucide="${icon}"></i> ${label}${extra}</div>`).join("");
    })
    .join("");

  side.innerHTML = `
    <div class="org"><img src="../../kit/logo/export/ostra-hinge-single-color.svg" alt="ostra"><b>Acme Corp</b><i data-lucide="chevrons-up-down"></i></div>
    <div class="qs"><div class="search"><i data-lucide="search"></i> Search <kbd>⌘K</kbd></div><div class="new"><i data-lucide="plus"></i></div></div>
    ${nav("home", "house", "Home")}
    ${nav("needs-you", "hand", "Needs you", '<span class="n amber">5</span>')}
    ${nav("my-tasks", "circle-user", "My tasks", '<span class="n">7</span>')}
    <div class="sec">Projects</div>
    ${projectHtml}
    <div class="nav"><i data-lucide="ellipsis"></i> 13 more</div>
    <div class="sec">Organization</div>
    ${nav("runner-pools", "server", "Runner pools", '<span class="n">238</span>')}
    ${nav("models", "cpu", "Models")}
    ${nav("insights", "chart-no-axes-column", "Insights")}
    ${nav("members", "users", "Members")}
    ${nav("audit-log", "scroll-text", "Audit log")}
    ${nav("org-settings", "settings", "Settings")}
    <div class="bottom"><span class="avatar">AK</span> Alex Kim</div>`;

  lucide.createIcons();
})();
