import type { Logger } from "@ostra/adapter-sdk";
import { decodePreviewMessage, encodePreviewMessage, runnerLimits } from "@ostra/protocol";
import type { PreviewCloseReason, PreviewControl, PreviewMessage, PreviewViewId } from "@ostra/protocol";
import type { RawData, WebSocket } from "ws";
import type { PreviewFrame, PreviewFramesPost } from "../connection/preview-frames.ts";
import type { FrameSink } from "./shared-pages.ts";

// Milestone 8's ticket 18 (F-141, ADR 0068 "The preview connection", Q306): a browser view's way to
// core, on either carrier.
//
// - **On the WebSocket,** the view's own preview connection in `stream` mode: each frame goes up as
//   a `frame` message and is taken once core's `ack` names it; core's `control` messages (the
//   viewport, a path, a reload, a member's input) are applied to the shared page in order, each
//   acked once applied; core's `close` ends the view. Anything else from core is a protocol
//   violation, and the box closes the connection with 1008.
// - **On the HTTP carrier,** no connection: each frame is posted (`POST /runner/v1/preview/frames`),
//   one at a time and at most 2 a second, each post at least half a second after core answered the
//   last, so core never counts three in a second however the network bunches them. Input, and the
//   pane's width preset, path and reload, come down the long poll as `preview.input`
//   (`task-host.ts`). A closed view or a stale lease ends the view;
//   an unreachable core is tried again until the view ends.
//
// Only frames go up. A frame, a path and typed text are never logged: IDs and reasons are.

/** A view's way to core: its frames' sink, and its end. */
export type StreamLink = {
  readonly sink: FrameSink;
  /** Ends the view's side: on the WebSocket, `close` with the reason, then the socket with the code. */
  readonly close: (code: number, reason: PreviewCloseReason) => void;
  readonly carrier: "websocket" | "http";
};

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

export type SocketStreamInput = {
  readonly viewId: PreviewViewId;
  /** The view's preview connection, paused as `openPreviewConnection` hands it back. */
  readonly socket: WebSocket;
  /** Applies core's control to the view's page; the box acks it once this resolves. */
  readonly onControl: (control: PreviewControl) => Promise<void>;
  /** Core closed the view, or the connection went. */
  readonly onEnd: (reason: PreviewCloseReason | null) => void;
  readonly logger: Logger;
};

/** A view's preview connection in `stream` mode. */
export const socketStreamLink = (input: SocketStreamInput): StreamLink => {
  const log = input.logger.child({ component: "preview-stream", viewId: input.viewId });
  const { socket } = input;
  /** Frames sent and not yet taken, by number: each resolves once core's ack reaches it. */
  const waiting = new Map<number, (took: boolean) => void>();
  let ended = false;

  const send = (message: PreviewMessage): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodePreviewMessage(message));
    }
  };

  const finish = (reason: PreviewCloseReason | null): void => {
    if (ended) {
      return;
    }
    ended = true;
    for (const resolve of waiting.values()) {
      resolve(false);
    }
    waiting.clear();
    input.onEnd(reason);
  };

  const violation = (why: string): void => {
    log.warn("preview.core-message-refused", { reason: why });
    send({ type: "close", close: { reason: "protocol-violation" } });
    socket.close(1008, "protocol violation");
    finish("protocol-violation");
  };

  /** Core's controls, applied one at a time in order, each acked once applied. */
  let controls: Promise<void> = Promise.resolve();

  socket.on("message", (data, isBinary) => {
    if (ended) {
      return;
    }
    if (!isBinary) {
      violation("text");
      return;
    }
    const parsed = decodePreviewMessage(bytesOf(data));
    if (!parsed.ok) {
      violation(parsed.reason);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "ack":
        for (const [seq, resolve] of [...waiting.entries()]) {
          if (seq <= message.ack.seq) {
            waiting.delete(seq);
            resolve(true);
          }
        }
        return;
      case "control": {
        const control = message.control;
        controls = controls
          .then(() => input.onControl(control))
          .catch(() => {
            log.warn("preview.control-failed", { kind: control.kind });
          })
          .then(() => {
            send({ type: "ack", ack: { seq: control.seq } });
          });
        return;
      }
      case "close":
        log.info("preview.core-closed", { reason: message.close.reason });
        socket.close(1000, message.close.reason);
        finish(message.close.reason);
        return;
      case "frame":
        violation("frame-from-core");
        return;
      default:
        message satisfies never;
    }
  });
  socket.on("error", () => undefined);
  socket.once("close", () => {
    finish(null);
  });
  // Read from now: it came paused, so nothing core sent before was lost.
  socket.resume();

  return {
    carrier: "websocket",
    sink: {
      send: (frame) =>
        new Promise((resolve) => {
          if (ended || socket.readyState !== socket.OPEN) {
            resolve(false);
            return;
          }
          waiting.set(frame.header.seq, resolve);
          socket.send(encodePreviewMessage({ type: "frame", header: frame.header, jpeg: frame.jpeg }), (error) => {
            // Node calls a write's callback with `null` when it went: only an error is one.
            if (error instanceof Error) {
              waiting.delete(frame.header.seq);
              resolve(false);
            }
          });
        }),
    },
    close: (code, reason) => {
      if (ended) {
        return;
      }
      send({ type: "close", close: { reason } });
      socket.close(code, reason);
      finish(reason);
    },
  };
};

export type HttpStreamInput = {
  readonly viewId: PreviewViewId;
  /** Posts frames for the view (`postPreviewFrames` with the link's token and the lease epoch). */
  readonly post: (frames: readonly PreviewFrame[]) => Promise<PreviewFramesPost>;
  /** The view is closed, or the lease moved on: core wants no more of its frames. */
  readonly onEnd: (why: "view-closed" | "stale-lease" | "refused") => void;
  readonly logger: Logger;
  /** The least time between core's answer and the next post (default half a second: 2 a second). */
  readonly gapMs?: number;
  /** How long an unreachable core waits before the frame goes again (default 1 s). */
  readonly retryMs?: number;
};

/** A view's frames over the HTTP carrier. */
export const httpStreamLink = (input: HttpStreamInput): StreamLink => {
  const log = input.logger.child({ component: "preview-stream", viewId: input.viewId });
  const gapMs = input.gapMs ?? Math.ceil(1000 / runnerLimits.httpCarrierFramesPerSecond);
  const retryMs = input.retryMs ?? 1_000;
  let ended = false;
  /** Whether the view ended, read through a function: it ends between awaits, which the type checker doesn't see. */
  const over = (): boolean => ended;
  let answeredAt = 0;
  /** One post at a time. */
  let chain: Promise<unknown> = Promise.resolve();

  const end = (why: "view-closed" | "stale-lease" | "refused"): void => {
    if (ended) {
      return;
    }
    ended = true;
    log.info("preview.frames-refused", { reason: why });
    input.onEnd(why);
  };

  const deliver = async (frame: PreviewFrame): Promise<boolean> => {
    for (let failures = 0; !over(); ) {
      await sleep(answeredAt + gapMs - Date.now());
      if (over()) {
        return false;
      }
      const answer = await input.post([frame]);
      answeredAt = Date.now();
      switch (answer.kind) {
        case "taken":
          return true;
        case "too-fast":
          // Core counted more than its second allows: the gap is waited again.
          continue;
        case "view-closed":
        case "stale-lease":
          end(answer.kind);
          return false;
        case "refused":
          end("refused");
          return false;
        case "unreachable":
          failures += 1;
          if (failures === 1 || failures % 10 === 0) {
            log.info("preview.frames-unreachable", { failures, detail: answer.detail });
          }
          await sleep(retryMs);
          continue;
        default:
          return answer satisfies never;
      }
    }
    return false;
  };

  return {
    carrier: "http",
    sink: {
      send: (frame) => {
        const next = chain.then(() => deliver(frame));
        chain = next.catch(() => undefined);
        return next;
      },
    },
    close: () => {
      ended = true;
    },
  };
};
