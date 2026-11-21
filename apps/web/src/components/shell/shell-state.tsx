"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { taskIdSchema } from "@ostra/protocol";

import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { useActionScope } from "./actions/use-scope";
import { createPeek } from "./peek-timer";
import type { PeekController } from "./peek-timer";
import { placeOf, spaceTarget } from "./places";
import type { Place, Space } from "./places";
import { readRecentProjects, readRecentTasks, recentTaskSchema, rememberProject, rememberTask } from "./recent";
import type { RecentTask } from "./recent";
import { bandOf, clampWidth, panelShown, sidebarCookieLine, toggled } from "./sidebar-state";
import type { Band, SidebarChoice } from "./sidebar-state";

// The double sidebar's state (F-147): where the member is (the place, from the address, and a task's
// project from its page), the panel's choice and width (saved in the cookie the layout reads), the
// width band, the peek, and the last page of each space for this session.

type Me = RouterOutputs["me"]["get"];

export type ShellState = {
  readonly me: Me;
  readonly organizationId: string | null;
  readonly place: Place;
  /** Whether the page has a place of its own in `places.ts` (one without falls back to Home). */
  readonly placed: boolean;
  readonly space: Space;
  /** The project the Projects space is on: the address's, the task's, or the last one opened. */
  readonly projectId: string | null;
  /** The band once the browser is known (`null` while the server draws it: CSS decides then). */
  readonly band: Band | null;
  readonly choice: SidebarChoice;
  /** Whether the member opened the panel since the window crossed into a narrower band. */
  readonly opened: boolean;
  /** The panel shows docked (or, from 768 to 1023, laid over the page). */
  readonly shown: boolean;
  /**
   * A page holds the panel collapsed for now, never saved over the member's choice (milestone 8:
   * the task page's expanded preview). Docking it again lets go.
   */
  readonly held: boolean;
  readonly hold: (on: boolean) => void;
  readonly toggle: () => void;
  /** Shows the panel docked, as `panel-left-open` and the peek's last button do. */
  readonly dock: () => void;
  readonly hide: () => void;
  readonly setWidth: (width: number, save: boolean) => void;
  readonly peek: Space | null;
  readonly peekControl: PeekController;
  /** Where a click on a space goes now. */
  readonly spaceHref: (space: Space) => string;
  /** The member's open needs-you items, or `null` until it loads (or when it fails). */
  readonly needsYou: number | null;
  /**
   * The same items by project ID, from the same answer, so the Needs you panel's counts and the
   * projects' amber dots add up to `needsYou`; empty until it loads. A project with none is absent.
   */
  readonly needsYouByProject: ReadonlyMap<string, number>;
  /** The tasks the member opened lately in this organization, in this browser (Home's `Recent`). */
  readonly recentTasks: readonly RecentTask[];
};

/** The shell's state; a test provides its own value to draw one part alone. */
export const ShellStateContext = createContext<ShellState | null>(null);

/** The shell's state, or `null` for a page drawn outside the shell (a unit test of the page alone). */
export const useOptionalShellState = (): ShellState | null => useContext(ShellStateContext);

export const useShellState = (): ShellState => {
  const value = useContext(ShellStateContext);
  if (value === null) throw new Error("ShellStateProvider is missing");
  return value;
};

const queries = ["(min-width: 768px)", "(min-width: 1024px)", "(min-width: 1280px)"] as const;

const subscribeBand = (onChange: () => void): (() => void) => {
  const lists = queries.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
};

/** The window's band, `null` on the server. */
const useBand = (): Band | null => useSyncExternalStore(subscribeBand, () => bandOf(window.innerWidth), () => null);

const timers = {
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (handle: ReturnType<typeof setTimeout>) => { clearTimeout(handle); },
};

export const ShellStateProvider = ({ me, initial, children }: { readonly me: Me; readonly initial: SidebarChoice; readonly children: ReactNode }) => {
  const trpc = useTRPC();
  const pathname = usePathname();
  const search = useSearchParams();
  const scope = useActionScope();
  const organizationId = me.organization?.id ?? null;

  const found = placeOf(pathname, search.toString());
  const routed: Place = found ?? { space: "home", row: null };
  // A task's page learns its project from the task: the page's own `tasks.get`, the same query.
  const routedTask = routed.space === "projects" && routed.taskId !== null ? taskIdSchema.safeParse(routed.taskId) : null;
  const task = useQuery(trpc.tasks.get.queryOptions(routedTask?.success === true ? { taskId: routedTask.data } : skipToken));
  const place: Place = routed.space === "projects" && routed.taskId !== null && task.data !== undefined ? { ...routed, projectId: task.data.projectId } : routed;

  const projects = useQuery({ ...trpc.projects.list.queryOptions(), enabled: organizationId !== null });
  const [recentProjects, setRecentProjects] = useState<readonly string[]>([]);
  useEffect(() => {
    if (organizationId !== null) setRecentProjects(readRecentProjects(organizationId));
  }, [organizationId]);
  const placeProject = place.space === "projects" ? place.projectId : null;
  useEffect(() => {
    if (organizationId !== null && placeProject !== null) setRecentProjects(rememberProject(organizationId, placeProject));
  }, [organizationId, placeProject]);
  const [recentTasks, setRecentTasks] = useState<readonly RecentTask[]>([]);
  useEffect(() => {
    if (organizationId !== null) setRecentTasks(readRecentTasks(organizationId));
  }, [organizationId]);
  const scopedTask = scope.task;
  // Its facts, not its identity: the scope's object changes with each render of the task page.
  const openedFacts = scopedTask === null ? null : JSON.stringify({ taskId: scopedTask.taskId, key: scopedTask.key, title: scopedTask.title });
  useEffect(() => {
    if (organizationId === null || openedFacts === null) return;
    const parsed: unknown = JSON.parse(openedFacts);
    const task = recentTaskSchema.safeParse(parsed);
    if (task.success) setRecentTasks(rememberTask(organizationId, task.data));
  }, [organizationId, openedFacts]);
  const known = new Set<string>((projects.data ?? []).map((project) => project.id));
  // While the list loads, the last one opened in this browser stands (it's checked once the list is in).
  const lastProject = (projects.data === undefined ? recentProjects[0] : recentProjects.find((id) => known.has(id))) ?? null;
  const firstProject = projects.data?.[0]?.id ?? null;
  // The Projects space's project: the page's; while a task's page loads, the one opened last (most
  // often the panel the task was opened from); peeked from another space, the one opened last too.
  const projectId = place.space === "projects" ? (placeProject ?? (place.taskId === null ? null : lastProject)) : lastProject;

  // The last page of each space, for this session; another organization starts afresh.
  const last = useRef<Partial<Record<Space, string>>>({});
  useEffect(() => {
    last.current = {};
  }, [organizationId]);
  const query = search.toString();
  const here = query === "" ? pathname : `${pathname}?${query}`;
  useEffect(() => {
    last.current = { ...last.current, [routed.space]: here };
  }, [routed.space, here]);
  const spaceHref = useCallback(
    (target: Space) => spaceTarget(target, { current: place.space, last: last.current, projects: { last: lastProject, first: firstProject } }),
    [place.space, lastProject, firstProject],
  );

  // The panel: the saved choice, and what the member did since the last crossing of a band.
  const band = useBand();
  const [choice, setChoice] = useState<SidebarChoice>(initial);
  const [opened, setOpened] = useState(false);
  // Crossing into another band starts it afresh: the automatic collapse, never saved.
  const [seenBand, setSeenBand] = useState(band);
  if (seenBand !== band) {
    setSeenBand(band);
    setOpened(false);
  }
  const save = useCallback((next: SidebarChoice) => {
    document.cookie = sidebarCookieLine(next, window.location.protocol === "https:");
  }, []);
  const [held, setHeld] = useState(false);
  const shown = panelShown(band ?? "wide", choice, opened) && !held;

  const [peek, setPeek] = useState<Space | null>(null);
  const peekControl = useMemo(() => createPeek(setPeek, timers), []);
  useEffect(() => () => { peekControl.dispose(); }, [peekControl]);
  useEffect(() => {
    peekControl.close();
  }, [pathname, peekControl]);

  const toggle = useCallback(() => {
    // A page's hold lets go first: `[` shows the panel the page collapsed.
    if (held) {
      setHeld(false);
      peekControl.close();
      return;
    }
    const next = toggled(band ?? "wide", choice, opened);
    setChoice(next.choice);
    setOpened(next.opened);
    if (next.save) save(next.choice);
    peekControl.close();
  }, [band, choice, opened, save, peekControl, held]);
  const dock = useCallback(() => {
    peekControl.close();
    setHeld(false);
    if ((band ?? "wide") === "wide") {
      const next = { ...choice, collapsed: false };
      setChoice(next);
      save(next);
    } else setOpened(true);
  }, [band, choice, save, peekControl]);
  const hide = useCallback(() => {
    if ((band ?? "wide") === "wide") {
      const next = { ...choice, collapsed: true };
      setChoice(next);
      save(next);
    } else setOpened(false);
  }, [band, choice, save]);
  const setWidth = useCallback((width: number, keep: boolean) => {
    setChoice((now) => {
      const next = { ...now, width: clampWidth(width) };
      if (keep) save(next);
      return next;
    });
  }, [save]);

  // What waits on the member: the same query the shell's live region reads (one request).
  const waiting = useQuery({ ...trpc.notifications.openCount.queryOptions(), refetchInterval: 10_000, enabled: organizationId !== null });
  const needsYou = waiting.data?.count ?? null;
  const needsYouByProject = useMemo(() => new Map((waiting.data?.byProject ?? []).map((project) => [project.projectId, project.count] as const)), [waiting.data]);

  const value: ShellState = {
    me,
    organizationId,
    place,
    placed: found !== null,
    space: place.space,
    projectId,
    band,
    choice,
    opened,
    shown,
    held,
    hold: setHeld,
    toggle,
    dock,
    hide,
    setWidth,
    peek,
    peekControl,
    spaceHref,
    needsYou,
    needsYouByProject,
    recentTasks,
  };
  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
};
