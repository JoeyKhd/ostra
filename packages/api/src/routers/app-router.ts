import { router } from "../trpc/init.ts";
import { meRouter, organizationRouter } from "./organization.ts";
import { setupRouter } from "./setup.ts";

/** Every router of the panel's API. `AppRouter` is the type the web app imports, and nothing else. */
export const appRouter = router({
  setup: setupRouter,
  me: meRouter,
  organization: organizationRouter,
});

export type AppRouter = typeof appRouter;
