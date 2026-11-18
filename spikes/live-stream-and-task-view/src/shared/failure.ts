// A failure is a plain Error carrying a code and scalar details (ADR 0025: classes are for adapters only).
// The server throws one for every non-2xx reply; the page throws one for a reply it did not accept.
export type FailureDetails = Readonly<Record<string, string | number | boolean | null>>;

export type Failure<C extends string> = Error & { readonly code: C; readonly details: FailureDetails };

export const createFailure = <C extends string>(code: C, message: string, details: FailureDetails = {}): Failure<C> =>
  Object.assign(new Error(message), { code, details });

export const isFailure = (error: unknown): error is Failure<string> =>
  error instanceof Error && "code" in error && typeof error.code === "string" && "details" in error && typeof error.details === "object";
