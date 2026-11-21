import { Duplex } from "node:stream";

// A WebSocket as an HTTP/2 session's socket (milestone 8, ADR 0068 "The preview connection"),
// written once for core's tunnels and the runner's: the box's side, `ostra preview`'s, and core's
// for both (moved here from the runner's `preview-tunnel.ts`, ticket 22).
//
// Never `ws`'s `createWebSocketStream` under HTTP/2. Its `_final` closes the WebSocket and waits
// for the TCP socket's `finish`, which never comes once that socket is destroyed (`terminate()`,
// or `ws`'s own cut 30 s after a close frame nobody answers). The session's shutdown then never
// completes, and its next write trips an assertion in Node's `JSStreamSocket`
// (`ERR_INTERNAL_ASSERTION`): an uncaught exception that takes the whole process down. Its
// `_destroy` also terminates the socket, which loses the close code the tunnel's owner sends.
//
// Here the duplex never closes or terminates the socket: whoever owns the tunnel does, with its
// code. A shutdown completes at once, a write after the socket left `OPEN` is dropped (the
// session ends anyway), and neither the duplex nor the socket ever emits an `error` nobody hears.

/** A WebSocket message's bytes, as `ws` hands them over. */
export type WebSocketData = Buffer | ArrayBuffer | Buffer[];

/** The WebSocket a tunnel runs on: what `webSocketDuplex` uses of `ws`'s `WebSocket`. */
export type TunnelWebSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  readonly isPaused: boolean;
  readonly send: (data: Buffer, options: { readonly binary: true }, callback: (error?: Error) => void) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly on: {
    (event: "message", listener: (data: WebSocketData) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  readonly once: (event: "close", listener: () => void) => unknown;
};

const bytesOf = (data: WebSocketData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

/**
 * The WebSocket as the HTTP/2 session's socket: each binary message the next bytes, each write
 * one message, its callback the WebSocket's own once the bytes are on their way (the connection's
 * back-pressure), and the reader paused while the session's buffer is full. Destroying it never
 * terminates the socket, so the tunnel's close sends its code. Once it's destroyed, the socket's
 * messages are dropped and it's read again, so a close frame still gets its answer.
 */
export const webSocketDuplex = (socket: TunnelWebSocket): Duplex => {
  const duplex = new Duplex({
    read: () => {
      if (socket.isPaused) {
        socket.resume();
      }
    },
    write: (chunk: Buffer, _encoding, callback) => {
      if (socket.readyState !== socket.OPEN) {
        callback();
        return;
      }
      socket.send(chunk, { binary: true }, (error) => {
        callback(error ?? null);
      });
    },
    final: (callback) => {
      callback();
    },
    destroy: (error, callback) => {
      if (socket.isPaused) {
        socket.resume();
      }
      callback(error);
    },
  });
  duplex.on("error", () => undefined);
  socket.on("error", () => undefined);
  socket.on("message", (data) => {
    if (duplex.destroyed) {
      return;
    }
    if (!duplex.push(bytesOf(data))) {
      socket.pause();
    }
  });
  socket.once("close", () => {
    if (!duplex.destroyed) {
      duplex.push(null);
    }
  });
  // A socket may come paused (the runner's `openPreviewConnection`): it's read from now on.
  if (socket.isPaused) {
    socket.resume();
  }
  return duplex;
};
