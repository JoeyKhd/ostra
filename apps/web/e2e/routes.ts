import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { z } from "zod";

import { e2eAdmin } from "./settings.ts";

// Every route of the panel, milestones 1 to 8 (ticket 19's phone sweep, ticket 20's pseudo-locale
// pass), with the IDs `seed-routes-world.ts` seeds behind the ones that need one. A route added to
// `src/app` without its line here fails `routes.test.ts`... the spec that walks them lists each
// `page.tsx` and fails on one this file doesn't name.

const run = promisify(execFile);

const worldSchema = z.object({
  projectId: z.string(),
  approval: z.object({ taskId: z.string(), approvalId: z.string() }),
  question: z.object({ taskId: z.string(), questionId: z.string() }),
  reopen: z.object({ taskId: z.string() }),
  capped: z.object({ taskId: z.string() }),
  /**
   * Milestone 8 (ticket 21): a task with an app to preview, its box asleep, and a watch-only link's
   * token; F-142: its level's ID, which names the plain member, for the preview's own page.
   */
  preview: z.object({ taskId: z.string(), token: z.string(), previewId: z.string() }),
  /** A running task, in the project's Live list beside the needs-you ones. */
  running: z.object({ taskId: z.string() }),
  orgNoteId: z.string(),
  /** Milestone 11 (F-152): the organization's Linear tracker connection, for its own page. */
  trackerConnectionId: z.string(),
  projectNoteId: z.string(),
  poolId: z.string(),
  runnerId: z.string(),
  profileId: z.string(),
  /** Milestone 8 (ticket 31): a library skill with an update waiting. */
  libraryItemId: z.string(),
  invitationId: z.string(),
  automationId: z.string(),
  parentTicketId: z.string(),
  /** The member who opens the routes, an organization and instance admin (its password: `e2eAdmin.password`). */
  username: z.string(),
  /** A member of the organization who isn't an admin (the same password). */
  memberUsername: z.string(),
  userData: z.array(z.string()),
});
export type RoutesWorld = z.infer<typeof worldSchema>;

/** Seeds the routes' world in the stack's database (`seed-routes-world.ts`). */
export const seedRoutesWorld = async (databaseUrl: string, tag: string): Promise<RoutesWorld> => {
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-routes-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** One route: its `src/app` pattern, and the address it's opened at. */
export type PanelRoute = { readonly pattern: string; readonly path: string };

/** The routes a signed-in member opens. */
export const memberRoutes = (world: RoutesWorld): readonly PanelRoute[] => {
  const p = world.projectId;
  return [
    { pattern: "/", path: "/" },
    { pattern: "/needs-you", path: "/needs-you" },
    { pattern: "/search", path: "/search?q=left-pad" },
    { pattern: "/account", path: "/account" },
    { pattern: "/account/notifications", path: "/account/notifications" },
    { pattern: "/device", path: "/device" },
    { pattern: "/instance/accounts", path: "/instance/accounts" },
    // Milestone 8 (ticket 26): the preview domain and its check.
    { pattern: "/instance/previews", path: "/instance/previews" },
    { pattern: "/organization/agent-profiles", path: "/organization/agent-profiles" },
    { pattern: "/organization/agent-profiles/new", path: "/organization/agent-profiles/new" },
    { pattern: "/organization/agent-profiles/[profile-id]", path: `/organization/agent-profiles/${world.profileId}` },
    { pattern: "/organization/audit", path: "/organization/audit" },
    { pattern: "/organization/box-sizes", path: "/organization/box-sizes" },
    { pattern: "/organization/email", path: "/organization/email" },
    { pattern: "/organization/github", path: "/organization/github" },
    { pattern: "/organization/insights", path: "/organization/insights" },
    // Milestone 11 (F-152; ticket 12): every tracker connection, and one's own page. Linear's old
    // address redirects, so it lands on the first Linear connection's page.
    { pattern: "/organization/linear", path: "/organization/linear" },
    { pattern: "/organization/trackers", path: "/organization/trackers" },
    { pattern: "/organization/trackers/[connection-id]", path: `/organization/trackers/${world.trackerConnectionId}` },
    { pattern: "/organization/members", path: "/organization/members" },
    { pattern: "/organization/memory", path: "/organization/memory" },
    { pattern: "/organization/memory/new", path: "/organization/memory/new" },
    { pattern: "/organization/memory/proposals", path: "/organization/memory/proposals" },
    { pattern: "/organization/memory/[note-id]", path: `/organization/memory/${world.orgNoteId}` },
    { pattern: "/organization/models", path: "/organization/models" },
    { pattern: "/organization/previews", path: "/organization/previews" },
    { pattern: "/organization/registry", path: "/organization/registry" },
    { pattern: "/organization/runners", path: "/organization/runners" },
    { pattern: "/organization/skills", path: "/organization/skills" },
    { pattern: "/organization/skills/[item-id]", path: `/organization/skills/${world.libraryItemId}` },
    { pattern: "/organization/skills/marketplace", path: "/organization/skills/marketplace" },
    { pattern: "/organization/skills/suggestions", path: "/organization/skills/suggestions" },
    { pattern: "/organization/runners/[runner-id]", path: `/organization/runners/${world.runnerId}` },
    { pattern: "/organization/runners/pools/[pool-id]", path: `/organization/runners/pools/${world.poolId}` },
    { pattern: "/organization/spend", path: "/organization/spend" },
    { pattern: "/organization/storage", path: "/organization/storage" },
    { pattern: "/projects/new", path: "/projects/new" },
    { pattern: "/projects/[project-id]", path: `/projects/${p}` },
    { pattern: "/projects/[project-id]/automations", path: `/projects/${p}/automations` },
    { pattern: "/projects/[project-id]/automations/new", path: `/projects/${p}/automations/new?starts=schedule` },
    { pattern: "/projects/[project-id]/automations/[automation-id]", path: `/projects/${p}/automations/${world.automationId}` },
    { pattern: "/projects/[project-id]/automations/[automation-id]/history", path: `/projects/${p}/automations/${world.automationId}/history` },
    { pattern: "/projects/[project-id]/boards", path: `/projects/${p}/boards` },
    { pattern: "/projects/[project-id]/environment", path: `/projects/${p}/environment` },
    { pattern: "/projects/[project-id]/inbox", path: `/projects/${p}/inbox` },
    { pattern: "/projects/[project-id]/insights", path: `/projects/${p}/insights` },
    { pattern: "/projects/[project-id]/memory", path: `/projects/${p}/memory` },
    { pattern: "/projects/[project-id]/needs-approval", path: `/projects/${p}/needs-approval` },
    { pattern: "/projects/[project-id]/memory/new", path: `/projects/${p}/memory/new` },
    { pattern: "/projects/[project-id]/memory/proposals", path: `/projects/${p}/memory/proposals` },
    { pattern: "/projects/[project-id]/memory/[note-id]", path: `/projects/${p}/memory/${world.projectNoteId}` },
    { pattern: "/projects/[project-id]/repos", path: `/projects/${p}/repos` },
    { pattern: "/projects/[project-id]/settings", path: `/projects/${p}/settings` },
    { pattern: "/projects/[project-id]/tickets/[ticket-id]", path: `/projects/${p}/tickets/${world.parentTicketId}` },
    { pattern: "/projects/[project-id]/settings/access", path: `/projects/${p}/settings/access` },
    { pattern: "/projects/[project-id]/settings/audit", path: `/projects/${p}/settings/audit` },
    { pattern: "/projects/[project-id]/settings/models", path: `/projects/${p}/settings/models` },
    { pattern: "/projects/[project-id]/settings/repos", path: `/projects/${p}/settings/repos` },
    { pattern: "/projects/[project-id]/settings/runners", path: `/projects/${p}/settings/runners` },
    { pattern: "/projects/[project-id]/settings/review", path: `/projects/${p}/settings/review` },
    { pattern: "/projects/[project-id]/settings/ticket-template", path: `/projects/${p}/settings/ticket-template` },
    { pattern: "/tasks/new", path: "/tasks/new" },
    { pattern: "/tasks/[task-id]", path: `/tasks/${world.reopen.taskId}` },
    { pattern: "/tasks/[task-id]/review", path: `/tasks/${world.reopen.taskId}/review` },
  ];
};

/**
 * F-142: the routes a signed-in member opens outside the panel's shell, with no place in its rail:
 * a preview's own page (the app isn't running, so it says so).
 */
export const sharedRoutes = (world: RoutesWorld): readonly PanelRoute[] => [{ pattern: "/previews/[preview-id]", path: `/previews/${world.preview.previewId}` }];

/**
 * The routes a visitor opens signed out. `/setup` and `/change-password` send a signed-in
 * member on, so they're opened signed out too (`/change-password` then shows sign-in).
 */
export const visitorRoutes = (world: RoutesWorld): readonly PanelRoute[] => [
  { pattern: "/sign-in", path: "/sign-in" },
  { pattern: "/setup", path: "/setup" },
  { pattern: "/change-password", path: "/change-password" },
  { pattern: "/reset", path: "/reset" },
  { pattern: "/reset/new", path: "/reset/new?token=not-a-real-token" },
  { pattern: "/invite/[invitation-id]", path: `/invite/${world.invitationId}` },
  // Milestone 8 (ticket 21): a preview link's viewer page.
  { pattern: "/p/[token]", path: `/p/${world.preview.token}` },
];

/** Every `page.tsx` under `src/app`, as its route pattern (route groups dropped). */
export const appRoutePatterns = async (): Promise<readonly string[]> => {
  const { readdir } = await import("node:fs/promises");
  const appDir = path.resolve(import.meta.dirname, "..", "src", "app");
  const entries = await readdir(appDir, { recursive: true });
  return entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry === "page.tsx" || entry.endsWith("/page.tsx"))
    .map((entry) => `/${entry.replace(/\/?page\.tsx$/, "")}`.replace(/\/\([^)]+\)/g, "") || "/")
    .map((pattern) => (pattern === "" ? "/" : pattern))
    .sort();
};

/**
 * Waits until a route has drawn its data: it has a heading, no skeleton or busy region is left,
 * the fonts are in, and nothing on the page has changed for half a second (at most 8 s of it).
 */
export const settleRoute = async (page: Page): Promise<void> => {
  await page.waitForLoadState("load");
  await page.locator("h1").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelector('[aria-busy]:not([aria-busy="false"]), .animate-pulse') === null, undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const observer = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(done, 500);
        });
        const done = () => {
          observer.disconnect();
          clearTimeout(cap);
          resolve();
        };
        const cap = setTimeout(done, 8_000);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        quiet = setTimeout(done, 500);
      }),
  );
};
