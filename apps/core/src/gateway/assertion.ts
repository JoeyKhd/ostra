import { createPublicKey, verify } from "node:crypto";

import { runnerLimits, tokenAssertionCanonicalString } from "@ostra/protocol";
import type { RunnerId, TokenAssertion } from "@ostra/protocol";

// A runner's signed assertion (ADR 0034, ticket 01's canonical string): Ed25519, by the runner's
// own key, over `ostra-runner-token-v1\n<runnerId>\n<issuedAt>\n<nonce>`. The server refuses an
// `issuedAt` too far from its clock and a nonce it has seen.

/** Whether `signature` is the runner's, over the assertion's canonical string. */
export const verifyAssertionSignature = (assertion: TokenAssertion, publicKey: string): boolean => {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(
      null,
      Buffer.from(tokenAssertionCanonicalString(assertion), "utf8"),
      key,
      Buffer.from(assertion.signature, "base64url"),
    );
  } catch {
    return false;
  }
};

/** Whether `issuedAt` is within the allowed skew of the server's clock. */
export const assertionFresh = (issuedAt: number, now: number): boolean =>
  Math.abs(now - issuedAt) <= runnerLimits.assertionSkewMs;

/**
 * Nonces seen within the skew window, so an assertion is good once. Per process: one core replica in
 * milestone 1. With several, a replayed assertion could get one more token from another replica
 * within two minutes; F-092 (milestone 5) moves this to Postgres.
 */
export type NonceCache = { readonly firstUse: (runnerId: RunnerId, nonce: string, now: number) => boolean };

export const createNonceCache = (): NonceCache => {
  const seen = new Map<string, number>();
  return {
    firstUse: (runnerId, nonce, now) => {
      for (const [key, expiry] of seen) {
        if (expiry <= now) {
          seen.delete(key);
        }
      }
      const key = `${runnerId}\n${nonce}`;
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, now + 2 * runnerLimits.assertionSkewMs);
      return true;
    },
  };
};
