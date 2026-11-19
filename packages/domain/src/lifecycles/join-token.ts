import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A join token's lifecycle (F-091, ADR 0029): `active` until it expires or an admin revokes it.
// Expiry is read from the `Clock`, never stored as a state: a row holds `expiresAt` and
// `revokedAt`, and `joinTokenFromColumns` says which state that is now. `revoked` is final; an
// expired token can still be revoked, so the panel's list says who ended it.

export type JoinTokenLifecycle = { readonly state: "active" } | { readonly state: "expired" } | { readonly state: "revoked" };

export type JoinTokenInput =
  /** A runner joins with it: only an active token admits one, and it stays active. */
  | { readonly type: "use" }
  /** Its expiry passed, by the `Clock`. */
  | { readonly type: "expire" }
  /** An admin revokes it. */
  | { readonly type: "revoke" };

export const transitionJoinToken = (token: JoinTokenLifecycle, input: JoinTokenInput): Transition<JoinTokenLifecycle> => {
  const from = token.state;
  switch (input.type) {
    case "use":
      return from === "active" ? moveTo({ state: "active" }) : refuse(input, from);
    case "expire":
      return from === "active" ? moveTo({ state: "expired" }) : refuse(input, from);
    case "revoke":
      return from === "revoked" ? refuse(input, from) : moveTo({ state: "revoked" });
    default:
      return input satisfies never;
  }
};

/** A join token's state now, from its row and the clock's time (epoch ms). */
export const joinTokenFromColumns = (row: { readonly expiresAt: Date | null; readonly revokedAt: Date | null }, now: number): JoinTokenLifecycle => {
  if (row.revokedAt !== null) {
    return { state: "revoked" };
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now) {
    return { state: "expired" };
  }
  return { state: "active" };
};

const DAY_MS = 86_400_000;

/**
 * A new token's expiry (F-091): its pool's lifetime in days, or the setting's
 * (`OSTRA_JOIN_TOKEN_DAYS`, 30) when the pool names none. `0` days: it never expires (`null`).
 */
export const joinTokenExpiry = (now: number, poolDays: number | null, settingDays: number): Date | null => {
  const days = poolDays ?? settingDays;
  return days === 0 ? null : new Date(now + days * DAY_MS);
};
