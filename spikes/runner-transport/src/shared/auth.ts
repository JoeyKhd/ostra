import { createHmac, timingSafeEqual } from "node:crypto";
import { RunnerId } from "../protocol/ids.ts";

// Spike-only auth: an HMAC of the runner ID under a secret the harness makes
// per run. ADR 0034's Ed25519 identity and 10-minute tokens are out of scope
// for this spike's question; the seam is the same (a bearer at the upgrade).

const mac = (secret: string, runnerId: string): string =>
  createHmac("sha256", secret).update(runnerId).digest("base64url");

export const mintToken = (secret: string, runnerId: RunnerId): string => `${runnerId}.${mac(secret, runnerId)}`;

export const verifyToken = (secret: string, header: string | undefined): RunnerId | undefined => {
  if (header?.startsWith("Bearer ") !== true) return undefined;
  const token = header.slice("Bearer ".length);
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const id = RunnerId.safeParse(token.slice(0, dot));
  if (!id.success) return undefined;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, id.data));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  return id.data;
};
