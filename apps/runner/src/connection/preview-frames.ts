import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { parseJson, PREVIEW_FRAMES_BODY_PART, previewFramesPartName, previewFramesResponseSchema, previewPaths, runnerLimits } from "@ostra/protocol";
import type { LeaseEpoch, PreviewFrameHeader, PreviewFramesBody, PreviewViewId } from "@ostra/protocol";
import { userAgent } from "../version.ts";
import { errorCodeOf } from "./http-carrier.ts";

// The browser view's frames over the HTTP carrier (milestone 8, ticket 18, Q306, ADR 0068 "The HTTP
// fallback carrier"): a runner whose WebSocket a proxy blocks has no preview connection, so a view's
// frames go up as `POST /runner/v1/preview/frames`, at most 2 a second, each a `multipart/form-data`
// body: the `body` part's JSON, then each frame's JPEG in a part of its own. Core answers the highest
// frame it took, or why it took none. Its input comes down the long poll as `preview.input`. The
// token and the frames are never logged.

/** One frame of a view, as the box's browser captured it: its header and its JPEG. */
export type PreviewFrame = { readonly header: PreviewFrameHeader; readonly jpeg: Uint8Array };

/** Core's answer to a view's frames. */
export type PreviewFramesPost =
  /** Core took them, up to this frame. */
  | { readonly kind: "taken"; readonly ackedUpTo: number }
  /** Past 2 frames a second for the view: the frames weren't taken, and may be sent again later. */
  | { readonly kind: "too-fast" }
  /** The view is closed: none of its frames are wanted any more. */
  | { readonly kind: "view-closed" }
  /** The lease moved on: a newer box holds the task. */
  | { readonly kind: "stale-lease" }
  /** Core refused them for good (the token, the body): sending them again won't help. */
  | { readonly kind: "refused"; readonly status: number }
  /** Core couldn't be reached, didn't answer in time, failed, or something else answered. */
  | { readonly kind: "unreachable"; readonly detail: string };

export type PostPreviewFramesInput = {
  readonly serverUrl: string;
  /** The box's task token, or the `host` runner's access token. Never logged. */
  readonly token: string;
  readonly viewId: PreviewViewId;
  readonly leaseEpoch: LeaseEpoch;
  /** At most `httpCarrierFramesPerSecond` frames. */
  readonly frames: readonly PreviewFrame[];
  /** The HTTP carrier's agent, through the environment's proxy. */
  readonly agent?: http.Agent;
  readonly timeoutMs?: number;
};

const CRLF = "\r\n";

/**
 * A view's frames as the body core reads (`previewFramesBodySchema`): its JSON first, then one part
 * per frame, under a boundary of random bytes no JPEG holds by chance.
 */
export const encodePreviewFramesBody = (
  viewId: PreviewViewId,
  leaseEpoch: LeaseEpoch,
  frames: readonly PreviewFrame[],
  boundary: string = randomBytes(24).toString("hex"),
): { readonly contentType: string; readonly bytes: Buffer } => {
  const body: PreviewFramesBody = {
    viewId,
    leaseEpoch,
    frames: frames.map((frame, index) => ({ ...frame.header, part: previewFramesPartName(index) })),
  };
  const part = (name: string, type: string, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`--${boundary}${CRLF}content-disposition: form-data; name="${name}"${CRLF}content-type: ${type}${CRLF}${CRLF}`, "latin1"), content, Buffer.from(CRLF, "latin1")]);
  const bytes = Buffer.concat([
    part(PREVIEW_FRAMES_BODY_PART, "application/json", Buffer.from(JSON.stringify(body), "utf8")),
    ...frames.map((frame, index) => part(previewFramesPartName(index), "image/jpeg", Buffer.from(frame.jpeg.buffer, frame.jpeg.byteOffset, frame.jpeg.byteLength))),
    Buffer.from(`--${boundary}--${CRLF}`, "latin1"),
  ]);
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes };
};

/** The largest answer read: core's answer is a line of JSON. */
const ANSWER_MAX_BYTES = 16 * 1024;

/** Core's answer by its status and body. A body that isn't ostra's is a network failure (ADR 0034). */
const answerOf = (status: number, text: string): PreviewFramesPost => {
  const json = parseJson(text);
  const parsed = json.ok ? previewFramesResponseSchema.safeParse(json.value) : null;
  if (parsed?.success === true) {
    const answer = parsed.data;
    if ("ackedUpTo" in answer) {
      return status === 200 ? { kind: "taken", ackedUpTo: answer.ackedUpTo } : { kind: "unreachable", detail: `answered ${String(status)}` };
    }
    switch (answer.code) {
      case "too-fast":
        return { kind: "too-fast" };
      case "view-closed":
        return { kind: "view-closed" };
      case "stale-lease":
        return { kind: "stale-lease" };
      case "invalid":
        return { kind: "refused", status };
      default:
        return answer.code satisfies never;
    }
  }
  // ostra's error shape (the token refused) is for good; anything else is something that isn't core.
  if (json.ok && typeof json.value === "object" && json.value !== null && "error" in json.value && (status === 401 || status === 403)) {
    return { kind: "refused", status };
  }
  return { kind: "unreachable", detail: status >= 500 ? `answered ${String(status)}` : "answered by something that isn't the ostra server" };
};

/** Posts a view's frames to core. Never throws. */
export const postPreviewFrames = (input: PostPreviewFramesInput): Promise<PreviewFramesPost> =>
  new Promise((resolve) => {
    const { contentType, bytes } = encodePreviewFramesBody(input.viewId, input.leaseEpoch, input.frames);
    const url = `${input.serverUrl.replace(/\/+$/, "")}${previewPaths.frames}`;
    let settled = false;
    const settle = (post: PreviewFramesPost): void => {
      if (!settled) {
        settled = true;
        resolve(post);
      }
    };
    let request: http.ClientRequest;
    try {
      request = (url.startsWith("https:") ? https.request : http.request)(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "user-agent": userAgent(),
          "content-type": contentType,
          "content-length": String(bytes.length),
          accept: "application/json",
        },
        timeout: input.timeoutMs ?? runnerLimits.handshakeTimeoutMs,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      });
    } catch (error) {
      settle({ kind: "unreachable", detail: errorCodeOf(error) });
      return;
    }
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      settle({ kind: "unreachable", detail: errorCodeOf(error) });
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= ANSWER_MAX_BYTES) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        settle(answerOf(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
      });
      response.on("error", (error) => {
        settle({ kind: "unreachable", detail: errorCodeOf(error) });
      });
    });
    request.end(bytes);
  });
