import type { AdapterError } from "@ostra/adapter-sdk";
import { TRPCError } from "@trpc/server";

// How an adapter's typed failure reaches the panel (ADR 0025: expected failures are values). The
// message is the adapter's, which is for a person and never holds content or a token.
//
// A vendor refusing ostra's credential is the vendor's answer, not the member's: it is
// `BAD_GATEWAY`, never `UNAUTHORIZED`, which would sign the member out of the panel.

export const adapterErrorToTrpc = (error: AdapterError, subject: string): TRPCError => {
  const message = `${subject}: ${error.message}`;
  const code = error.code;
  switch (code) {
    case "not-found":
      return new TRPCError({ code: "NOT_FOUND", message });
    case "invalid-input":
      return new TRPCError({ code: "BAD_REQUEST", message });
    case "conflict":
      return new TRPCError({ code: "CONFLICT", message });
    case "rate-limited":
      return new TRPCError({ code: "TOO_MANY_REQUESTS", message });
    case "unsupported":
      return new TRPCError({ code: "NOT_IMPLEMENTED", message });
    case "unauthorized":
    case "forbidden":
    case "unavailable":
    case "invalid-response":
    case "aborted":
      return new TRPCError({ code: "BAD_GATEWAY", message });
    default:
      return code satisfies never;
  }
};
