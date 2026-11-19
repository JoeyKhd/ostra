import type { ClientMessageId } from "../ids.ts";
import type { StoredEvent } from "./agent-events.ts";

// Where each member message stands, read from the task's log (F-024, ADR 0036; milestone 3's
// ticket 19). Every viewer folds the same committed events, so a message reads the same to all of
// them. A message an agent takes mid-turn is `immediate` when it's written. One that can't be taken
// mid-turn (an agent without `steerMidTurn`, or a session between turns) is written `queued`, and the
// runner delivers it as the next turn's prompt: the `turn.started` it records in the same session
// after the message is that delivery, and the message then reads "delivered after the turn".
// "Interrupt and send" keeps its own word either way.

/** How a member message reads in the thread. */
export type MessageDeliveryState = "delivered" | "queued" | "delivered-after-turn" | "after-interrupt";

/** The fields of a stored event this reads: the session it's in, and the event. */
export type DeliveryLogEntry = { readonly sessionId: string; readonly event: StoredEvent["event"] };

/**
 * Each member message's delivery, by its client ID, from the log in order. A message written again
 * with the same client ID (a replay into a new session) reads as its newest write.
 */
export const messageDeliveries = (log: readonly DeliveryLogEntry[]): ReadonlyMap<ClientMessageId, MessageDeliveryState> => {
  const states = new Map<ClientMessageId, MessageDeliveryState>();
  /** Queued messages per session, waiting for that session's next turn to start. */
  const waiting = new Map<string, ClientMessageId[]>();
  for (const { sessionId, event } of log) {
    if (event.kind === "user.message") {
      switch (event.delivery) {
        case "immediate":
          states.set(event.clientMessageId, "delivered");
          break;
        case "after-interrupt":
          states.set(event.clientMessageId, "after-interrupt");
          break;
        case "queued": {
          states.set(event.clientMessageId, "queued");
          waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), event.clientMessageId]);
          break;
        }
        default:
          event.delivery satisfies never;
      }
    } else if (event.kind === "turn.started") {
      for (const id of waiting.get(sessionId) ?? []) {
        if (states.get(id) === "queued") {
          states.set(id, "delivered-after-turn");
        }
      }
      waiting.delete(sessionId);
    }
  }
  return states;
};
