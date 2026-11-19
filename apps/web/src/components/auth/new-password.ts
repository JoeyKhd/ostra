import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@ostra/domain/accounts";

import { t } from "@/lib/messages";

// The rules of "Choose a new password" (change-password.md, States), apart from the form, so the
// states can be tested without a browser.

/** The password policy's two rules: at least, and at most, so many characters. */
export type PasswordRule = "min" | "max";

/** The rule a new password breaks, or null. An empty one breaks `min`. */
export const brokenRuleOf = (password: string): PasswordRule | null => {
  if (password.length > MAX_PASSWORD_LENGTH) return "max";
  if (password.length < MIN_PASSWORD_LENGTH) return "min";
  return null;
};

/** The help line under the new password: quiet, met (a green check), or the error it is. */
export type RuleLine = { readonly tone: "plain" | "met" | "error"; readonly rule: PasswordRule };

/**
 * The rule line for `password`. `flagged` is a rule already shown as broken: by leaving the field
 * short, by a submit, or by the server's refusal. Going over the maximum shows at once.
 */
export const ruleLineOf = (password: string, flagged: PasswordRule | null): RuleLine => {
  if (password.length > MAX_PASSWORD_LENGTH) return { tone: "error", rule: "max" };
  if (flagged !== null) return { tone: "error", rule: flagged };
  if (password.length >= MIN_PASSWORD_LENGTH) return { tone: "met", rule: "min" };
  return { tone: "plain", rule: "min" };
};

export const ruleText = (rule: PasswordRule): string => {
  switch (rule) {
    case "min":
      return t("changePassword.rule", { n: MIN_PASSWORD_LENGTH });
    case "max":
      return t("changePassword.ruleMax", { n: MAX_PASSWORD_LENGTH });
    default:
      return rule satisfies never;
  }
};

/** Why the server refused the change: the session is gone, the policy said no, or anything else. */
export type ChangeFailure =
  | { readonly kind: "signedOut" }
  | { readonly kind: "rejected"; readonly rule: PasswordRule }
  | { readonly kind: "unknown" };

/** better-auth's refusal of `/change-password`, by HTTP status and error code (0: no reply). */
export const changeFailureOf = (status: number, code: string | undefined): ChangeFailure => {
  if (status === 401) return { kind: "signedOut" };
  if (code === "PASSWORD_TOO_SHORT") return { kind: "rejected", rule: "min" };
  if (code === "PASSWORD_TOO_LONG") return { kind: "rejected", rule: "max" };
  return { kind: "unknown" };
};
