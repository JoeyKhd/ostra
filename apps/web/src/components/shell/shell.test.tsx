import { readdir } from "node:fs/promises";
import path from "node:path";

import { paletteActions, shortcutClashes, shortcutText } from "@ostra/domain/palette";
import { userIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";

import { sheetLines } from "./actions/registry";
import { destinations, placed } from "./destinations";
import { liveOrder, needsYouLine } from "./live-tasks";
import type { LiveTask } from "./live-tasks";
import { MenuButton } from "./nav-sheet";
import { createPeek, PEEK_CLOSE_MS, PEEK_OPEN_MS } from "./peek-timer";
import { homeRows, organizationGroups, pagePlaces, placeOf, projectRows, settingsRows, spaceHome, spaceTarget, spaces, visibleGroups } from "./places";
import type { Place, Space } from "./places";
import { otherProjects, pushRecent } from "./recent";
import { nextRovingIndex } from "./roving";
import { ShellStateContext } from "./shell-state";
import type { ShellState } from "./shell-state";
import { PreviewFrameLines } from "./shortcut-sheet";
import { bandOf, clampWidth, defaultSidebar, panelShown, readSidebarCookie, sidebarCookieLine, sidebarCookieValue, toggled } from "./sidebar-state";

// F-147 (milestone 8, ticket 10; app-shell.md): the double sidebar's rules, each alone. The browser
// runs of the rail, the panel, the collapse, the walk over every route and the phone sheet are in
// `e2e/23-shell.spec.ts`.

const appDir = path.resolve(import.meta.dirname, "..", "..", "app");

/** Every `page.tsx` of the panel's routes (`src/app/(panel)`), as its route pattern. */
const panelPatterns = async (): Promise<readonly string[]> => {
  const entries = await readdir(path.join(appDir, "(panel)"), { recursive: true });
  return entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry === "page.tsx" || entry.endsWith("/page.tsx"))
    .map((entry) => `/${entry.replace(/\/?page\.tsx$/, "")}`.replace(/\/\([^)]+\)/g, ""))
    .map((pattern) => (pattern === "/" || pattern === "" ? "/" : pattern.replace(/\/$/, "")))
    .sort();
};

const admin = { admin: true, instanceAdmin: true };
const member = { admin: false, instanceAdmin: false };

/** The rows of the panel a place's row must be one of, for a viewer who sees every row. */
const rowsOf = (place: Place): readonly string[] => {
  switch (place.space) {
    case "home":
      return homeRows.map((row) => row.id);
    case "needs-you":
      return ["all"];
    case "projects":
      return projectRows("p").map((row) => row.id);
    case "organization":
      return visibleGroups(organizationGroups, admin).flatMap((group) => group.rows.map((row) => row.id));
    case "settings":
      return settingsRows.map((row) => row.id);
    default:
      return place satisfies never;
  }
};

describe("the rail and the context panel (F-147)", () => {
  it("F-147/c1: the rail's spaces are Home, Needs you, Projects (one space, no pinned projects), the organization and Settings", () => {
    expect(spaces).toEqual(["home", "needs-you", "projects", "organization", "settings"]);
    expect(spaceHome("projects", { last: null, first: null })).toBe("/projects/new");
    expect(spaceHome("projects", { last: "p2", first: "p1" })).toBe("/projects/p2");
    expect(spaceHome("projects", { last: null, first: "p1" })).toBe("/projects/p1");
    expect(spaceHome("organization", { last: null, first: null })).toBe("/organization/insights");
  });

  it("F-147/c1: a space opens its last page this session, and the lit space goes back to its home", () => {
    const last: Partial<Record<Space, string>> = { organization: "/organization/members", home: "/?view=board" };
    const projects = { last: "p1", first: "p1" };
    expect(spaceTarget("organization", { current: "home", last, projects })).toBe("/organization/members");
    expect(spaceTarget("organization", { current: "organization", last, projects })).toBe("/organization/insights");
    expect(spaceTarget("needs-you", { current: "home", last, projects })).toBe("/needs-you");
    expect(spaceTarget("projects", { current: "home", last, projects })).toBe("/projects/p1");
  });

  it("F-147/c1: a project's panel lists its pages in the targets' order, with Repos left in Settings", () => {
    expect(projectRows("p1").map((row) => [row.id, row.href])).toEqual([
      ["tasks", "/projects/p1"],
      ["needs-approval", "/projects/p1/needs-approval"],
      ["inbox", "/projects/p1/inbox"],
      ["boards", "/projects/p1/boards"],
      ["environment", "/projects/p1/environment"],
      ["automations", "/projects/p1/automations"],
      ["memory", "/projects/p1/memory"],
      ["insights", "/projects/p1/insights"],
      ["settings", "/projects/p1/settings"],
    ]);
    expect(homeRows.map((row) => row.href)).toEqual(["/", "/?view=board", "/search"]);
  });

  it("F-147/c1: the organization's panel shows each row only to the roles that saw it in the single sidebar, and hides an empty group", () => {
    const ids = (viewer: typeof admin) => visibleGroups(organizationGroups, viewer).map((group) => [group.label, group.rows.map((row) => row.id)]);
    expect(ids(member)).toEqual([
      [null, ["insights", "memory"]],
      ["shell.panel.fleet", ["runners", "box-sizes"]],
      ["shell.panel.agents", ["agent-profiles", "skills"]],
      ["shell.panel.people", ["members"]],
    ]);
    expect(ids({ admin: true, instanceAdmin: false })).toEqual([
      [null, ["insights", "spend", "memory"]],
      ["shell.panel.fleet", ["runners", "box-sizes", "registry"]],
      ["shell.panel.agents", ["agent-profiles", "skills", "models"]],
      ["shell.panel.connections", ["github", "linear"]],
      // Organization › Previews (F-142): the organization's public links, for its admins, who may not be the instance admin.
      ["shell.panel.people", ["members", "preview-links", "audit"]],
    ]);
    expect(ids(admin).at(-1)).toEqual(["shell.instance", ["accounts", "storage", "email", "previews"]]);
  });

  it("F-147/c1: a project's live tasks put what needs the member first, then running, preparing and queued", () => {
    const task = (taskId: string, mark: LiveTask["mark"]): LiveTask => ({ taskId, key: taskId, title: taskId, mark, line: { tone: "plain", text: "" } });
    expect(liveOrder([task("q", "queued"), task("r1", "green"), task("n", "amber"), task("p", "preparing"), task("r2", "green")]).map((one) => one.taskId)).toEqual(["n", "r1", "r2", "p", "q"]);
    expect(needsYouLine("approval")).toBe(t("shell.live.approval"));
    expect(needsYouLine("question")).toBe(t("shell.live.question"));
    expect(needsYouLine(null)).toBe(t("shell.live.needsYou"));
  });

  it("F-147/c1: Other projects are the three opened last, besides the open one, filled from the list", () => {
    const list = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    expect(otherProjects(list, ["d", "a", "e"], "a").map((one) => one.id)).toEqual(["d", "e", "b"]);
    expect(otherProjects(list, [], null).map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(pushRecent(["a", "b", "c"], "c", (x, y) => x === y, 3)).toEqual(["c", "a", "b"]);
  });
});

describe("collapsing and the peek (F-147)", () => {
  it("F-147/c2: the cookie keeps the choice and the width, and anything malformed reads as open at 240", () => {
    expect(readSidebarCookie(sidebarCookieValue({ collapsed: true, width: 280 }))).toEqual({ collapsed: true, width: 280 });
    expect(readSidebarCookie("open:200")).toEqual({ collapsed: false, width: 200 });
    for (const raw of [undefined, "", "closed", "shut:240", "closed:abc", "closed:240;x", "open:99999", "open:9999"]) {
      expect(readSidebarCookie(raw), String(raw)).toEqual(raw === "open:9999" ? { collapsed: false, width: 320 } : defaultSidebar);
    }
    expect(clampWidth(120)).toBe(200);
    expect(clampWidth(500)).toBe(320);
    expect(clampWidth(Number.NaN)).toBe(240);
    expect(sidebarCookieLine({ collapsed: true, width: 240 }, true)).toBe("ostra-sidebar=closed:240; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  });

  it("F-147/c2: 1280 and up follows the saved choice; 1024 to 1279 and 768 to 1023 start collapsed and never save; a phone has no docked panel", () => {
    expect([767, 768, 1023, 1024, 1279, 1280, 1440].map(bandOf)).toEqual(["phone", "rail", "rail", "narrow", "narrow", "wide", "wide"]);
    const open = { collapsed: false, width: 240 };
    expect(panelShown("wide", open, false)).toBe(true);
    expect(panelShown("wide", { ...open, collapsed: true }, false)).toBe(false);
    expect(panelShown("narrow", open, false)).toBe(false);
    expect(panelShown("narrow", open, true)).toBe(true);
    expect(panelShown("phone", open, true)).toBe(false);
    expect(toggled("wide", open, false)).toEqual({ choice: { collapsed: true, width: 240 }, opened: false, save: true });
    expect(toggled("narrow", open, false)).toEqual({ choice: open, opened: true, save: false });
    expect(toggled("rail", open, true)).toEqual({ choice: open, opened: false, save: false });
  });

  describe("the peek", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const start = () => {
      const seen: (Space | null)[] = [];
      const peek = createPeek((space) => { seen.push(space); }, { set: (run, ms) => setTimeout(run, ms), clear: (handle) => { clearTimeout(handle); } });
      return { peek, seen };
    };

    it("F-147/c2: opens after the pointer rests 150ms, switches at once between spaces, and closes 200ms after it leaves", () => {
      const { peek, seen } = start();
      peek.enter("organization");
      vi.advanceTimersByTime(PEEK_OPEN_MS - 1);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(["organization"]);
      peek.enter("home");
      expect(seen).toEqual(["organization", "home"]);
      peek.leave();
      vi.advanceTimersByTime(PEEK_CLOSE_MS - 1);
      peek.hold();
      vi.advanceTimersByTime(PEEK_CLOSE_MS);
      expect(seen).toEqual(["organization", "home"]);
      peek.leave();
      vi.advanceTimersByTime(PEEK_CLOSE_MS);
      expect(seen).toEqual(["organization", "home", null]);
    });

    it("F-147/c2: sweeping across the rail shows nothing, and Escape or navigation closes it at once", () => {
      const { peek, seen } = start();
      peek.enter("home");
      vi.advanceTimersByTime(80);
      peek.enter("projects");
      vi.advanceTimersByTime(80);
      peek.leave();
      vi.advanceTimersByTime(1_000);
      expect(seen).toEqual([]);
      peek.enter("projects");
      vi.advanceTimersByTime(PEEK_OPEN_MS);
      peek.close();
      expect(seen).toEqual(["projects", null]);
    });
  });
});

describe("every page has a place (F-147)", () => {
  it("F-147/c3: every page of src/app/(panel) has a place, and the place's row is a row of its space's panel", async () => {
    const patterns = await panelPatterns();
    expect(patterns.length).toBeGreaterThan(50);
    const known = new Set(pagePlaces.map((entry) => entry.pattern));
    expect(patterns.filter((pattern) => !known.has(pattern)), "a page with no place in places.ts").toEqual([]);
    expect([...known].filter((pattern) => !patterns.includes(pattern)), "a place with no page").toEqual([]);
    for (const pattern of patterns) {
      const place = placeOf(pattern.replace(/\[[a-z-]+\]/g, "x1"));
      expect(place, pattern).not.toBeNull();
      if (place === null) continue;
      if (place.row === null) continue;
      expect(rowsOf(place), pattern).toContain(place.row);
    }
  });

  it("F-147/c3: the place of a path: its space, its row, and a project's ID from the address", () => {
    expect(placeOf("/")).toEqual({ space: "home", row: "overview" });
    expect(placeOf("/", "view=board&project=p1")).toEqual({ space: "home", row: "board" });
    expect(placeOf("/projects/new")).toEqual({ space: "projects", projectId: null, taskId: null, row: null });
    expect(placeOf("/projects/p1/automations/a1/history")).toEqual({ space: "projects", projectId: "p1", taskId: null, row: "automations" });
    expect(placeOf("/projects/p1/settings/repos/")).toEqual({ space: "projects", projectId: "p1", taskId: null, row: "settings" });
    expect(placeOf("/tasks/t1/review")).toEqual({ space: "projects", projectId: null, taskId: "t1", row: null });
    expect(placeOf("/organization/runners/pools/x")).toEqual({ space: "organization", row: "runners" });
    expect(placeOf("/instance/accounts")).toEqual({ space: "organization", row: "accounts" });
    expect(placeOf("/device")).toEqual({ space: "settings", row: "device" });
    expect(placeOf("/nowhere")).toBeNull();
  });

  it("F-147/c3: the palette's destinations open in the space the rail lights for them", () => {
    const list = placed(destinations([{ id: "p1", name: "calculator", colour: "#6FB8AA" }], true));
    expect(list.map((destination) => [destination.href, destination.space])).toEqual([
      ["/", "home"],
      ["/tasks/new", "home"],
      ["/projects/p1", "projects"],
      ["/projects/p1", "projects"],
      ["/projects/p1/environment", "projects"],
      ["/projects/new", "projects"],
      ["/organization/runners", "organization"],
      ["/organization/models", "organization"],
      ["/organization/github", "organization"],
      ["/organization/agent-profiles", "organization"],
    ]);
  });
});

describe("the keyboard (F-147)", () => {
  it("F-147/c4: milestone 7's shortcuts are unchanged, and `[`, `g p` and `g o` join them on the ? sheet", () => {
    const keys = Object.fromEntries(paletteActions.flatMap((entry) => (entry.shortcut === null ? [] : [[entry.id, shortcutText(entry.shortcut)]])));
    expect(keys).toEqual({
      "go-needs-you": "g n",
      "go-home": "g h",
      "go-tasks": "g t",
      "go-projects": "g p",
      "go-organization": "g o",
      "toggle-sidebar": "[",
      search: "/",
      "shortcut-sheet": "?",
      "new-task": "c",
      approve: "a",
      deny: "d",
      answer: "r",
      "take-over": "t",
      reopen: "o",
      stop: "s",
      // Milestone 8's task page (F-141, task-preview.md "Keyboard"): the side pane and Expand.
      "toggle-side-pane": "p",
      "expand-preview": "f",
    });
    expect(shortcutClashes(paletteActions)).toEqual([]);
    const global = sheetLines().find((section) => section.scope === "global")?.lines.map((line) => line.id) ?? [];
    expect(global).toEqual(expect.arrayContaining(["toggle-sidebar", "go-projects", "go-organization"]));
  });

  it("F-081/c2: the ? sheet's task section says ⌘. or Ctrl+. hands the focus back from the preview, and Tab and Shift+Tab leave it in either view", () => {
    const render = (mac: boolean) => renderToStaticMarkup(<dl><PreviewFrameLines mac={mac} /></dl>);
    const lines = (mac: boolean) => [...render(mac).matchAll(/data-sheet-line="([^"]+)" data-keys="([^"]+)"/g)].map((found) => [found[1], found[2]]);
    expect(lines(false)).toEqual([["preview-focus-back", "Control+."], ["preview-leave", "Tab Shift+Tab"]]);
    expect(lines(true)).toEqual([["preview-focus-back", "Meta+."], ["preview-leave", "Tab Shift+Tab"]]);
    const text = render(false).replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
    expect(text).toContain(`${t("shortcuts.previewLeave")} ${t("shortcuts.previewFocusBackNote")} Ctrl .`);
    expect(text).toContain(`${t("shortcuts.previewLeave")} ${t("shortcuts.previewLeaveNote")} Tab ${t("shortcuts.or")} ⇧ Tab`);
  });

  it("F-147/c5: ↑ and ↓ move through the rail and the panel and stop at the ends; Home and End jump; other keys are the page's", () => {
    expect(nextRovingIndex("ArrowDown", 0, 9)).toBe(1);
    expect(nextRovingIndex("ArrowDown", 8, 9)).toBe(8);
    expect(nextRovingIndex("ArrowUp", 0, 9)).toBe(0);
    expect(nextRovingIndex("ArrowUp", 4, 9)).toBe(3);
    expect(nextRovingIndex("Home", 4, 9)).toBe(0);
    expect(nextRovingIndex("End", 4, 9)).toBe(8);
    expect(nextRovingIndex("Enter", 4, 9)).toBeNull();
    expect(nextRovingIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("the phone's menu (F-147)", () => {
  const shellWith = (needsYou: number | null): ShellState => {
    const noop = () => undefined;
    return {
      me: { userId: userIdSchema.parse("u-1"), name: "Alex Kim", username: "alex", email: "alex@example.com", instanceAdmin: false, passwordChange: "none", theme: "dark", memberId: null, organization: null, noMembership: null },
      organizationId: null,
      place: { space: "home", row: "overview" },
      placed: true,
      space: "home",
      projectId: null,
      band: "phone",
      choice: defaultSidebar,
      opened: false,
      shown: false,
      held: false,
      hold: noop,
      toggle: noop,
      dock: noop,
      hide: noop,
      setWidth: noop,
      peek: null,
      peekControl: { enter: noop, hold: noop, leave: noop, close: noop, dispose: noop },
      spaceHref: () => "/",
      needsYou,
      recentTasks: [],
    } as const satisfies ShellState;
  };
  const draw = (needsYou: number | null, open: boolean) =>
    renderToStaticMarkup(
      <ShellStateContext.Provider value={shellWith(needsYou)}>
        <MenuButton open={open} onOpen={() => undefined} />
      </ShellStateContext.Provider>,
    );

  it("F-147/c6: the top bar's menu button opens the sheet as a dialog, named, with an amber dot only while something needs the member", () => {
    const quiet = draw(0, false);
    expect(quiet).toContain('aria-haspopup="dialog"');
    expect(quiet).toContain('aria-expanded="false"');
    expect(quiet).toContain('aria-controls="shell-nav-sheet"');
    expect(quiet).toContain(`aria-label="${t("shell.openNavigation")}"`);
    expect(quiet).not.toContain("menu-needs-you-dot");
    const waiting = draw(3, true);
    expect(waiting).toContain(`aria-label="${t("shell.menu.openWithCount", { n: 3 })}"`);
    expect(waiting).toContain('aria-expanded="true"');
    expect(waiting).toContain("menu-needs-you-dot");
    expect(draw(null, false)).not.toContain("menu-needs-you-dot");
  });
});
