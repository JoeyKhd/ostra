import type http from "node:http";
import { previewPaths, previewSubprotocols, previewTunnel, runnerLimits } from "@ostra/protocol";
import type { LeaseEpoch, PreviewMode, PreviewViewId } from "@ostra/protocol";
import { WebSocket } from "ws";
import { userAgent } from "../version.ts";
import { errorCodeOf, ostraErrorOf } from "./http-carrier.ts";

// The preview connection (milestone 8, ticket 22, ADR 0068 "The preview connection"): a second
// connection the box opens to core only while someone views one of its previews, so a preview's
// bytes never ride the session. `GET /runner/v1/preview?view=<viewId>&leaseEpoch=<n>`, upgraded to
// a binary WebSocket with the mode's subprotocol, authenticated with the box's task token (on
// `host`, the runner's own access token). A stale epoch is refused with 409, as an event is. The
// token, the view's bytes and core's answer bodies are never logged.

export type PreviewConnectionFailure =
  /** Core says the lease moved on: a newer box holds the task. */
  | { readonly kind: "stale-lease"; readonly currentEpoch: number | null }
  /** Core refused the upgrade (401, 404, 400): its status and error code, never its words. */
  | { readonly kind: "refused"; readonly status: number; readonly code: string | null }
  /** Core couldn't be reached, or something that isn't core answered: a network failure. */
  | { readonly kind: "unreachable"; readonly detail: string };

export type PreviewConnectionResult = { readonly ok: true; readonly socket: WebSocket } | { readonly ok: false; readonly failure: PreviewConnectionFailure };

export type PreviewConnectionInput = {
  readonly serverUrl: string;
  /** The box's task token, or the `host` runner's access token. Never logged. */
  readonly token: string;
  readonly viewId: PreviewViewId;
  readonly leaseEpoch: LeaseEpoch;
  readonly mode: PreviewMode;
  /** The agent the upgrade goes through: the environment's proxy, as the session's WebSocket's. */
  readonly agent?: http.Agent;
  readonly handshakeTimeoutMs?: number;
};

/** The preview connection's URL for a view: core's WebSocket address, the view and the epoch in its query. */
export const previewConnectionUrl = (serverUrl: string, viewId: PreviewViewId, leaseEpoch: LeaseEpoch): string =>
  `${serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${previewPaths.connection}?view=${encodeURIComponent(viewId)}&leaseEpoch=${String(leaseEpoch)}`;

/** The largest message each mode takes from core: a tunnel's HTTP/2 bytes, or a stream's control. */
const maxPayloadOf = (mode: PreviewMode): number => (mode === "tunnel" ? previewTunnel.messageMaxBytes : runnerLimits.previewJsonMaxBytes + 1);

/** A refused upgrade's body, read up to a small cap: core's error code and epoch, never its words. */
const readRefusal = (response: http.IncomingMessage): Promise<{ readonly code: string | null; readonly currentEpoch: number | null }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => {
      const error = ostraErrorOf(Buffer.concat(chunks).toString("utf8"));
      resolve({ code: error?.code ?? null, currentEpoch: error?.currentEpoch ?? null });
    };
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024) {
        chunks.push(chunk);
      }
    });
    response.once("end", done);
    response.once("error", done);
  });

/**
 * Opens a view's preview connection in its mode. Resolves once core took the upgrade with the
 * mode's subprotocol, or with why it didn't: a stale lease, core's refusal, or a network failure.
 * The socket comes paused, so nothing core sent is read before the caller listens: the caller
 * resumes it. Never throws.
 */
export const openPreviewConnection = (input: PreviewConnectionInput): Promise<PreviewConnectionResult> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: PreviewConnectionResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const protocol = previewSubprotocols[input.mode];
    let socket: WebSocket;
    try {
      socket = new WebSocket(previewConnectionUrl(input.serverUrl, input.viewId, input.leaseEpoch), [protocol], {
        headers: { authorization: `Bearer ${input.token}`, "user-agent": userAgent() },
        perMessageDeflate: false,
        handshakeTimeout: input.handshakeTimeoutMs ?? runnerLimits.handshakeTimeoutMs,
        maxPayload: maxPayloadOf(input.mode),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      });
    } catch (error) {
      settle({ ok: false, failure: { kind: "unreachable", detail: errorCodeOf(error) } });
      return;
    }
    socket.binaryType = "nodebuffer";
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      void readRefusal(response).then((refusal) => {
        if (refusal.code === null) {
          // Not ostra's answer: a proxy's page is a network failure (ADR 0034).
          settle({ ok: false, failure: { kind: "unreachable", detail: `the upgrade was answered ${String(status)} by something that isn't the ostra server` } });
        } else if (status === 409 && refusal.code === "stale-lease") {
          settle({ ok: false, failure: { kind: "stale-lease", currentEpoch: refusal.currentEpoch } });
        } else {
          settle({ ok: false, failure: { kind: "refused", status, code: refusal.code } });
        }
        socket.terminate();
      });
    });
    socket.once("error", (error) => {
      settle({ ok: false, failure: { kind: "unreachable", detail: errorCodeOf(error) } });
    });
    socket.once("open", () => {
      if (socket.protocol !== protocol) {
        socket.close(1002, "wrong subprotocol");
        settle({ ok: false, failure: { kind: "refused", status: 101, code: "wrong-subprotocol" } });
        return;
      }
      // Paused before any message is read: core speaks first (its HTTP/2 preface comes right after
      // the upgrade), and the caller's reader is attached a few promise turns from now. The reader
      // resumes it (`webSocketDuplex`), so no byte is lost.
      socket.pause();
      settle({ ok: true, socket });
    });
  });
