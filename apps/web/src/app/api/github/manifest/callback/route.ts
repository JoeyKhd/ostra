import { appRouter, createCallerFactory, createContext } from "@ostra/api";
import { TRPCError } from "@trpc/server";

import { getApiDeps } from "@/server/deps";

// The manifest flow's return (F-006, ticket 31): GitHub redirects here with a code and the
// `state` the panel sent. The router checks the state is this admin's own, unexpired and unused,
// converts the code and stores the App's secrets. The admin lands back on the GitHub page.

const createCaller = createCallerFactory(appRouter);

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const back = new URL("/organization/github", url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) {
    back.searchParams.set("error", "GitHub didn't send the App back. Start again.");
    return Response.redirect(back, 303);
  }
  const deps = await getApiDeps();
  const caller = createCaller(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }));
  try {
    await caller.github.completeManifest({ code, state });
    back.searchParams.set("connected", "1");
  } catch (error) {
    back.searchParams.set("error", error instanceof TRPCError ? error.message : "Connecting the App failed. Start again.");
  }
  return Response.redirect(back, 303);
};
