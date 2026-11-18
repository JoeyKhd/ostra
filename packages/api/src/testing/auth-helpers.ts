import { TRPCError } from "@trpc/server";

// Helpers for tests that talk to better-auth the way a browser or a runner does.

/** Turns the `Set-Cookie` lines of a response into the `Cookie` header of the next request. */
export const cookieHeaderFrom = (responseHeaders: Headers): Headers => {
  const pairs = responseHeaders.getSetCookie().flatMap((line) => {
    const pair = line.split(";")[0]?.trim();
    return pair === undefined || pair === "" ? [] : [pair];
  });
  return new Headers({ cookie: pairs.join("; ") });
};

/** A strong enough password for the forms' rules (12 or more characters). */
export const TEST_PASSWORD = "correct-horse-battery-staple";

/** The code and message of the tRPC failure a call ends in; throws if it doesn't fail, or fails otherwise. */
export const trpcFailure = async (call: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof TRPCError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};
