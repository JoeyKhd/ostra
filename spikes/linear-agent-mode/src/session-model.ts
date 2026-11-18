// ostra's side of one Linear agent session: a discriminated union, so a state that cannot happen
// cannot be written down. Linear derives the session's own status from the last activity; this is
// what ostra knows about its own work for the session.

export type EndReason = "completed" | "failed" | "stopped" | "no-runner" | "restored";

export type SessionState =
  /** The `created` webhook was accepted. Nothing has been posted back yet. */
  | { readonly kind: "received" }
  /** The first activity (or link) landed. No work has started. */
  | { readonly kind: "acknowledged" }
  /** A turn is running. */
  | { readonly kind: "working" }
  /** A stop was asked for. The final `response` has not landed yet. */
  | { readonly kind: "stopping" }
  /** No turn is running. A follow-up reopens the session. */
  | { readonly kind: "ended"; readonly reason: EndReason };

export type SessionTransition =
  | { readonly kind: "first-activity-posted" }
  | { readonly kind: "turn-started" }
  | { readonly kind: "stop-requested" }
  | { readonly kind: "turn-ended"; readonly reason: EndReason };

export type TransitionResult =
  | { readonly ok: true; readonly state: SessionState }
  | { readonly ok: false; readonly reason: string };

export const transition = (state: SessionState, event: SessionTransition): TransitionResult => {
  const ok = (next: SessionState): TransitionResult => ({ ok: true, state: next });
  const rejected = (): TransitionResult => ({ ok: false, reason: `${event.kind} while ${state.kind}` });
  switch (event.kind) {
    case "first-activity-posted":
      return state.kind === "received" ? ok({ kind: "acknowledged" }) : rejected();
    case "turn-started":
      // `received` is allowed: if the first activity could not land, the work still goes ahead.
      return state.kind === "received" || state.kind === "acknowledged" || state.kind === "ended"
        ? ok({ kind: "working" })
        : rejected();
    case "stop-requested":
      // A stop is always honoured, and asking twice is the same as asking once.
      return ok({ kind: "stopping" });
    case "turn-ended":
      return state.kind === "ended" ? rejected() : ok({ kind: "ended", reason: event.reason });
    default:
      return event satisfies never;
  }
};
