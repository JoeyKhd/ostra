import { isIP } from "node:net";
import { z } from "zod";

// Git LFS through the git proxy (ADR 0030 as amended, Q119, spike 4). An LFS batch answer names
// where each object goes, with signed URLs and headers that are credentials in all but name. The
// proxy keeps them: it rewrites each action to a nonce URL on itself, kept at most an hour, and
// calls the real one on the agent's behalf. It calls only the upstream's own origin and the hosts
// the code host lists (`lfsActionHosts` in the task spec), over https, by name. An object with an
// action anywhere else gets a per-object error and no actions, never an empty `actions`: git-lfs
// reads an object with no actions as already there, so an upload would "succeed" with nothing sent.
//
// Ported from spikes/github-app-and-git-proxy/src/git-proxy.ts (the LFS parts).

export const LFS_ACTION_REFUSED_MESSAGE = "ostra: the LFS server sent this object's transfer to a host the proxy doesn't allow";
/** The longest an LFS action stays callable through the proxy. */
export const LFS_ACTION_MAX_TTL_S = 3600;

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;

/**
 * An LFS action URL the proxy will call with the action's own headers: the upstream's origin, or
 * https on an allowlisted host name. Never an IP literal, never localhost, never a
 * `user:password@` or an odd port.
 */
export const isAllowedLfsActionHref = (href: URL, upstreamOrigin: string, hosts: readonly string[]): boolean => {
  if (href.origin === upstreamOrigin) {
    return true;
  }
  if (href.protocol !== "https:" || href.username !== "" || href.password !== "") {
    return false;
  }
  if (href.port !== "" && href.port !== "443") {
    return false;
  }
  const host = href.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }
  return hosts.some((pattern) => hostMatches(host, pattern.toLowerCase().replace(/:443$/, "")));
};

// LFS's batch API: a vendor's format, so unknown fields are tolerated.
export const lfsBatchRequestSchema = z.looseObject({
  operation: z.enum(["upload", "download"]),
  objects: z.array(z.looseObject({ oid: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })).max(1000),
});

export const lfsActionSchema = z.looseObject({
  href: z.url(),
  header: z.record(z.string(), z.string()).optional(),
  expires_in: z.number().optional(),
  expires_at: z.string().optional(),
});

export const lfsBatchResponseSchema = z.looseObject({
  objects: z.array(
    z.looseObject({
      oid: z.string(),
      size: z.number(),
      actions: z.record(z.string(), lfsActionSchema).optional(),
    }),
  ),
});

/** An action the proxy calls for the agent, behind its nonce URL. */
export type HeldLfsAction = {
  readonly href: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** The action is on the upstream's origin and carries no credential of its own: send the token. */
  readonly addToken: boolean;
  readonly repo: string;
  readonly expiresAt: number;
};
