import { router } from "../trpc/init.ts";
import { boardsRouter } from "./boards.ts";
import { diffRouter } from "./diff.ts";
import { emailRouter } from "./email.ts";
import { environmentsRouter } from "./environments.ts";
import { githubRouter } from "./github.ts";
import { homeRouter } from "./home.ts";
import { inboxRouter } from "./inbox.ts";
import { instanceRouter } from "./instance.ts";
import { linearRouter } from "./linear.ts";
import { notificationsRouter } from "./notifications.ts";
import { meRouter, organizationRouter } from "./organization.ts";
import { projectsRouter } from "./projects.ts";
import { plansRouter, questionsRouter } from "./questions-plans.ts";
import { poolsRouter, runnersRouter } from "./runners.ts";
import { streamRouter } from "./stream.ts";
import { approvalsRouter, tasksRouter } from "./tasks.ts";
import { accountRouter } from "./account.ts";
import { agentProfilesRouter } from "./agent-profiles.ts";
import { providersRouter } from "./providers.ts";
import { setupRouter } from "./setup.ts";

/** Every router of the panel's API. `AppRouter` is the type the web app imports, and nothing else. */
export const appRouter = router({
  setup: setupRouter,
  me: meRouter,
  account: accountRouter,
  home: homeRouter,
  notifications: notificationsRouter,
  email: emailRouter,
  organization: organizationRouter,
  instance: instanceRouter,
  providers: providersRouter,
  agentProfiles: agentProfilesRouter,
  github: githubRouter,
  linear: linearRouter,
  projects: projectsRouter,
  boards: boardsRouter,
  inbox: inboxRouter,
  environments: environmentsRouter,
  diff: diffRouter,
  tasks: tasksRouter,
  approvals: approvalsRouter,
  questions: questionsRouter,
  plans: plansRouter,
  runners: runnersRouter,
  pools: poolsRouter,
  stream: streamRouter,
});

export type AppRouter = typeof appRouter;
