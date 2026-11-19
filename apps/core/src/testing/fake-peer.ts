import { generateKeyPair, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { promisify } from "node:util";

import {
  encodeUpFrame,
  parseDownFrame,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  runnerPaths,
  tokenAssertionCanonicalString,
} from "@ostra/protocol";
import type { DownFrame, DownFrameType, Hello, RunnerId, TokenAssertion, UpFrame } from "@ostra/protocol";
import WebSocket from "ws";

// A fake runner for the gateway's tests (spec section 8: the gateway's tests run against a fake
// peer built from the protocol's schemas). It holds an Ed25519 key, signs assertions, and speaks the
// WebSocket session at a given minor. Every frame it receives is parsed with the protocol's schema.

const generate = promisify(generateKeyPair);

export type RunnerKey = {
  /** Raw, base64url: what `register` takes. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
};

export const makeRunnerKey = async (): Promise<RunnerKey> => {
  const pair = await generate("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("no raw public key");
  }
  return { publicKey: jwk.x, privateKey: pair.privateKey };
};

export const signAssertion = (
  key: RunnerKey,
  runnerId: RunnerId,
  issuedAt: number = Date.now(),
  nonce: string = randomBytes(16).toString("base64url"),
): TokenAssertion => {
  const unsigned = { runnerId, issuedAt, nonce };
  const signature = sign(null, Buffer.from(tokenAssertionCanonicalString(unsigned), "utf8"), key.privateKey).toString("base64url");
  return { ...unsigned, signature };
};

const isType = <T extends DownFrameType>(frame: DownFrame, type: T): frame is Extract<DownFrame, { type: T }> =>
  frame.type === type;

export type FakePeer = {
  readonly frames: DownFrame[];
  /** Resolves with the next frame of `type` (or one already received and not yet taken). */
  readonly next: <T extends DownFrameType>(type: T, timeoutMs?: number) => Promise<Extract<DownFrame, { type: T }>>;
  readonly send: (frame: UpFrame) => void;
  readonly sendText: (text: string) => void;
  /** Resolves with the close code once the server closes the connection. */
  readonly closed: Promise<number>;
  readonly close: () => void;
};

export type ConnectOptions = {
  readonly minor?: number;
  readonly lastCommandSeq?: number;
  readonly sessions?: Hello["sessions"];
  /** Don't send hello (to test the handshake). */
  readonly skipHello?: boolean;
  /** Who hello says this is: the runner by default, or a box's sidecar (ticket 41). */
  readonly peer?: Hello["peer"];
};

export const helloFrame = (runnerId: RunnerId, options: ConnectOptions = {}): Hello => ({
  type: "hello",
  protocolMajor: PROTOCOL_MAJOR,
  protocolMinor: options.minor ?? PROTOCOL_MINOR,
  runnerVersion: "0.0.0",
  peer: options.peer ?? { kind: "runner", runnerId },
  carrier: "websocket",
  lastCommandSeq: options.lastCommandSeq ?? 0,
  sessions: options.sessions ?? [],
});

/** Opens the WebSocket; rejects with the HTTP status when the upgrade is refused. */
export const connectPeer = (
  baseUrl: string,
  accessToken: string,
  runnerId: RunnerId,
  options: ConnectOptions = {},
): Promise<FakePeer> =>
  new Promise((resolve, reject) => {
    const url = `${baseUrl.replace(/^http/, "ws")}${runnerPaths.connect}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${accessToken}` } });
    const frames: DownFrame[] = [];
    const taken = new Set<DownFrame>();
    const waiters: (() => void)[] = [];
    const minor = options.minor ?? PROTOCOL_MINOR;
    const closed = new Promise<number>((resolveClosed) => {
      ws.on("close", (code) => {
        resolveClosed(code);
        for (const wake of waiters.splice(0)) {
          wake();
        }
      });
    });
    ws.on("message", (data) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8");
      const parsed = parseDownFrame(text, minor);
      if (!parsed.ok) {
        throw new Error(`the server sent a frame that doesn't parse: ${parsed.error.detail}`);
      }
      frames.push(parsed.frame);
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      reject(new Error(`upgrade refused: ${String(response.statusCode)}`));
    });
    ws.on("error", (error) => {
      reject(error);
    });
    const next = <T extends DownFrameType>(type: T, timeoutMs = 10_000): Promise<Extract<DownFrame, { type: T }>> =>
      new Promise((resolveNext, rejectNext) => {
        const until = Date.now() + timeoutMs;
        const look = (): void => {
          for (const frame of frames) {
            if (!taken.has(frame) && isType(frame, type)) {
              taken.add(frame);
              resolveNext(frame);
              return;
            }
          }
          if (Date.now() > until || ws.readyState === WebSocket.CLOSED) {
            rejectNext(new Error(`no ${type} frame within ${String(timeoutMs)} ms; got ${frames.map((frame) => frame.type).join(", ")}`));
            return;
          }
          const timer = setTimeout(look, 50);
          waiters.push(() => {
            clearTimeout(timer);
            setTimeout(look, 0);
          });
        };
        look();
      });
    ws.on("open", () => {
      const peer: FakePeer = {
        frames,
        next,
        send: (frame) => {
          ws.send(encodeUpFrame(frame, minor));
        },
        sendText: (text) => {
          ws.send(text);
        },
        closed,
        close: () => {
          ws.close();
        },
      };
      if (options.skipHello !== true) {
        peer.send(helloFrame(runnerId, options));
      }
      resolve(peer);
    });
  });
