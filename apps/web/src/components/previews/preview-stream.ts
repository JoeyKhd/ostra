import { createPanelStreamReader } from "@ostra/protocol";
import type { PreviewClose, PreviewFrameHeader, PreviewViewId } from "@ostra/protocol";
import type { PreviewRouteErrorCode } from "@ostra/api";
import { z } from "zod";

// A view's frames in the browser (milestone 8, F-141, F-142, ADR 0068): `GET
// /api/previews/<viewId>/stream`, read with `fetch`'s body reader, a run of records that
// `createPanelStreamReader` splits however the network cut them. The pane and the viewer page both
// read it here. A member's session rides the cookie; the viewer page sends its link's token in
// `x-ostra-preview-link`. A frame is never logged.

/** The header the viewer page names its link's token in (`PREVIEW_LINK_HEADER` in `@ostra/api`). */
export const PREVIEW_LINK_HEADER = "x-ostra-preview-link";

/** The stream and input routes of one view. */
export const previewRoutes = {
  stream: (viewId: PreviewViewId): string => `/api/previews/${encodeURIComponent(viewId)}/stream`,
  input: (viewId: PreviewViewId): string => `/api/previews/${encodeURIComponent(viewId)}/input`,
} as const;

/** The request headers for a view's routes: the link's token on the viewer page, none in the pane. */
export const previewHeaders = (linkToken: string | null): Readonly<Record<string, string>> => (linkToken === null ? {} : { [PREVIEW_LINK_HEADER]: linkToken });

/** One JPEG frame, as the stream carries it. */
export type PreviewFrame = { readonly header: PreviewFrameHeader; readonly jpeg: Uint8Array };

/**
 * How a stream ended:
 * - `closed`: core's `close` record (the view closed, the app stopped, the box refused it);
 * - `refused`: the route answered with a code (`{ error: { code } }`), or a status alone;
 * - `dropped`: the body ended, broke or failed without a `close`, so it may come back;
 * - `aborted`: the reader went away (the pane closed).
 */
export type PreviewStreamEnd =
  | { readonly kind: "closed"; readonly close: PreviewClose }
  | { readonly kind: "refused"; readonly status: number; readonly code: PreviewRouteErrorCode | null }
  | { readonly kind: "dropped" }
  | { readonly kind: "aborted" };

/** Every code the routes answer with (`previewRouteErrorCodeSchema` in `@ostra/api`), each with whether it may come back by itself. */
const routeCodeRetries = {
  unauthorized: false,
  forbidden: false,
  "not-found": false,
  "view-closed": false,
  "watch-only": false,
  "not-allowed": false,
  "link-expired": false,
  "link-revoked": false,
  "public-links-off": false,
  "level-unknown": false,
  "bad-request": false,
  "too-many-tries": false,
  "not-connected": true,
  "core-unreachable": true,
} as const satisfies Readonly<Record<PreviewRouteErrorCode, boolean>>;

/** Whether a string is one of the routes' codes. */
export const isPreviewRouteCode = (code: string): code is PreviewRouteErrorCode => Object.hasOwn(routeCodeRetries, code);

/** Whether a refusal may clear by itself: the box hasn't connected yet, or core didn't answer. */
export const refusalRetries = (code: PreviewRouteErrorCode | null): boolean => (code === null ? true : routeCodeRetries[code]);

/** The routes' refusal body. A format ostra owns, but read tolerantly: a proxy may answer instead. */
const refusalBodySchema = z.looseObject({ error: z.looseObject({ code: z.string() }) });

/** The code of a refused response, or `null` when its body names none the panel knows. */
export const refusalCodeOf = async (response: Response): Promise<PreviewRouteErrorCode | null> => {
  const text = await response.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const body = refusalBodySchema.safeParse(json);
  return body.success && isPreviewRouteCode(body.data.error.code) ? body.data.error.code : null;
};

/**
 * Reads a stream's body to its end: each frame goes to `onFrame` as it completes, and the end says
 * why it stopped. A record that doesn't parse ends it as `dropped`: the next one can't be trusted.
 */
export const readPreviewStream = async (body: ReadableStream<Uint8Array>, onFrame: (frame: PreviewFrame) => void, signal: AbortSignal): Promise<PreviewStreamEnd> => {
  const reader = body.getReader();
  const records = createPanelStreamReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return signal.aborted ? { kind: "aborted" } : { kind: "dropped" };
      }
      for (const record of records.push(chunk.value)) {
        if (!record.ok) {
          await reader.cancel().catch(() => undefined);
          return { kind: "dropped" };
        }
        const message = record.message;
        switch (message.type) {
          case "frame":
            onFrame({ header: message.header, jpeg: message.jpeg });
            break;
          case "close":
            await reader.cancel().catch(() => undefined);
            return { kind: "closed", close: message.close };
          // Acks and controls are the box's and core's, never the pane's.
          case "ack":
          case "control":
            break;
          default:
            message satisfies never;
        }
      }
    }
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "dropped" };
  }
};

/** Opens a view's stream and reads it to its end. */
export const openPreviewStream = async (
  viewId: PreviewViewId,
  linkToken: string | null,
  onFrame: (frame: PreviewFrame) => void,
  signal: AbortSignal,
  send: typeof fetch = fetch,
): Promise<PreviewStreamEnd> => {
  let response: Response;
  try {
    response = await send(previewRoutes.stream(viewId), { headers: previewHeaders(linkToken), signal, cache: "no-store" });
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "dropped" };
  }
  if (!response.ok) {
    return { kind: "refused", status: response.status, code: await refusalCodeOf(response) };
  }
  if (response.body === null) {
    return { kind: "dropped" };
  }
  return readPreviewStream(response.body, onFrame, signal);
};
