import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import type { VettedAddress } from "./endpoint-guard.ts";

// One GET to a vetted address. Node's `fetch` can't be told which address to connect to, so this
// uses `node:http` and `node:https`: the socket goes to the address the guard vetted, while the
// Host header and the TLS server name (so the certificate check) stay the URL's own host name.
// No redirect is followed, and the body is cut off at `maxBytes`.

export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

export type PinnedAnswer = {
  readonly kind: "answer";
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
};

export type PinnedOptions = {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
};

const toHeaders = (raw: http.IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(name, item);
      }
    }
  }
  return headers;
};

export const requestPinned = (url: URL, vetted: VettedAddress, options: PinnedOptions): Promise<PinnedAnswer> =>
  new Promise<PinnedAnswer>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const timeout = new Error("the endpoint did not answer in time");
    timeout.name = "TimeoutError";
    const request = (secure ? https : http).request(
      {
        host: vetted.address,
        family: vetted.family,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...options.headers, host: url.host },
        // The certificate is checked against the URL's own name, not the pinned address.
        ...(secure ? { servername: isIP(hostname) === 0 ? hostname : "" } : {}),
        timeout: options.timeoutMs,
        agent: false,
      },
      (response) => {
        const length = Number(response.headers["content-length"]);
        if (Number.isFinite(length) && length > options.maxBytes) {
          response.destroy();
          reject(new BodyTooLargeError("the answer is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            reject(new BodyTooLargeError("the answer is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text === "" ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ kind: "answer", status: response.statusCode ?? 0, headers: toHeaders(response.headers), json });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(timeout);
    });
    request.on("error", reject);
    request.end();
  });
