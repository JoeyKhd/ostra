import { profileLimits, requireOrganizationAdmin } from "@ostra/domain";

import { PASSWORD_CHANGE_REQUIRED } from "../trpc/init.ts";
import type { Context } from "../trpc/context.ts";

// A skill's file, uploaded from the profile editor (F-021, ticket 42; spec section 13, item 6): the
// panel takes the bytes, checks who sent them and how big they are, and has core's blob service
// store them (ADR 0043: the panel writes no blob). Organization admins only, like the profile's save;
// one file a request, at most 1 MiB, never a page. The answer is the blob's ID and size, which the
// editor then names in the profile's save. The bytes are untrusted data: they're never read as
// anything, only stored, and no log line holds them.

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

const refuse = (status: number, error: string): Response => Response.json({ error }, { status, headers: jsonHeaders });

/** The request's body, up to `cap` bytes, or `null` when it is longer: it stops reading at the cap. */
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
    // A request body's chunks are bytes; anything else is no file.
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

export const serveSkillFileUpload = async (ctx: Context, request: Request): Promise<Response> => {
  if (ctx.user === null) {
    return refuse(401, "Sign in first");
  }
  if (ctx.member === null) {
    return refuse(403, "This account belongs to no organization");
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return refuse(403, PASSWORD_CHANGE_REQUIRED);
  }
  const scope = ctx.member.scope;
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return refuse(403, "Only an organization admin may add a skill's files");
  }
  // Not a form and not text: a page on another site can't send it with the member's cookie.
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") {
    return refuse(415, "Send the file's bytes as application/octet-stream");
  }
  const bytes = await readCapped(request, profileLimits.skillFileMaxBytes);
  if (bytes === null) {
    return refuse(413, "A skill's file is at most 1 MiB");
  }
  if (bytes.length === 0) {
    return refuse(400, "The file is empty");
  }
  const stored = await ctx.deps.blobStore.upload({ organizationId: scope.organizationId, purpose: "skill-file", bytes });
  switch (stored.kind) {
    case "stored":
      return Response.json({ blobId: stored.blobId, size: stored.size }, { status: 200, headers: jsonHeaders });
    case "too-large":
      return refuse(413, "A skill's file is at most 1 MiB");
    case "unavailable":
      return refuse(503, "The file couldn't be stored: core didn't take it. Try again.");
    default:
      return stored satisfies never;
  }
};
