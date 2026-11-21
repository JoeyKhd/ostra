// F-145 (ADR 0069, ADR 0021 amended, ticket 27): the library's calls out, other than GitHub's
// (which go through the code host adapter). Every one goes only to the source an admin named: a
// redirect is followed only on the same origin, and never to another host. Each carries a fixed
// `User-Agent` of `ostra/<version>` and nothing else that identifies the install, the organization
// or the member: no cookie, and no credential but the ones an admin gave for that source (an MCP
// server's headers). A body is read up to a cap,
// under a deadline. Nothing a source answers reaches a log line or an error's words.

/** The deps a call out needs: the fetch the server was given, and its version for the `User-Agent`. */
export type OutboundDeps = { readonly fetch: typeof fetch; readonly serverVersion: string };

/** The one `User-Agent` the library's calls carry. */
export const libraryUserAgent = (serverVersion: string): string => `ostra/${serverVersion}`;

/** The most redirects a call follows, each on the same origin. */
const REDIRECTS_MAX = 3;

export type OutboundAnswer = {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  /** The URL that answered, after same-origin redirects. */
  readonly url: string;
};

export type OutboundFailure =
  /** No answer: refused, timed out, or redirected to another origin. */
  | { readonly kind: "unavailable"; readonly reason: "unreachable" | "timeout" | "other-origin" | "too-many-redirects" }
  /** The body was longer than the cap. */
  | { readonly kind: "too-large" };

export type OutboundResult = { readonly ok: true; readonly answer: OutboundAnswer } | { readonly ok: false; readonly failure: OutboundFailure };

export type OutboundRequest = {
  readonly method?: "GET" | "POST" | "DELETE";
  /** Headers of the call besides the `User-Agent`, which is always ostra's own. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxBytes: number;
  /** Shared by every call of one operation, so the whole has one deadline. */
  readonly signal: AbortSignal;
  /** Follow same-origin redirects (a site's index); `false` treats one as no answer (an MCP server). */
  readonly followRedirects: boolean;
  /** Stop reading once the body so far holds what's wanted (a server-sent stream left open). */
  readonly until?: (bytesSoFar: Uint8Array) => boolean;
};

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/** Reads a body up to `maxBytes`, cancelling the rest: `null` when it's longer. */
const readCapped = async (response: Response, maxBytes: number, until: ((bytesSoFar: Uint8Array) => boolean) | undefined): Promise<Uint8Array | null> => {
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk: unknown = next.value;
    if (!(chunk instanceof Uint8Array)) {
      await reader.cancel();
      return null;
    }
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
    if (until?.(concat(chunks, total)) === true) {
      await reader.cancel();
      break;
    }
  }
  return concat(chunks, total);
};

/** One call out to the source an admin named, and its same-origin redirects. */
export const callOut = async (deps: OutboundDeps, url: string, request: OutboundRequest): Promise<OutboundResult> => {
  const origin = new URL(url).origin;
  let target = url;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop += 1) {
    let response: Response;
    try {
      response = await deps.fetch(target, {
        method: request.method ?? "GET",
        headers: { ...request.headers, "user-agent": libraryUserAgent(deps.serverVersion) },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "manual",
        signal: request.signal,
      });
    } catch (error) {
      return { ok: false, failure: { kind: "unavailable", reason: isTimeout(error) ? "timeout" : "unreachable" } };
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      if (!request.followRedirects) {
        return { ok: false, failure: { kind: "unavailable", reason: "other-origin" } };
      }
      const next = URL.canParse(location, target) ? new URL(location, target) : null;
      if (next?.origin !== origin) {
        return { ok: false, failure: { kind: "unavailable", reason: "other-origin" } };
      }
      target = next.toString();
      continue;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(response, request.maxBytes, request.until);
    } catch (error) {
      return { ok: false, failure: { kind: "unavailable", reason: isTimeout(error) ? "timeout" : "unreachable" } };
    }
    if (bytes === null) {
      return { ok: false, failure: { kind: "too-large" } };
    }
    return { ok: true, answer: { status: response.status, headers: response.headers, bytes, url: target } };
  }
  return { ok: false, failure: { kind: "unavailable", reason: "too-many-redirects" } };
};

const decoder = new TextDecoder();

/** A body read as JSON, or `undefined` when it isn't. */
export const jsonOf = (bytes: Uint8Array): unknown => {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return parsed;
  } catch {
    return undefined;
  }
};

/** The words of a failure, for a person: never a source's own text. */
export const outboundFailureWords = (what: string, failure: OutboundFailure): string => {
  switch (failure.kind) {
    case "too-large":
      return `${what} answered with more than ostra reads`;
    case "unavailable":
      switch (failure.reason) {
        case "timeout":
          return `${what} didn't answer in time`;
        case "other-origin":
          return `${what} redirected to another address, which ostra doesn't follow`;
        case "too-many-redirects":
          return `${what} redirected too many times`;
        case "unreachable":
          return `${what} couldn't be reached`;
        default:
          return failure.reason satisfies never;
      }
    default:
      return failure satisfies never;
  }
};
