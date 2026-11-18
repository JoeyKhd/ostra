import type { DbEnum } from "@ostra/db";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A session's lifecycle (domain-model.md, "A session's lifecycle"): one conversation with one
// agent profile in one box. Only one session per task is starting, running, waiting or idle.
// In milestone 1 a session is one turn: starting → running → idle → ended.

/** How a session began (Q53, ADR 0039). */
export type SessionOrigin = DbEnum.SessionOrigin;

export type SessionState =
  | { readonly state: "starting" }
  | { readonly state: "running" }
  /** A turn waits on a needs-you item. */
  | { readonly state: "waiting" }
  /** The turn is over; the box stays warm. */
  | { readonly state: "idle" }
  /** The box stopped. `withChanges`: some repo's branch is ahead (F-030, F-065). */
  | { readonly state: "ended"; readonly withChanges: boolean }
  /** By a member, by runaway protection, or at the spend cap. */
  | { readonly state: "stopped" }
  /** The agent, the sidecar or the box died; the branches, hidden ref and archive stay. */
  | { readonly state: "crashed" };

export type SessionStateName = SessionState["state"];

export type SessionInput =
  | { readonly type: "agent_ready" }
  | { readonly type: "turn_started" }
  | { readonly type: "waiting_on_person" }
  | { readonly type: "person_answered" }
  | { readonly type: "turn_ended" }
  | { readonly type: "box_stopped"; readonly withChanges: boolean }
  | { readonly type: "stop" }
  | { readonly type: "crash" };

const activeStates: ReadonlySet<SessionStateName> = new Set(["starting", "running", "waiting", "idle"]);

/** Whether a session counts against "one active session per task". */
export const isSessionActive = (session: SessionState): boolean => activeStates.has(session.state);

export const transitionSession = (session: SessionState, input: SessionInput): Transition<SessionState> => {
  const from = session.state;
  switch (input.type) {
    case "agent_ready":
      return from === "starting" ? moveTo({ state: "running" }) : refuse(input, from);
    case "turn_started":
      return from === "idle" ? moveTo({ state: "running" }) : refuse(input, from);
    case "waiting_on_person":
      return from === "running" ? moveTo({ state: "waiting" }) : refuse(input, from);
    case "person_answered":
      return from === "waiting" ? moveTo({ state: "running" }) : refuse(input, from);
    case "turn_ended":
      return from === "running" || from === "waiting" ? moveTo({ state: "idle" }) : refuse(input, from);
    case "box_stopped":
      return from === "idle" ? moveTo({ state: "ended", withChanges: input.withChanges }) : refuse(input, from);
    case "stop":
      return activeStates.has(from) ? moveTo({ state: "stopped" }) : refuse(input, from);
    case "crash":
      return activeStates.has(from) ? moveTo({ state: "crashed" }) : refuse(input, from);
    default:
      return input satisfies never;
  }
};
