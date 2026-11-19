import { completeGitHubLink, createContext } from "@ostra/api";

import { getApiDeps } from "@/server/deps";

// The verified GitHub link's return (F-119, ADR 0052, ticket 39): GitHub sends the member back with
// a `code` and the `state` the panel made, or with an `error` when they declined. The state must be
// the member's own, from this session, unexpired and unused. The member lands on Account with
// `?github=linked`, `taken`, `revoke-failed` or `failed`; no code, state or token is in the address.

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const deps = await getApiDeps();
  const result = await completeGitHubLink(await createContext(deps, { headers: request.headers, resHeaders: new Headers() }), {
    code: url.searchParams.get("error") === null ? url.searchParams.get("code") : null,
    state: url.searchParams.get("state"),
  });
  const back = new URL("/account", url);
  back.searchParams.set("github", result.outcome);
  return Response.redirect(back, 303);
};
