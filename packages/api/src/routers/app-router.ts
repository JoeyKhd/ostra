import { router } from "../trpc/init.ts";
import { automationsRouter } from "./automations.ts";
import { boardsRouter } from "./boards.ts";
import { diffRouter } from "./diff.ts";
import { draftsRouter } from "./drafts.ts";
import { reviewRouter } from "./review.ts";
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
import { previewsRouter } from "./previews.ts";
import { joinTokensRouter, poolsRouter } from "./pools.ts";
import { boxSizesRouter } from "./box-sizes.ts";
import { registryRouter } from "./registry.ts";
import { fleetUseRouter } from "./fleet-use.ts";
import { registryUseRouter } from "./registry-use.ts";
import { runnersRouter } from "./runners.ts";
import { streamRouter } from "./stream.ts";
import { approvalsRouter, tasksRouter } from "./tasks.ts";
import { ticketsRouter } from "./tickets.ts";
import { accountRouter } from "./account.ts";
import { accountsRouter } from "./accounts.ts";
import { auditRouter } from "./audit.ts";
import { searchRouter } from "./search.ts";
import { invitationsRouter } from "./invitations.ts";
import { membersRouter } from "./members.ts";
import { agentProfilesRouter } from "./agent-profiles.ts";
import { insightsRouter } from "./insights.ts";
import { budgetsRouter, spendRouter } from "./spend.ts";
import { memoryRouter } from "./memory.ts";
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
  members: membersRouter,
  invitations: invitationsRouter,
  accounts: accountsRouter,
  audit: auditRouter,
  search: searchRouter,
  instance: instanceRouter,
  providers: providersRouter,
  agentProfiles: agentProfilesRouter,
  github: githubRouter,
  linear: linearRouter,
  projects: projectsRouter,
  boards: boardsRouter,
  inbox: inboxRouter,
  tickets: ticketsRouter,
  automations: automationsRouter,
  environments: environmentsRouter,
  diff: diffRouter,
  tasks: tasksRouter,
  approvals: approvalsRouter,
  questions: questionsRouter,
  plans: plansRouter,
  runners: runnersRouter,
  pools: poolsRouter,
  joinTokens: joinTokensRouter,
  boxSizes: boxSizesRouter,
  registry: registryRouter,
  fleetUse: fleetUseRouter,
  registryUse: registryUseRouter,
  stream: streamRouter,
  insights: insightsRouter,
  spend: spendRouter,
  budgets: budgetsRouter,
  memory: memoryRouter,
  drafts: draftsRouter,
  review: reviewRouter,
  // Milestone 8 (ticket 20): previews, their views and sharing.
  previews: previewsRouter,
});

export type AppRouter = typeof appRouter;
