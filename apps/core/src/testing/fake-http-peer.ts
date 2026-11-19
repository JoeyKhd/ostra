import { parseHttpDownBody, PROTOCOL_MINOR, runnerHeaders, runnerPaths, upFrameCodec } from "@ostra/protocol";
import type { DownFrame, Hello, RunnerId, UpFrame } from "@ostra/protocol";

import { helloFrame } from "./fake-peer.ts";
import type { ConnectOptions } from "./fake-peer.ts";

// A fake runner on the HTTP carrier (milestone 5's ticket 11), built from the protocol's schemas:
// `POST /hello`, then `POST /up` and `GET /down?after=` with the epoch and minor `welcome` named.
// Every frame it receives is parsed with the protocol's schema at its minor.

export type HttpReply = { readonly status: number; readonly frames: readonly DownFrame[]; readonly body: unknown };

const reply = async (response: Response, minor: number): Promise<HttpReply> => {
  const text = await response.text();
  if (text === "") {
    return { status: response.status, frames: [], body: null };
  }
  const body: unknown = JSON.parse(text);
  const framed = typeof body === "object" && body !== null && "frames" in body ? parseHttpDownBody(body, minor) : null;
  if (framed !== null && !framed.ok) {
    throw new Error(`the server sent frames that don't parse: ${framed.detail}`);
  }
  return { status: response.status, frames: framed?.ok === true ? framed.frames : [], body };
};

/** `hello` as the HTTP carrier sends it. */
export const httpHelloFrame = (runnerId: RunnerId, options: ConnectOptions = {}): Hello => ({ ...helloFrame(runnerId, options), carrier: "http" });

/** `POST /hello`: the answer, parsed at the minor the hello asked for (a refusal is at the server's). */
export const postHello = async (baseUrl: string, accessToken: string, hello: Hello): Promise<HttpReply> => {
  const response = await fetch(`${baseUrl}${runnerPaths.httpHello}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(hello),
  });
  return reply(response, response.ok ? hello.protocolMinor : PROTOCOL_MINOR);
};

export type HttpPeer = {
  readonly connectionEpoch: number;
  readonly minor: number;
  readonly welcome: Extract<DownFrame, { type: "welcome" }>;
  /** The frames after `welcome` in hello's answer: the sessions' acks. */
  readonly helloFrames: readonly DownFrame[];
  /** `POST /up` with this connection's epoch and minor, to `baseUrl` (another replica) when given. */
  readonly up: (frames: readonly UpFrame[], options?: { readonly baseUrl?: string; readonly epoch?: number }) => Promise<HttpReply>;
  /** `GET /down?after=`, to `baseUrl` (another replica) when given. */
  readonly down: (after: number, options?: { readonly baseUrl?: string; readonly epoch?: number; readonly accessToken?: string }) => Promise<HttpReply>;
};

/** Says hello over HTTP and answers a peer of that connection; throws when hello is refused. */
export const httpPeer = async (baseUrl: string, accessToken: string, runnerId: RunnerId, options: ConnectOptions = {}): Promise<HttpPeer> => {
  const hello = httpHelloFrame(runnerId, options);
  const answer = await postHello(baseUrl, accessToken, hello);
  const [welcome, ...rest] = answer.frames;
  if (answer.status !== 200 || welcome?.type !== "welcome") {
    throw new Error(`hello answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`);
  }
  const { connectionEpoch, minor } = welcome;
  const headers = (epoch: number): Record<string, string> => ({
    authorization: `Bearer ${accessToken}`,
    [runnerHeaders.connectionEpoch]: String(epoch),
    [runnerHeaders.minor]: String(minor),
  });
  return {
    connectionEpoch,
    minor,
    welcome,
    helloFrames: rest,
    up: async (frames, upOptions = {}) => {
      const response = await fetch(`${upOptions.baseUrl ?? baseUrl}${runnerPaths.httpUp}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers(upOptions.epoch ?? connectionEpoch) },
        body: JSON.stringify({ frames: frames.map((frame) => upFrameCodec.encodeValue(frame, minor)) }),
      });
      return reply(response, minor);
    },
    down: async (after, downOptions = {}) => {
      const response = await fetch(`${downOptions.baseUrl ?? baseUrl}${runnerPaths.httpDown}?after=${String(after)}`, {
        headers: { ...headers(downOptions.epoch ?? connectionEpoch), ...(downOptions.accessToken === undefined ? {} : { authorization: `Bearer ${downOptions.accessToken}` }) },
      });
      return reply(response, minor);
    },
  };
};
