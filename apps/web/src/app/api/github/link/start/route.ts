import { createContext, startGitHubLink } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// The verified GitHub link's start (F-119, ADR 0052, ticket 39): a member who is signed in is sent to
// GitHub's sign-in for the App, with a `state` bound to their session for ten minutes. One who is
// not goes to sign in first and comes back.

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const deps = await getApiDeps();
  const started = await startGitHubLink(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }));
  switch (started.kind) {
    case "redirect":
      return Response.redirect(started.url, 303);
    case "sign-in": {
      const signIn = new URL("/sign-in", url);
      signIn.searchParams.set("next", "/api/github/link/start");
      return Response.redirect(signIn, 303);
    }
    case "not-connected":
    case "unavailable": {
      const back = new URL("/account", url);
      back.searchParams.set("github", "failed");
      return Response.redirect(back, 303);
    }
    default:
      return started satisfies never;
  }
};
