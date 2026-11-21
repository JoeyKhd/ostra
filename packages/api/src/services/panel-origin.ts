// The panel's own origin, for the requests that change something (milestone 8, ticket 25, F-144,
// ADR 0068 "The panel's own defences"). A preview host can share the panel's site, and with it the
// panel's `SameSite=Lax` cookie: agent-written code on it could send a request the browser signs
// with the member's session. So a request that changes something must name the panel's own origin
// in `Origin`, as browsers do on every such request; one that names none (a client that isn't a
// browser, which carries no cookie of a page's) must not come from another site by the browser's
// own `Sec-Fetch-Site`. A request that only reads may come from anywhere: the browser keeps its
// answer from another origin's page.

/** The methods that change something. */
const changing = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether `request` may go on: it only reads, or it comes from the panel's own pages (`OSTRA_PUBLIC_URL`). */
export const fromPanelOrigin = (request: Request, publicUrl: string): boolean => {
  if (!changing.has(request.method.toUpperCase())) {
    return true;
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === new URL(publicUrl).origin;
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
};

/** The answer to a request from another origin: a code, and words that name nothing of the panel. */
export const foreignOriginRefusal = (): Response =>
  Response.json({ error: { code: "forbidden", message: "A change to ostra must come from ostra's own pages." } }, { status: 403, headers: { "cache-control": "no-store" } });
