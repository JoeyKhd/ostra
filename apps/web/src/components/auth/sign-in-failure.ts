import { t } from "@/lib/messages";

/**
 * Why a sign-in failed, as the form tells it (sign-in.md, States). `credentials` never says which
 * half was wrong, and is the only one that marks the inputs.
 */
export type SignInFailure = "credentials" | "tooMany" | "unknown";

/** better-auth's HTTP status for a refused sign-in, as a failure. A 5xx or no reply is `unknown`. */
export const signInFailureOf = (status: number): SignInFailure => {
  if (status === 429) return "tooMany";
  if (status >= 400 && status < 500) return "credentials";
  return "unknown";
};

export const signInFailureText = (failure: SignInFailure): string => {
  switch (failure) {
    case "credentials":
      return t("signIn.failed");
    case "tooMany":
      return t("signIn.tooMany");
    case "unknown":
      return t("errors.unknown");
    default:
      return failure satisfies never;
  }
};
