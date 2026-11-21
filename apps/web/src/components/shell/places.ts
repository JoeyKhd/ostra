import type { MessageKey } from "@/lib/messages";

// The double sidebar's places (F-147; app-shell.md, "The spaces' panels"): the rail's spaces, the
// rows each space's panel lists, and the place of every page of the panel, by its `src/app` route.
// Pure, so a test reads `src/app/(panel)` and fails for a page that has no place here.

/** The rail's spaces. Settings sits in the rail's foot, and is a space as the others are. */
export const spaces = ["home", "needs-you", "projects", "organization", "settings"] as const;
export type Space = (typeof spaces)[number];

/** The Lucide icon a row or a space draws, by name: `shell-icons.tsx` maps each to its component. */
export type ShellIcon =
  | "house"
  | "bell"
  | "folder"
  | "building-2"
  | "settings"
  | "layout-dashboard"
  | "square-kanban"
  | "list-checks"
  | "shield-question"
  | "inbox"
  | "box"
  | "zap"
  | "book-open"
  | "chart-no-axes-column"
  | "wallet"
  | "server"
  | "container"
  | "sliders-horizontal"
  | "cpu"
  | "git-pull-request"
  | "ticket"
  | "users"
  | "scroll-text"
  | "circle-user-round"
  | "hard-drive"
  | "mail"
  | "user"
  | "monitor-smartphone"
  | "blocks"
  | "app-window";

export type HomeRow = "overview" | "board" | "all-tasks";
export type ProjectRow = "tasks" | "needs-approval" | "inbox" | "boards" | "environment" | "automations" | "memory" | "insights" | "settings";
export type OrganizationRow =
  | "insights"
  | "spend"
  | "memory"
  | "runners"
  | "box-sizes"
  | "registry"
  | "agent-profiles"
  | "skills"
  | "models"
  | "github"
  | "linear"
  | "members"
  | "preview-links"
  | "audit"
  | "accounts"
  | "storage"
  | "email"
  | "previews";
export type SettingsRow = "account" | "notifications" | "device";

/** Where a page sits: its space, and the row of that space's panel that is the page (none for New task). */
export type Place =
  | { readonly space: "home"; readonly row: HomeRow | null }
  | { readonly space: "needs-you"; readonly row: "all" }
  | {
      readonly space: "projects";
      /** The project from the address; a task's page learns its project from the task (`scope.task`). */
      readonly projectId: string | null;
      readonly taskId: string | null;
      readonly row: ProjectRow | null;
    }
  | { readonly space: "organization"; readonly row: OrganizationRow }
  | { readonly space: "settings"; readonly row: SettingsRow };

/** Who sees a row, exactly as the single sidebar gated it (sidebar.tsx before milestone 8). */
export type RowGate = "member" | "admin" | "instance-admin";

export type Viewer = { readonly admin: boolean; readonly instanceAdmin: boolean };

const allowed = (gate: RowGate, viewer: Viewer): boolean => {
  switch (gate) {
    case "member":
      return true;
    case "admin":
      return viewer.admin;
    case "instance-admin":
      return viewer.instanceAdmin;
    default:
      return gate satisfies never;
  }
};

export type PanelRow<Id extends string> = {
  readonly id: Id;
  readonly href: string;
  readonly label: MessageKey;
  readonly icon: ShellIcon;
  readonly gate: RowGate;
};

export type RowGroup<Id extends string> = {
  /** The section label, or `null` for the panel's first, unlabelled rows. */
  readonly label: MessageKey | null;
  readonly rows: readonly PanelRow<Id>[];
};

export const homeRows: readonly PanelRow<HomeRow>[] = [
  { id: "overview", href: "/", label: "shell.panel.overview", icon: "layout-dashboard", gate: "member" },
  { id: "board", href: "/?view=board", label: "shell.panel.board", icon: "square-kanban", gate: "member" },
  { id: "all-tasks", href: "/search", label: "shell.panel.allTasks", icon: "list-checks", gate: "member" },
];

/** A project's pages, in the targets' order. Repos stays a tab of Settings, as today. */
export const projectRows = (projectId: string): readonly PanelRow<ProjectRow>[] => {
  const base = `/projects/${projectId}`;
  return [
    { id: "tasks", href: base, label: "shell.tasks", icon: "list-checks", gate: "member" },
    { id: "needs-approval", href: `${base}/needs-approval`, label: "shell.needsApproval", icon: "shield-question", gate: "member" },
    { id: "inbox", href: `${base}/inbox`, label: "shell.inbox", icon: "inbox", gate: "member" },
    { id: "boards", href: `${base}/boards`, label: "shell.boards", icon: "square-kanban", gate: "member" },
    { id: "environment", href: `${base}/environment`, label: "shell.environment", icon: "box", gate: "member" },
    { id: "automations", href: `${base}/automations`, label: "shell.automations", icon: "zap", gate: "member" },
    { id: "memory", href: `${base}/memory`, label: "shell.memory", icon: "book-open", gate: "member" },
    { id: "insights", href: `${base}/insights`, label: "shell.insights", icon: "chart-no-axes-column", gate: "member" },
    // Every member who can open the project reads its Access tab (F-087); its admins edit.
    { id: "settings", href: `${base}/settings`, label: "shell.settings", icon: "settings", gate: "member" },
  ];
};

/** The organization's pages in their groups (app-shell.md, "Organization"), each gated as today. */
export const organizationGroups: readonly RowGroup<OrganizationRow>[] = [
  {
    label: null,
    rows: [
      { id: "insights", href: "/organization/insights", label: "shell.insights", icon: "chart-no-axes-column", gate: "member" },
      { id: "spend", href: "/organization/spend", label: "shell.spend", icon: "wallet", gate: "admin" },
      { id: "memory", href: "/organization/memory", label: "shell.memory", icon: "book-open", gate: "member" },
    ],
  },
  {
    label: "shell.panel.fleet",
    rows: [
      { id: "runners", href: "/organization/runners", label: "shell.runners", icon: "server", gate: "member" },
      { id: "box-sizes", href: "/organization/box-sizes", label: "shell.boxSizes", icon: "box", gate: "member" },
      { id: "registry", href: "/organization/registry", label: "shell.registry", icon: "container", gate: "admin" },
    ],
  },
  {
    label: "shell.panel.agents",
    rows: [
      { id: "agent-profiles", href: "/organization/agent-profiles", label: "shell.agentProfiles", icon: "sliders-horizontal", gate: "member" },
      // Milestone 8 (F-145, ticket 31; library.md): the skills and MCP library, every member's to read.
      { id: "skills", href: "/organization/skills", label: "shell.skills", icon: "blocks", gate: "member" },
      { id: "models", href: "/organization/models", label: "shell.models", icon: "cpu", gate: "admin" },
    ],
  },
  {
    label: "shell.panel.connections",
    rows: [
      { id: "github", href: "/organization/github", label: "shell.github", icon: "git-pull-request", gate: "admin" },
      { id: "linear", href: "/organization/linear", label: "shell.linear", icon: "ticket", gate: "admin" },
    ],
  },
  {
    label: "shell.panel.people",
    rows: [
      { id: "members", href: "/organization/members", label: "shell.members", icon: "users", gate: "member" },
      // Milestone 8 (F-142; the lead's polish of 2026-11-21): who may see a preview, the organization's
      // public links. Its admins' own page, since one may not be the instance admin.
      { id: "preview-links", href: "/organization/previews", label: "shell.previews", icon: "app-window", gate: "admin" },
      { id: "audit", href: "/organization/audit", label: "shell.auditLog", icon: "scroll-text", gate: "admin" },
    ],
  },
  {
    // instance-settings.md: the install's own pages, for the instance admin alone (ticket 33).
    label: "shell.instance",
    rows: [
      { id: "accounts", href: "/instance/accounts", label: "shell.accounts", icon: "circle-user-round", gate: "instance-admin" },
      { id: "storage", href: "/organization/storage", label: "shell.storage", icon: "hard-drive", gate: "instance-admin" },
      { id: "email", href: "/organization/email", label: "shell.email", icon: "mail", gate: "instance-admin" },
      // Milestone 8 (F-144, ticket 26; instance-preview-domain.md): the preview domain and its check.
      { id: "previews", href: "/instance/previews", label: "shell.previews", icon: "app-window", gate: "instance-admin" },
    ],
  },
];

/** The member's own pages: the account, its notifications, and the runner sign-in page. */
export const settingsRows: readonly PanelRow<SettingsRow>[] = [
  { id: "account", href: "/account", label: "shell.account", icon: "user", gate: "member" },
  { id: "notifications", href: "/account/notifications", label: "shell.notifications", icon: "bell", gate: "member" },
  { id: "device", href: "/device", label: "shell.panel.device", icon: "monitor-smartphone", gate: "member" },
];

/** The groups a viewer sees: each row by its gate, and a group with no row left is hidden too. */
export const visibleGroups = <Id extends string>(groups: readonly RowGroup<Id>[], viewer: Viewer): readonly RowGroup<Id>[] =>
  groups.flatMap((group) => {
    const rows = group.rows.filter((row) => allowed(row.gate, viewer));
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });

export const visibleRows = <Id extends string>(rows: readonly PanelRow<Id>[], viewer: Viewer): readonly PanelRow<Id>[] => rows.filter((row) => allowed(row.gate, viewer));

/** What a page's place is, given the parts of its address. */
type PlaceOf = (params: Readonly<Record<string, string>>) => Place;

const home = (row: HomeRow | null): PlaceOf => () => ({ space: "home", row });
const project = (row: ProjectRow | null): PlaceOf => (params) => ({ space: "projects", projectId: params["project-id"] ?? null, taskId: null, row });
const task: PlaceOf = (params) => ({ space: "projects", projectId: null, taskId: params["task-id"] ?? null, row: null });
const organization = (row: OrganizationRow): PlaceOf => () => ({ space: "organization", row });
const settings = (row: SettingsRow): PlaceOf => () => ({ space: "settings", row });

/**
 * Every page of `src/app/(panel)`, by its route pattern, with its place. A static pattern comes
 * before a dynamic one it would also match (`/projects/new`, `/tasks/new`).
 */
export const pagePlaces: readonly { readonly pattern: string; readonly place: PlaceOf }[] = [
  { pattern: "/", place: home("overview") },
  { pattern: "/search", place: home("all-tasks") },
  { pattern: "/tasks/new", place: home(null) },
  { pattern: "/tasks/[task-id]", place: task },
  { pattern: "/tasks/[task-id]/review", place: task },
  { pattern: "/needs-you", place: () => ({ space: "needs-you", row: "all" }) },
  { pattern: "/projects/new", place: project(null) },
  { pattern: "/projects/[project-id]", place: project("tasks") },
  { pattern: "/projects/[project-id]/needs-approval", place: project("needs-approval") },
  { pattern: "/projects/[project-id]/inbox", place: project("inbox") },
  // A ticket with sub-issues opens from the inbox (inbox-view.tsx).
  { pattern: "/projects/[project-id]/tickets/[ticket-id]", place: project("inbox") },
  { pattern: "/projects/[project-id]/boards", place: project("boards") },
  { pattern: "/projects/[project-id]/environment", place: project("environment") },
  { pattern: "/projects/[project-id]/automations", place: project("automations") },
  { pattern: "/projects/[project-id]/automations/new", place: project("automations") },
  { pattern: "/projects/[project-id]/automations/[automation-id]", place: project("automations") },
  { pattern: "/projects/[project-id]/automations/[automation-id]/history", place: project("automations") },
  { pattern: "/projects/[project-id]/memory", place: project("memory") },
  { pattern: "/projects/[project-id]/memory/new", place: project("memory") },
  { pattern: "/projects/[project-id]/memory/proposals", place: project("memory") },
  { pattern: "/projects/[project-id]/memory/[note-id]", place: project("memory") },
  { pattern: "/projects/[project-id]/insights", place: project("insights") },
  // The old Repos address leads to Settings' Repos tab (ticket 39).
  { pattern: "/projects/[project-id]/repos", place: project("settings") },
  { pattern: "/projects/[project-id]/settings", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/access", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/audit", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/models", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/repos", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/review", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/runners", place: project("settings") },
  { pattern: "/projects/[project-id]/settings/ticket-template", place: project("settings") },
  { pattern: "/organization/insights", place: organization("insights") },
  { pattern: "/organization/spend", place: organization("spend") },
  { pattern: "/organization/memory", place: organization("memory") },
  { pattern: "/organization/memory/new", place: organization("memory") },
  { pattern: "/organization/memory/proposals", place: organization("memory") },
  { pattern: "/organization/memory/[note-id]", place: organization("memory") },
  { pattern: "/organization/runners", place: organization("runners") },
  { pattern: "/organization/runners/[runner-id]", place: organization("runners") },
  { pattern: "/organization/runners/pools/[pool-id]", place: organization("runners") },
  { pattern: "/organization/box-sizes", place: organization("box-sizes") },
  { pattern: "/organization/registry", place: organization("registry") },
  { pattern: "/organization/agent-profiles", place: organization("agent-profiles") },
  { pattern: "/organization/agent-profiles/new", place: organization("agent-profiles") },
  { pattern: "/organization/agent-profiles/[profile-id]", place: organization("agent-profiles") },
  { pattern: "/organization/skills", place: organization("skills") },
  { pattern: "/organization/skills/marketplace", place: organization("skills") },
  { pattern: "/organization/skills/suggestions", place: organization("skills") },
  { pattern: "/organization/skills/[item-id]", place: organization("skills") },
  { pattern: "/organization/models", place: organization("models") },
  { pattern: "/organization/github", place: organization("github") },
  { pattern: "/organization/linear", place: organization("linear") },
  { pattern: "/organization/members", place: organization("members") },
  { pattern: "/organization/previews", place: organization("preview-links") },
  { pattern: "/organization/audit", place: organization("audit") },
  { pattern: "/organization/storage", place: organization("storage") },
  { pattern: "/organization/email", place: organization("email") },
  { pattern: "/instance/accounts", place: organization("accounts") },
  { pattern: "/instance/previews", place: organization("previews") },
  { pattern: "/account", place: settings("account") },
  { pattern: "/account/notifications", place: settings("notifications") },
  { pattern: "/device", place: settings("device") },
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|\\]/g, "\\$&");

/** A route pattern as a matcher of a path: `[name]` is one segment, kept under its name. */
const matcherOf = (pattern: string): { readonly regex: RegExp; readonly names: readonly string[] } => {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      const dynamic = /^\[([a-z-]+)\]$/.exec(segment);
      if (dynamic?.[1] === undefined) return escape(segment);
      names.push(dynamic[1]);
      return "([^/]+)";
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`), names };
};

const matchers = pagePlaces.map((entry) => ({ ...entry, ...matcherOf(entry.pattern) }));

/** The place of a page by its path, or `null` for a path that is no page of the panel. */
export const placeOf = (pathname: string, search = ""): Place | null => {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  for (const entry of matchers) {
    const found = entry.regex.exec(path);
    if (found === null) continue;
    const params: Record<string, string> = {};
    entry.names.forEach((name, at) => {
      const value = found[at + 1];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    });
    const place = entry.place(params);
    // Home's Board is the second half of its toggle (`?view=board`), the same page.
    if (place.space === "home" && place.row === "overview" && new URLSearchParams(search).get("view") === "board") return { space: "home", row: "board" };
    return place;
  }
  return null;
};

/** The space a path belongs to; a path of no page falls back to Home. */
export const spaceOf = (pathname: string): Space => placeOf(pathname)?.space ?? "home";

/** The page a space opens on when the member hasn't been there yet in this session (app-shell.md, the rail's table). */
export const spaceHome = (space: Space, projects: { readonly last: string | null; readonly first: string | null }): string => {
  switch (space) {
    case "home":
      return "/";
    case "needs-you":
      return "/needs-you";
    case "projects": {
      const projectId = projects.last ?? projects.first;
      return projectId === null ? "/projects/new" : `/projects/${projectId}`;
    }
    case "organization":
      return "/organization/insights";
    case "settings":
      return "/account";
    default:
      return space satisfies never;
  }
};

/**
 * Where a click on a rail space goes: the last page visited in that space this session, or its
 * home; the space that's already lit goes to its home (app-shell.md, "What a space opens").
 */
export const spaceTarget = (space: Space, input: { readonly current: Space; readonly last: Readonly<Partial<Record<Space, string>>>; readonly projects: { readonly last: string | null; readonly first: string | null } }): string =>
  space === input.current ? spaceHome(space, input.projects) : (input.last[space] ?? spaceHome(space, input.projects));
