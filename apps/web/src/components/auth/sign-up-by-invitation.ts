import { authClient } from "@/lib/auth-client";

import type { PasswordRule } from "./new-password";

// Sign-up through an invitation (F-002, accept-invite.md, "Sign-up"): better-auth's `/sign-up/email`
// with the invitation's ID, which ostra's `before` hook needs to let it through (ticket 22).

/** What the sign-up came to, as the page shows it. */
export type SignUpOutcome =
  | { readonly kind: "joined" }
  | { readonly kind: "verify" }
  | { readonly kind: "username-taken" }
  | { readonly kind: "address-in-use" }
  | { readonly kind: "password"; readonly rule: PasswordRule }
  | { readonly kind: "unusable"; readonly preview: { readonly state: "not-found" } }
  | { readonly kind: "unknown" };

/** better-auth's refusal, by its error code, as the page's outcome. */
export const signUpOutcomeOf = (status: number, code: string | undefined): SignUpOutcome => {
  switch (code ?? "") {
    case "USERNAME_IS_ALREADY_TAKEN":
      return { kind: "username-taken" };
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { kind: "address-in-use" };
    case "PASSWORD_TOO_SHORT":
      return { kind: "password", rule: "min" };
    case "PASSWORD_TOO_LONG":
      return { kind: "password", rule: "max" };
    default:
      return status === 403 || status === 404 ? { kind: "unusable", preview: { state: "not-found" } } : { kind: "unknown" };
  }
};

export const signUpByInvitation = async (input: { readonly invitationId: string; readonly email: string; readonly username: string; readonly password: string }): Promise<SignUpOutcome> => {
  try {
    const result = await authClient.signUp.email({
      email: input.email,
      password: input.password,
      name: input.username,
      username: input.username,
      callbackURL: `/invite/${encodeURIComponent(input.invitationId)}?verified=1`,
      fetchOptions: { headers: { "x-ostra-invitation": input.invitationId } },
    });
    if (result.error !== null) return signUpOutcomeOf(result.error.status, result.error.code);
    // With email set up no session is made: the membership waits on the address check.
    return result.data.token === null ? { kind: "verify" } : { kind: "joined" };
  } catch {
    return { kind: "unknown" };
  }
};
