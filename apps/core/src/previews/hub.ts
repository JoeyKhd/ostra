import type { ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import { decodePreviewMessage, encodePanelStreamRecord, encodePreviewMessage } from "@ostra/protocol";
import type { PanelPreviewInputBody, PreviewClose, PreviewCloseReason, PreviewControl, PreviewFrameHeader, PreviewMessage, PreviewViewId } from "@ostra/protocol";
import type { RawData, WebSocket } from "ws";

// One replica's views whose box connection it holds (ADR 0068, "The preview connection"): the box's
// socket (on the HTTP carrier, the frames it posts), the panel's streams on this replica (a stream
// another replica forwards here is one of them), and the newest frame, which a stream that joins
// gets first. Each frame is acked to the box once every open stream has taken it (spike 07), so a
// slow member slows the box's browser down instead of queueing frames here; with no stream open the
// ack waits for one, and the box's screencast waits with it. Frames, input and paths are never logged.

/** A view this replica holds. */
type Held = {
  readonly viewId: PreviewViewId;
  socket: WebSocket | null;
  /** Its frames come over the HTTP carrier, to this replica. */
  http: boolean;
  readonly streams: Set<ServerResponse>;
  /** The newest frame's record, for a stream that joins. */
  newest: Uint8Array | null;
  /** A frame no stream has taken yet, acked once one does. */
  unacked: number | null;
  /** The numbers of core's controls to the box. */
  controlSeq: number;
  /** One frame relayed at a time, in order. */
  chain: Promise<void>;
};

export type PreviewHub = {
  /** Whether this replica holds the view's box connection: a socket, or the HTTP carrier's frames. */
  readonly holds: (viewId: PreviewViewId) => boolean;
  readonly hasSocket: (viewId: PreviewViewId) => boolean;
  /** The box's socket for the view; an older one of the same view is closed. `onGone` runs when it closes. */
  readonly attachSocket: (viewId: PreviewViewId, ws: WebSocket, onGone: () => void) => void;
  /** The view's frames come over the HTTP carrier to this replica. */
  readonly holdHttp: (viewId: PreviewViewId) => void;
  /** A frame posted over the HTTP carrier, relayed to every stream; resolves once they took it. */
  readonly relayHttpFrame: (viewId: PreviewViewId, header: PreviewFrameHeader, jpeg: Uint8Array) => Promise<void>;
  /** A panel's stream (or a forwarded one) joins the view. `false` when this replica doesn't hold it. */
  readonly attachStream: (viewId: PreviewViewId, response: ServerResponse) => boolean;
  /**
   * A viewer's input, or one of the pane's controls (the width preset, a path, a reload), as a
   * numbered `control` on the box's socket. `false` without a socket here.
   */
  readonly sendControl: (viewId: PreviewViewId, input: PanelPreviewInputBody) => boolean;
  /** Ends the view here: `close` to the box and to every stream. */
  readonly close: (viewId: PreviewViewId, reason: PreviewCloseReason) => void;
  readonly held: () => readonly PreviewViewId[];
  /** How many streams the view has here (tests and the log). */
  readonly streams: (viewId: PreviewViewId) => number;
  readonly stop: () => void;
};

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
};

/** Resolves once `stream` took `record`: at once, or at its `drain`, or when it closes. */
const writeRecord = (stream: ServerResponse, record: Uint8Array): Promise<void> => {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.resolve();
  }
  if (stream.write(record)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // Whichever comes first removes the other, or each held frame leaves a listener behind (spike 07).
    const done = (): void => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
  });
};

export const createPreviewHub = (logger: Logger): PreviewHub => {
  const views = new Map<PreviewViewId, Held>();

  const heldOf = (viewId: PreviewViewId): Held => {
    let held = views.get(viewId);
    if (held === undefined) {
      held = { viewId, socket: null, http: false, streams: new Set(), newest: null, unacked: null, controlSeq: 0, chain: Promise.resolve() };
      views.set(viewId, held);
    }
    return held;
  };

  const sendToBox = (held: Held, message: PreviewMessage): void => {
    if (held.socket !== null && held.socket.readyState === held.socket.OPEN) {
      held.socket.send(encodePreviewMessage(message));
    }
  };

  const endStreams = (held: Held, close: PreviewClose): void => {
    const record = encodePanelStreamRecord({ type: "close", close });
    for (const stream of held.streams) {
      if (!stream.writableEnded) {
        stream.end(record);
      }
    }
    held.streams.clear();
  };

  /** Writes a frame to every stream, then acks it to the box; with no stream, keeps it for the next. */
  const relay = (held: Held, header: PreviewFrameHeader, jpeg: Uint8Array, ack: boolean): Promise<void> => {
    const record = encodePanelStreamRecord({ type: "frame", header, jpeg });
    held.newest = record;
    const run = async (): Promise<void> => {
      if (held.streams.size === 0) {
        if (ack) {
          held.unacked = header.seq;
        }
        return;
      }
      await Promise.all([...held.streams].map((stream) => writeRecord(stream, record)));
      if (ack) {
        sendToBox(held, { type: "ack", ack: { seq: header.seq } });
      }
    };
    held.chain = held.chain.then(run, run);
    return held.chain;
  };

  const forget = (held: Held): void => {
    if (held.socket === null && !held.http && held.streams.size === 0 && views.get(held.viewId) === held) {
      views.delete(held.viewId);
    }
  };

  return {
    holds: (viewId) => {
      const held = views.get(viewId);
      return held !== undefined && (held.socket !== null || held.http);
    },
    hasSocket: (viewId) => (views.get(viewId)?.socket ?? null) !== null,
    attachSocket: (viewId, ws, onGone) => {
      const held = heldOf(viewId);
      const old = held.socket;
      if (old !== null && old !== ws) {
        old.close(4409, "replaced by a newer connection");
      }
      held.socket = ws;
      held.unacked = null;
      ws.on("message", (data, isBinary) => {
        if (held.socket !== ws) {
          return;
        }
        const parsed = isBinary ? decodePreviewMessage(bytesOf(data)) : ({ ok: false, reason: "invalid" } as const);
        if (!parsed.ok) {
          logger.warn("preview.box-message-refused", { viewId, reason: parsed.reason });
          sendToBox(held, { type: "close", close: { reason: "protocol-violation" } });
          ws.close(1008, "protocol violation");
          return;
        }
        const message = parsed.message;
        switch (message.type) {
          case "frame":
            void relay(held, message.header, message.jpeg, true);
            return;
          case "ack":
            // The box applied a control: nothing waits on it.
            return;
          case "close":
            logger.info("preview.box-closed", { viewId, reason: message.close.reason });
            endStreams(held, message.close);
            ws.close(1000, message.close.reason);
            return;
          case "control":
            logger.warn("preview.box-message-refused", { viewId, reason: "control-from-box" });
            ws.close(1008, "protocol violation");
            return;
          default:
            message satisfies never;
        }
      });
      ws.on("error", () => undefined);
      ws.on("close", () => {
        if (held.socket !== ws) {
          return;
        }
        held.socket = null;
        held.newest = null;
        held.unacked = null;
        // The panel's streams end: a box that reconnects, here or on another replica, gets new ones.
        endStreams(held, { reason: "box-stopping" });
        forget(held);
        onGone();
      });
    },
    holdHttp: (viewId) => {
      heldOf(viewId).http = true;
    },
    relayHttpFrame: (viewId, header, jpeg) => relay(heldOf(viewId), header, jpeg, false),
    attachStream: (viewId, response) => {
      const held = views.get(viewId);
      if (held === undefined || (held.socket === null && !held.http)) {
        return false;
      }
      response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
      response.flushHeaders();
      held.streams.add(response);
      response.on("close", () => {
        held.streams.delete(response);
        forget(held);
      });
      if (held.newest !== null) {
        const newest = held.newest;
        const unacked = held.unacked;
        held.unacked = null;
        held.chain = held.chain.then(async () => {
          await writeRecord(response, newest);
          if (unacked !== null) {
            sendToBox(held, { type: "ack", ack: { seq: unacked } });
          }
        });
      }
      return true;
    },
    sendControl: (viewId, input) => {
      const held = views.get(viewId);
      if (held === undefined || held.socket === null) {
        return false;
      }
      held.controlSeq += 1;
      const seq = held.controlSeq;
      const control: PreviewControl = "events" in input ? { kind: "input", seq, events: [...input.events] } : { ...input.control, seq };
      sendToBox(held, { type: "control", control });
      return true;
    },
    close: (viewId, reason) => {
      const held = views.get(viewId);
      if (held === undefined) {
        return;
      }
      sendToBox(held, { type: "close", close: { reason } });
      held.socket?.close(1000, reason);
      held.socket = null;
      endStreams(held, { reason });
      views.delete(viewId);
    },
    held: () => [...views.keys()],
    streams: (viewId) => views.get(viewId)?.streams.size ?? 0,
    stop: () => {
      for (const held of views.values()) {
        sendToBox(held, { type: "close", close: { reason: "box-stopping" } });
        held.socket?.close(1001, "the server is stopping");
        endStreams(held, { reason: "box-stopping" });
      }
      views.clear();
    },
  };
};
