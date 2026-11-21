import { checkViewInput, PANEL_PREVIEW_TOKEN_TTL_MS, panelPreviewPaths, previewLinkTokenHash, previewLinkTokenMatches, previewViewInTx } from "@ostra/domain";
import type { PreviewViewRow } from "@ostra/domain";
import { panelPreviewInputBodySchema, parseJson, previewViewIdSchema, runnerLimits } from "@ostra/protocol";
import type { PreviewViewId } from "@ostra/protocol";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { PREVIEW_LINK_HEADER, previewLinkMisses } from "./preview-link-tries.ts";
import { clientAddressOf } from "./rate-limit.ts";

// The web app's routes for one view's bytes (milestone 8, ticket 20, F-141, ADR 0068, "The bytes
// stay off the session"): `GET /api/previews/:viewId/stream` relays core's stream of frames as a
// streamed response, as it is, and `POST /api/previews/:viewId/input` relays a batch of input. Next.js
// can't upgrade to a WebSocket (ADR 0035), so neither is one.
//
// Each request is a member's session, or the viewer page's link token in `x-ostra-preview-link`.
// The view must be the one that member or that link opened, and its viewer must still be allowed:
// the access is read again on every request. Then the panel asks core for that one view with a
// token it signs for that view and that viewer, a minute long. A watch-only viewer's input is
// dropped here, before core and the runner. Every refusal is a code (`error.code`) the panel words
// through `t`. Never logged: a link's token, the panel's token, a frame or typed text.

/** Why a relay refused: what the pane and the viewer page word. */
export const previewRouteErrorCodeSchema = z.enum([
  /** No session and no link, or a token that opens nothing: never says whether it existed. */
  "unauthorized",
  /** The account must change its default password first, or a request from another origin. */
  "forbidden",
  "not-found",
  "view-closed",
  /** Input from a viewer who may only watch: a named person, or a link that doesn't allow input. */
  "watch-only",
  /** The viewer may no longer open the preview: why. */
  "not-allowed",
  "link-expired",
  "link-revoked",
  "public-links-off",
  "level-unknown",
  "bad-request",
  "too-many-tries",
  /** The box's preview connection hasn't reached the server (yet). */
  "not-connected",
  /** Core didn't answer, or answered something the panel can't relay. */
  "core-unreachable",
]);
export type PreviewRouteErrorCode = z.infer<typeof previewRouteErrorCodeSchema>;

const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

const refuse = (status: number, code: PreviewRouteErrorCode): Response => Response.json({ error: { code } }, { status, headers: noStore });

/** Core's refusal body: a code the panel relays when it knows it. */
const coreErrorSchema = z.looseObject({ error: z.looseObject({ code: z.string() }) });

type Viewer = { readonly kind: "member"; readonly organizationId: string; readonly memberId: string } | { readonly kind: "link"; readonly linkId: string };

/**
 * Who asks: the link's token when the request carries one (the viewer page), else the member's
 * session. A token that opens no link counts against the address's tries.
 */
const viewerOf = async (ctx: Context, request: Request): Promise<Viewer | Response> => {
  const token = request.headers.get(PREVIEW_LINK_HEADER);
  if (token !== null) {
    const address = clientAddressOf(request.headers);
    const now = ctx.deps.ports.clock.now();
    if (previewLinkMisses.blocked(address, now)) {
      return refuse(429, "too-many-tries");
    }
    const presented = token.trim();
    const hash = previewLinkTokenHash(presented);
    const link = hash === null ? null : await ctx.deps.db.previewLink.findUnique({ where: { tokenHash: hash }, select: { id: true, tokenHash: true } });
    if (link === null || !previewLinkTokenMatches(presented, link.tokenHash)) {
      previewLinkMisses.fail(address, now);
      return refuse(401, "unauthorized");
    }
    return { kind: "link", linkId: link.id };
  }
  if (ctx.user === null) {
    return refuse(401, "unauthorized");
  }
  if (ctx.member === null) {
    return refuse(403, "forbidden");
  }
  // F-001: an account that still has its seeded default password reaches nothing until it changes it.
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return refuse(403, "forbidden");
  }
  return { kind: "member", organizationId: ctx.member.scope.organizationId, memberId: ctx.member.scope.memberId };
};

/** The view, when it's the one this viewer opened: anyone else's is `not-found`, as one that isn't. */
const viewFor = async (ctx: Context, viewer: Viewer, raw: string): Promise<PreviewViewRow | Response> => {
  const viewId = previewViewIdSchema.safeParse(raw);
  const view = viewId.success ? await previewViewInTx(ctx.deps.db, viewId.data) : null;
  const mine =
    view !== null &&
    (viewer.kind === "member"
      ? view.organizationId === viewer.organizationId && view.viewer.kind === "member" && view.viewer.memberId === viewer.memberId
      : view.viewer.kind === "link" && view.viewer.linkId === viewer.linkId);
  if (view === null || !mine) {
    return refuse(404, "not-found");
  }
  if (view.lifecycle.state === "closed") {
    return refuse(410, "view-closed");
  }
  return view;
};

/** The viewer's access now, read again: `null` when they may go on (watch-only counts for a stream). */
const accessNow = async (ctx: Context, viewId: PreviewViewId, wants: "watch" | "input"): Promise<Response | null> => {
  const check = await checkViewInput(ctx.deps.db, viewId, ctx.deps.ports.clock.now());
  if (check.ok) {
    return null;
  }
  switch (check.reason) {
    case "watch-only":
      return wants === "watch" ? null : refuse(403, "watch-only");
    case "not-found":
      return refuse(404, "not-found");
    case "closed":
      return refuse(410, "view-closed");
    case "link-unknown":
      return refuse(401, "unauthorized");
    case "not-allowed":
    case "link-expired":
    case "link-revoked":
    case "public-links-off":
    case "level-unknown":
      return refuse(403, check.reason);
    default:
      return check.reason satisfies never;
  }
};

/** The panel's token to core for this one view and its viewer, a minute long. */
const tokenFor = (ctx: Context, view: PreviewViewRow): string =>
  ctx.deps.previews.panelTokens.issue({ organizationId: view.organizationId, viewId: view.id, viewer: view.viewer, expiresAt: ctx.deps.ports.clock.now() + PANEL_PREVIEW_TOKEN_TTL_MS });

/** Core's refusal, relayed by its status and code, or `core-unreachable` for what the panel can't word. */
const relayRefusal = async (upstream: Response): Promise<Response> => {
  const json = parseJson(await upstream.text().catch(() => ""));
  const body = json.ok ? coreErrorSchema.safeParse(json.value) : null;
  const code = body?.success === true ? previewRouteErrorCodeSchema.safeParse(body.data.error.code) : null;
  if (code?.success === true) {
    return refuse(upstream.status, code.data);
  }
  return refuse(502, "core-unreachable");
};

/** The view and its viewer's access, or the refusal. */
const prepare = async (ctx: Context, request: Request, raw: string, wants: "watch" | "input"): Promise<PreviewViewRow | Response> => {
  const viewer = await viewerOf(ctx, request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const view = await viewFor(ctx, viewer, raw);
  if (view instanceof Response) {
    return view;
  }
  return (await accessNow(ctx, view.id, wants)) ?? view;
};

/** `GET /api/previews/:viewId/stream`: core's frames for the view, relayed as they come. */
export const servePreviewStream = async (ctx: Context, request: Request, rawViewId: string): Promise<Response> => {
  const view = await prepare(ctx, request, rawViewId, "watch");
  if (view instanceof Response) {
    return view;
  }
  const send = ctx.deps.previews.fetch ?? fetch;
  let upstream: Response;
  try {
    upstream = await send(`${ctx.deps.previews.coreUrl}${panelPreviewPaths.stream(view.id)}`, {
      headers: { authorization: `Bearer ${tokenFor(ctx, view)}` },
      // The member closed the pane, or the page: core's stream for them ends too.
      signal: request.signal,
    });
  } catch (error) {
    ctx.deps.logger.warn("preview.relay-unreachable", { viewId: view.id, route: "stream", error: error instanceof Error ? error.name : "unknown" });
    return refuse(502, "core-unreachable");
  }
  if (!upstream.ok || upstream.body === null) {
    return relayRefusal(upstream);
  }
  ctx.deps.logger.info("preview.relay-stream", { viewId: view.id, viewer: view.viewer.kind === "member" ? view.viewer.memberId : view.viewer.linkId });
  // `x-accel-buffering`: a proxy in front of the panel passes each frame on as it comes.
  return new Response(upstream.body, { status: 200, headers: { ...noStore, "content-type": "application/octet-stream", "x-accel-buffering": "no" } });
};

/** The request's body, up to `cap` bytes, or `null` when it's longer. */
const readCapped = async (request: Request, cap: number): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    return null;
  }
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    const value: unknown = part.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      return null;
    }
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/** Whether the request came from the panel's own pages: a browser names its origin on a POST. */
const fromThePanel = (ctx: Context, request: Request): boolean => {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(ctx.deps.settings.publicUrl).origin;
};

/** `POST /api/previews/:viewId/input`: a batch of the viewer's input, `{ events }`, relayed to core. */
export const servePreviewInput = async (ctx: Context, request: Request, rawViewId: string): Promise<Response> => {
  // JSON only, from the panel's own origin: a page elsewhere can't send it with the member's cookie.
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !fromThePanel(ctx, request)) {
    return refuse(403, "forbidden");
  }
  const view = await prepare(ctx, request, rawViewId, "input");
  if (view instanceof Response) {
    if (view.status === 403) {
      // Dropped here, before core and the runner: never the events themselves.
      const viewId = previewViewIdSchema.safeParse(rawViewId);
      ctx.deps.logger.info("preview.input-dropped", { viewId: viewId.success ? viewId.data : null, status: view.status });
    }
    return view;
  }
  const raw = await readCapped(request, runnerLimits.previewJsonMaxBytes);
  const json = raw === null ? null : parseJson(new TextDecoder().decode(raw));
  const body = json?.ok === true ? panelPreviewInputBodySchema.safeParse(json.value) : null;
  if (raw === null || body?.success !== true) {
    return refuse(400, "bad-request");
  }
  const send = ctx.deps.previews.fetch ?? fetch;
  let upstream: Response;
  try {
    upstream = await send(`${ctx.deps.previews.coreUrl}${panelPreviewPaths.input(view.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(ctx, view)}`, "content-type": "application/json" },
      body: JSON.stringify(body.data),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    ctx.deps.logger.warn("preview.relay-unreachable", { viewId: view.id, route: "input", error: error instanceof Error ? error.name : "unknown" });
    return refuse(502, "core-unreachable");
  }
  if (upstream.status === 204) {
    return new Response(null, { status: 204, headers: noStore });
  }
  return relayRefusal(upstream);
};
