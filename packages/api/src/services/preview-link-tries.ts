import { failureWindowLimiter, fixedWindowLimiter } from "./rate-limit.ts";

// How often one address may try a preview link's token (milestone 8, F-142, ADR 0068: "A link is
// a bearer token"). A token is 32 random bytes, so guessing one is hopeless; the limit keeps a
// stranger from turning the panel into an oracle anyway. Only a miss counts against the address,
// so a viewer's input, which carries the token on every batch, is never slowed by its own use.
// The viewer page's opens count apart, each one opens a view. Each replica counts on its own.

/** A token that opens nothing, from one address, this many times a minute: then it waits out the minute. */
export const PREVIEW_LINK_MISSES_PER_MINUTE = 20;

/** The viewer page's opens from one address a minute: each one opens a view. */
export const PREVIEW_LINK_OPENS_PER_MINUTE = 30;

export const previewLinkMisses = failureWindowLimiter({ limit: PREVIEW_LINK_MISSES_PER_MINUTE, windowMs: 60_000 });

export const previewLinkOpens = fixedWindowLimiter({ limit: PREVIEW_LINK_OPENS_PER_MINUTE, windowMs: 60_000 });

/**
 * The header the viewer page sends its link's token in, to the stream and input routes. Not
 * `Authorization`: better-auth's bearer plugin reads that one as a session. Never logged.
 */
export const PREVIEW_LINK_HEADER = "x-ostra-preview-link";
