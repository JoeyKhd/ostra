import type { World } from "./world.ts";

// The scenarios that play a client of the real server (the panel, a runner) go through
// `fetch`, as that client would. Responses are returned unparsed: each caller validates
// the body with its own Zod schema.

export type Reply = {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
};

export type RequestOptions = {
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

/** One request to better-auth, served at `<base>/api/auth<path>`. */
export const send = async (base: string, path: string, init: RequestOptions): Promise<Reply> => {
  const response = await fetch(`${base}/api/auth${path}`, {
    method: init.method,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
};

/** What the member's browser sends: their session cookie and the page's own origin. */
export const browserHeaders = (world: World, cookie: string | null): Record<string, string> => ({
  origin: world.server.url,
  ...(cookie === null ? {} : { cookie }),
});
