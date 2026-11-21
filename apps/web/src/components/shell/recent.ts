import { z } from "zod";

// What the member opened lately, kept in this browser only (app-shell.md: Home's `Recent`, the
// Projects panel's `Other projects`). Per organization, never synced, and safe to lose: a private
// window or blocked storage reads as empty.

export const RECENT_TASKS_MAX = 5;
export const RECENT_PROJECTS_MAX = 12;

export const recentTaskSchema = z.object({ taskId: z.string().min(1).max(100), key: z.string().max(100), title: z.string().max(500) });
export type RecentTask = z.infer<typeof recentTaskSchema>;

const tasksSchema = z.array(recentTaskSchema).max(50);
const projectsSchema = z.array(z.string().min(1).max(100)).max(50);

const tasksKey = (organizationId: string): string => `ostra.recent-tasks.${organizationId}`;
const projectsKey = (organizationId: string): string => `ostra.recent-projects.${organizationId}`;

/** The newest first, each once, at most `max`. */
export const pushRecent = <T,>(list: readonly T[], item: T, same: (a: T, b: T) => boolean, max: number): readonly T[] => [item, ...list.filter((other) => !same(other, item))].slice(0, max);

const read = <T,>(key: string, schema: z.ZodType<T>, empty: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return empty;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is blocked or full: the list just isn't kept.
  }
};

export const readRecentTasks = (organizationId: string): readonly RecentTask[] => read(tasksKey(organizationId), tasksSchema, []);

export const rememberTask = (organizationId: string, task: RecentTask): readonly RecentTask[] => {
  const next = pushRecent(readRecentTasks(organizationId), task, (a, b) => a.taskId === b.taskId, RECENT_TASKS_MAX);
  write(tasksKey(organizationId), next);
  return next;
};

export const readRecentProjects = (organizationId: string): readonly string[] => read(projectsKey(organizationId), projectsSchema, []);

export const rememberProject = (organizationId: string, projectId: string): readonly string[] => {
  const next = pushRecent(readRecentProjects(organizationId), projectId, (a, b) => a === b, RECENT_PROJECTS_MAX);
  write(projectsKey(organizationId), next);
  return next;
};

/**
 * `Other projects`: the three most recently opened besides the open one, then the rest of the
 * member's projects in their order, so a first visit still lists three.
 */
export const otherProjects = <P extends { readonly id: string },>(projects: readonly P[], recent: readonly string[], openId: string | null, count = 3): readonly P[] => {
  const byId = new Map(projects.map((project) => [project.id, project] as const));
  const ordered = [...recent.flatMap((id) => {
    const found = byId.get(id);
    return found === undefined ? [] : [found];
  }), ...projects];
  const seen = new Set<string>(openId === null ? [] : [openId]);
  const out: P[] = [];
  for (const project of ordered) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    out.push(project);
    if (out.length === count) break;
  }
  return out;
};
