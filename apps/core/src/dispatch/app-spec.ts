import type { CodeHostAdapter, RepoAccess } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { appProcessesFromDetected, appProcessesInTx, detectedAppProcesses, detectRepoEnvironment, screenshotSettingsSchema, specScreenshots } from "@ostra/domain";
import type { AppProcess } from "@ostra/domain";
import { defaultOstraToolSets } from "@ostra/protocol";
import type { OstraToolSet, RepoId, TaskSpecAppProcess, TaskSpecScreenshots } from "@ostra/protocol";

// Milestone 8's parts of a task spec (F-121, F-140, ADR 0068; ticket 15): the environment's app
// processes, its "Screenshots after each turn" and the `app` tools, for a runner at protocol minor
// 7 only. A minor-6 runner gets none of them and runs the task as before (`isTaskOfferable`, ticket
// 01, never refuses it then); its page says the runner needs upgrading (`taskAppSupport`). A
// process's command goes in the spec for the runner to run, and is never logged.
//
// An onboarding task tests the draft (F-113): with no app process saved, it gets the processes
// detection finds that have a command, so `start_app` starts them in its box.

/** The protocol minor that reads app processes, the screenshots' settings and the `app` tools. */
export const APP_MINOR = 7;

export type AppSpecParts = {
  /** The processes, in the order the runner starts them; absent when there are none. */
  readonly appProcesses?: readonly TaskSpecAppProcess[];
  /** The after-turn screenshots; absent without app processes. Off without a primary. */
  readonly screenshots?: TaskSpecScreenshots;
  /** Whether the sidecar serves the `app` tools: a minor-7 runner, and an agent that reaches ostra's MCP server. */
  readonly appTools: boolean;
};

/** A repo of the task as the spec reads it: its access, for an onboarding task's detection. */
export type AppSpecRepo = { readonly repoId: RepoId; readonly access: RepoAccess; readonly defaultBranch: string };

/** The environment's "Screenshots after each turn", as its columns hold them; the defaults when a column doesn't read. */
const screenshotSettingsOf = (environment: { readonly screenshotsAfterTurn: boolean; readonly screenshotRoutes: unknown; readonly screenshotWidths: unknown }) => {
  const parsed = screenshotSettingsSchema.safeParse({ afterTurn: environment.screenshotsAfterTurn, routes: environment.screenshotRoutes, widths: environment.screenshotWidths });
  return parsed.success ? parsed.data : screenshotSettingsSchema.parse({ afterTurn: environment.screenshotsAfterTurn });
};

export const specAppParts = async (
  deps: { readonly db: Db; readonly codeHost: CodeHostAdapter },
  task: { readonly projectId: string; readonly organizationId: string; readonly onboarding: boolean },
  input: {
    /** The minor the runner reads the spec at. */
    readonly minor: number;
    /** The agent reaches ostra's MCP server (the adapter's `memory: "mcp"`, as the memory tools take it). */
    readonly agentHasMcp: boolean;
    /** The task's repos, in its order. */
    readonly repos: readonly AppSpecRepo[];
  },
): Promise<AppSpecParts> => {
  if (input.minor < APP_MINOR) {
    return { appTools: false };
  }
  const appTools = input.agentHasMcp;
  const environment = await deps.db.environment.findFirst({
    where: { projectId: task.projectId, organizationId: task.organizationId },
    select: { id: true, screenshotsAfterTurn: true, screenshotRoutes: true, screenshotWidths: true },
  });
  if (environment === null) {
    return { appTools };
  }
  let processes: readonly AppProcess[] = await appProcessesInTx(deps.db, environment.id);
  if (processes.length === 0 && task.onboarding) {
    const detected = [];
    for (const repo of input.repos) {
      detected.push({ repoId: repo.repoId, processes: (await detectRepoEnvironment(deps.codeHost, repo.access, repo.defaultBranch)).appProcesses });
    }
    processes = appProcessesFromDetected(detectedAppProcesses(detected));
  }
  // A process runs in one of the task's own repos: one in a repo the box doesn't check out can't start.
  const inTask = processes.filter((process) => input.repos.some((repo) => repo.repoId === process.repoId));
  if (inTask.length === 0) {
    return { appTools };
  }
  return { appProcesses: inTask, screenshots: specScreenshots(screenshotSettingsOf(environment), inTask), appTools };
};

/**
 * The spec's `tools` (ADR 0028, ADR 0068): the kind's own sets (a refine draft's, a review's, an
 * onboarding task's), or milestone 4's when it has none, with `app` added when the sidecar serves
 * the app tools. `undefined` keeps the field out, as before milestone 8.
 */
export const specToolSets = (base: readonly OstraToolSet[] | undefined, appTools: boolean): readonly OstraToolSet[] | undefined =>
  appTools ? [...(base ?? defaultOstraToolSets).filter((tool) => tool !== "app"), "app"] : base;
