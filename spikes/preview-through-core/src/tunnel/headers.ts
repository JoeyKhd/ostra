import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";

// Header plumbing shared by core and the sidecar. HTTP/2 refuses connection-specific headers (RFC 9113
// §8.2.2), so they are dropped at each hop; `host` becomes `:authority`.

const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "http2-settings"]);

export const forwardableHeaders = (headers: IncomingHttpHeaders, drop: (name: string) => boolean = () => false): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":") || hopByHop.has(name) || drop(name)) continue;
    out[name] = value;
  }
  return out;
};

// The two headers the sidecar reads and removes: which port of the box, and nothing else of core's.
export const targetPortHeader = "ostra-target-port";

export const websocketAccept = (key: string): string => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

// A pipe that fails says where, on stderr (the run's logs), and never with a body.
export const pipeFailed = (where: string) => (error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ERR_HTTP2_STREAM_CANCEL") return;
  process.stderr.write(`${where}: ${error instanceof Error ? error.message : "failed"} ${code}\n`);
};

// Join two byte streams both ways (a tunnel's two ends). `pipeline` won't do here: when one side closes it
// destroys the other, and destroying an HTTP/2 stream sends RST_STREAM and drops the data still queued on it,
// so a response that ends with its connection loses its last bytes. Each direction ends the other gracefully
// instead, and only an error tears both down.
export const splice = (a: Duplex, b: Duplex) => {
  a.pipe(b);
  b.pipe(a);
  a.on("close", () => {
    if (!b.writableEnded) b.end();
  });
  b.on("close", () => {
    if (!a.writableEnded) a.end();
  });
  a.on("error", () => {
    b.destroy();
  });
  b.on("error", () => {
    a.destroy();
  });
};

// Debug tracing for the spike's own runs, off unless SPIKE_TRACE is set. Byte counts only.
export const trace = (message: string) => {
  if (process.env["SPIKE_TRACE"] !== undefined) process.stderr.write(`${message}\n`);
};

export const firstValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
