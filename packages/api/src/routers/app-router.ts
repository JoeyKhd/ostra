import { router } from "../trpc/init.ts";
import { environmentsRouter } from "./environments.ts";
import { githubRouter } from "./github.ts";
import { homeRouter } from "./home.ts";
import { instanceRouter } from "./instance.ts";
import { meRouter, organizationRouter } from "./organization.ts";
import { projectsRouter } from "./projects.ts";
import { poolsRouter, runnersRouter } from "./runners.ts";
import { streamRouter } from "./stream.ts";
import { approvalsRouter, tasksRouter } from "./tasks.ts";
import { agentProfilesRouter, providersRouter } from "./providers.ts";
import { setupRouter } from "./setup.ts";

/** Every router of the panel's API. `AppRouter` is the type the web app imports, and nothing else. */
export const appRouter = router({
  setup: setupRouter,
  me: meRouter,
  home: homeRouter,
  organization: organizationRouter,
  instance: instanceRouter,
  providers: providersRouter,
  agentProfiles: agentProfilesRouter,
  github: githubRouter,
  projects: projectsRouter,
  environments: environmentsRouter,
  tasks: tasksRouter,
  approvals: approvalsRouter,
  runners: runnersRouter,
  pools: poolsRouter,
  stream: streamRouter,
});

export type AppRouter = typeof appRouter;
