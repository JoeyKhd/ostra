import { appRouter, createCallerFactory, createContext } from "@ostra/api";
import { TRPCError } from "@trpc/server";

import { getApiDeps } from "@/server/deps";

// The Linear consent flow's return (F-005, ticket 27): Linear redirects here with a `code` and the
// `state` the panel sent, or with an `error`. The router checks the state is this admin's own, from
// this session, unexpired and unused; exchanges the code; checks that the token is the app's own
// user; and stores both tokens. The admin lands back on the connection's page (milestone 11, F-152:
// `/organization/trackers/<id>`), or, when Linear's workspace is already another connection's, on
// that one's; with Linear's refusal (or ostra's) in words when it did not work. A refusal that names
// no connection goes to `/organization/linear`, which leads on to the first Linear connection. A
// code, a state and a token are never in that message.

const createCaller = createCallerFactory(appRouter);

export const dynamic = "force-dynamic";

/** What Linear's `error` parameter means, in words. Anything else is the plain failure. */
const LINEAR_REFUSALS: Readonly<Record<string, string>> = {
  access_denied: "Linear's consent was declined, so the connection is not made. Authorize again when you are ready.",
};

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const back = new URL("/organization/linear", url);
  const refused = url.searchParams.get("error");
  if (refused !== null) {
    back.searchParams.set("error", LINEAR_REFUSALS[refused] ?? "Linear did not complete the sign-in. Authorize again.");
    return Response.redirect(back, 303);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) {
    back.searchParams.set("error", "Linear didn't send the consent back. Authorize again.");
    return Response.redirect(back, 303);
  }
  const deps = await getApiDeps();
  const caller = createCaller(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }));
  try {
    const done = await caller.trackers.linear.complete({ code, state });
    if (done.ok) {
      const page = new URL(`/organization/trackers/${done.connectionId}`, url);
      page.searchParams.set("connected", "1");
      return Response.redirect(page, 303);
    }
    const holder = new URL(`/organization/trackers/${done.holder.id}`, url);
    holder.searchParams.set("error", done.message);
    return Response.redirect(holder, 303);
  } catch (error) {
    back.searchParams.set("error", error instanceof TRPCError ? error.message : "Connecting Linear failed. Authorize again.");
  }
  return Response.redirect(back, 303);
};
