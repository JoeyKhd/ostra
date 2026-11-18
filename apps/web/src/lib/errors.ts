import { t } from "./messages";

// A router's failure, in words (ticket 37: "each form shows the router's typed failures in
// words"). tRPC carries a code and a message the server wrote for people; a Zod refusal carries
// its issues as JSON in the message, which this turns into one line.

type ErrorLike = { readonly message: string; readonly data?: { readonly code?: string } | null | undefined } | null;

const issueLine = (message: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed)) return null;
    const first: unknown = parsed[0];
    if (typeof first !== "object" || first === null) return null;
    const text: unknown = Reflect.get(first, "message");
    const path: unknown = Reflect.get(first, "path");
    const field = Array.isArray(path) && path.length > 0 ? path.join(".") : null;
    if (typeof text !== "string") return null;
    return field === null ? text : `${field}: ${text}`;
  } catch {
    return null;
  }
};

/** One line for a failed request: the server's own message, or a plain one for its code. */
export const errorText = (error: ErrorLike): string | null => {
  if (error === null) return null;
  const code = error.data?.code;
  if (code === "BAD_REQUEST") return issueLine(error.message) ?? error.message;
  if (code === "UNAUTHORIZED") return t("errors.signedOut");
  if (code === "INTERNAL_SERVER_ERROR") return t("errors.server");
  if (error.message.length > 0 && error.message.length < 300) return error.message;
  return t("errors.unknown");
};
