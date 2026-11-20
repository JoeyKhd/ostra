import http from "node:http";
import https from "node:https";
import { parseHttpDownBody, parseJson, runnerHttpErrorSchema } from "@ostra/protocol";
import type { DownFrame, RunnerHttpError } from "@ostra/protocol";

// The runner's network layer for both carriers (milestone 5's ticket 18, ADR 0034, "Networks"):
// the agents that carry the WebSocket's upgrade and the HTTP carrier's requests, through
// `HTTPS_PROXY` (and `HTTP_PROXY`, `NO_PROXY`) with Node's own `proxyEnv` (Node 24.5+, no
// dependency), trusting `NODE_EXTRA_CA_CERTS` as every TLS connection of the process does; and the
// HTTP carrier's one request, its answer read as ostra's frames, ostra's error, or something else
// (a proxy's page), which is a network failure, never a verdict on the runner.

/** How the runner talks to the server: `auto` falls back to HTTP by itself (`--transport`). */
export type Transport = "auto" | "websocket" | "http";

/** The carrier a connection uses. */
export type Carrier = "websocket" | "http";

/** Why an `auto` runner moved to the HTTP carrier (ADR 0034). */
export type FallbackReason =
  /** The upgrade got another answer than 101 from something that isn't ostra, after TLS succeeded. */
  | "upgrade-refused"
  /** The upgrade succeeded, and no `welcome` came within the handshake timeout: something holds the frames. */
  | "no-welcome"
  /** The socket died within 10 s of opening, three times in a row. */
  | "quick-deaths";

/** The fallback's reasons as words for `ostra runner status` and the log. */
export const fallbackReasonWords: Readonly<Record<FallbackReason, string>> = {
  "upgrade-refused": "the WebSocket upgrade was answered by something other than the ostra server (a proxy)",
  "no-welcome": "the WebSocket upgrade succeeded but no welcome came within 10 s (a proxy holds its frames)",
  "quick-deaths": "the WebSocket died within 10 s of opening three times in a row",
};

/** Where the network settings come from: the environment's proxies, and for tests a CA to trust. */
export type NetworkOptions = {
  /** The variables the proxy is read from: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`. Default: the process's. */
  readonly proxyEnv?: Readonly<Record<string, string | undefined>>;
  /** Trust only these CAs (tests). Unset: the system's, with `NODE_EXTRA_CA_CERTS`. */
  readonly ca?: string | readonly string[];
};

export type Agents = {
  /** The WebSocket's: one connection per upgrade. */
  readonly websocket: http.Agent;
  /** The HTTP carrier's: kept alive, a few at once (an up and a down in flight). */
  readonly http: http.Agent;
  readonly destroy: () => void;
};

const proxyEnvOf = (network: NetworkOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(network.proxyEnv ?? process.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
};

/** The agents for `serverUrl`'s scheme, each through the environment's proxy. */
export const makeAgents = (serverUrl: string, network: NetworkOptions = {}): Agents => {
  const proxyEnv = proxyEnvOf(network);
  const secure = serverUrl.startsWith("https:") || serverUrl.startsWith("wss:");
  const ca = network.ca === undefined ? {} : { ca: typeof network.ca === "string" ? network.ca : [...network.ca] };
  const websocket = secure ? new https.Agent({ proxyEnv, keepAlive: false, ...ca }) : new http.Agent({ proxyEnv, keepAlive: false });
  const carrier = secure ? new https.Agent({ proxyEnv, keepAlive: true, maxSockets: 4, ...ca }) : new http.Agent({ proxyEnv, keepAlive: true, maxSockets: 4 });
  return {
    websocket,
    http: carrier,
    destroy: () => {
      websocket.destroy();
      carrier.destroy();
    },
  };
};

export type HttpAnswer = { readonly status: number; readonly text: string };

/** The largest answer the carrier reads: a down batch of commands, with room. */
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

/** One request of the HTTP carrier. Rejects on a network failure, a timeout or an abort. */
export const httpCall = (input: {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly agent: http.Agent;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<HttpAnswer> =>
  new Promise<HttpAnswer>((resolve, reject) => {
    const headers: Record<string, string> = { ...input.headers };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(input.body));
    }
    const request = (input.url.startsWith("https:") ? https.request : http.request)(input.url, {
      method: input.method,
      agent: input.agent,
      headers,
      signal: input.signal,
      timeout: input.timeoutMs,
    });
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > ANSWER_MAX_BYTES) {
          request.destroy(new Error("answer too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", reject);
    });
    request.end(input.body);
  });

/** What an answer is: ostra's frames, ostra's error, or something else that answered. */
export type ReadAnswer =
  | { readonly kind: "frames"; readonly frames: readonly DownFrame[] }
  | { readonly kind: "empty" }
  | { readonly kind: "superseded" }
  | { readonly kind: "error"; readonly error: RunnerHttpError["error"] }
  /** Not an ostra envelope: a proxy's page, or nothing ostra would send. A network failure. */
  | { readonly kind: "not-ostra" };

/** Reads an answer of the HTTP carrier, its frames at `minor` (or the one before: the server may answer lower). */
export const readAnswer = (answer: HttpAnswer, minor: number): ReadAnswer => {
  if (answer.status === 204 && answer.text === "") {
    return { kind: "empty" };
  }
  const json = parseJson(answer.text);
  if (!json.ok) {
    return { kind: "not-ostra" };
  }
  if (answer.status === 409 && typeof json.value === "object" && json.value !== null && "code" in json.value && json.value.code === "superseded") {
    return { kind: "superseded" };
  }
  const error = runnerHttpErrorSchema.safeParse(json.value);
  if (error.success) {
    return { kind: "error", error: error.data.error };
  }
  for (const each of [minor, minor - 1]) {
    if (each < 0) {
      continue;
    }
    const parsed = parseHttpDownBody(json.value, each);
    if (parsed.ok) {
      return { kind: "frames", frames: parsed.frames };
    }
  }
  return { kind: "not-ostra" };
};

/** Whether a body is ostra's error envelope (the upgrade's refusal), and which. */
export const ostraErrorOf = (text: string): RunnerHttpError["error"] | null => {
  const json = parseJson(text);
  if (!json.ok) {
    return null;
  }
  const parsed = runnerHttpErrorSchema.safeParse(json.value);
  return parsed.success ? parsed.data.error : null;
};

/** An error's code, for a log line: never its message, which may hold a URL. */
export const errorCodeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown";
};
