import { appRouter, createCallerFactory, createContext } from "@ostra/api";
import { headers } from "next/headers";

import { getApiDeps } from "./deps";

const createCaller = createCallerFactory(appRouter);

/**
 * The API as a server component calls it: the same procedures, middleware and access checks as
 * the browser's requests, with the request's own session.
 */
export const getServerApi = async () => {
  // Reading the request's headers first makes the page dynamic, so nothing runs at build time.
  const requestHeaders = await headers();
  const deps = await getApiDeps();
  const context = await createContext(deps, { headers: requestHeaders, resHeaders: new Headers() });
  // F-082: the session's theme, which the root layout paints before the first frame.
  return { caller: createCaller(context), signedIn: context.user !== null, theme: context.user?.theme ?? null };
};
