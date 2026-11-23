import type { RouterOutputs } from "@/lib/trpc";

// What the Linear page reads: `linear.status` (ticket 27), one union with `none` carrying the mode
// before the click. Times are epoch milliseconds, as every router sends them.

export type LinearStatus = RouterOutputs["linear"]["status"];
export type LinearNone = Extract<LinearStatus, { readonly state: "none" }>;
export type LinearConnection = Exclude<LinearStatus, { readonly state: "none" }>;
export type LinearMode = LinearStatus["mode"];
