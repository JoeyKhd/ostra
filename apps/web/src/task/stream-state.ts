import { applyLiveTextFrame, emptyLiveText, pruneLiveText } from "@ostra/task-view";
import type { LiveTextState } from "@ostra/task-view";
import type { LiveTextFrame, SegmentId, StoredEvent } from "@ostra/protocol";

// What a task page holds of its task's log: the committed events it has (history pages and the
// live tail, merged by seq, never twice), the partial text of open segments, and where the next
// older page starts. Pure, so the page and its tests run the same code. Ported from
// spikes/live-stream-and-task-view/src/web/task-stream.ts.

export type Connection = "connecting" | "live" | "reconnecting";

export type TaskStreamState = {
  /** Committed events, ascending by seq, each once. */
  readonly events: readonly StoredEvent[];
  readonly live: LiveTextState;
  /** The `beforeSeq` of the next older history page, or `null` once the start of the log is loaded. */
  readonly olderBefore: number | null;
  /** The newest committed seq held: where a resumed stream continues. */
  readonly headSeq: number;
  readonly loaded: boolean;
  readonly connection: Connection;
};

export const initialStreamState: TaskStreamState = {
  events: [],
  live: emptyLiveText,
  olderBefore: null,
  headSeq: 0,
  loaded: false,
  connection: "connecting",
};

export type StreamAction =
  | { readonly type: "first-page"; readonly events: readonly StoredEvent[]; readonly olderBefore: number | null }
  | { readonly type: "older-page"; readonly events: readonly StoredEvent[]; readonly olderBefore: number | null }
  | { readonly type: "events"; readonly events: readonly StoredEvent[] }
  | { readonly type: "live"; readonly frame: LiveTextFrame }
  | { readonly type: "live-end"; readonly segmentId: SegmentId }
  | { readonly type: "connection"; readonly connection: Connection };

/** Merges two ascending runs of events by seq, keeping the first copy of each seq. */
export const mergeEvents = (held: readonly StoredEvent[], incoming: readonly StoredEvent[]): readonly StoredEvent[] => {
  if (incoming.length === 0) return held;
  const last = held.at(-1);
  const sorted = [...incoming].sort((a, b) => a.seq - b.seq);
  // The common case: the live tail appends after everything held.
  if (last === undefined || (sorted[0]?.seq ?? 0) > last.seq) {
    const out = [...held];
    let previous = last?.seq ?? 0;
    for (const event of sorted) {
      if (event.seq > previous) {
        out.push(event);
        previous = event.seq;
      }
    }
    return out;
  }
  const bySeq = new Map<number, StoredEvent>();
  for (const event of held) bySeq.set(event.seq, event);
  let changed = false;
  for (const event of sorted) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
      changed = true;
    }
  }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : held;
};

const withEvents = (state: TaskStreamState, events: readonly StoredEvent[]): TaskStreamState => {
  const merged = mergeEvents(state.events, events);
  if (merged === state.events) return state;
  return {
    ...state,
    events: merged,
    live: pruneLiveText(state.live, events),
    headSeq: merged.at(-1)?.seq ?? state.headSeq,
  };
};

export const streamReducer = (state: TaskStreamState, action: StreamAction): TaskStreamState => {
  switch (action.type) {
    case "first-page":
      return { ...withEvents({ ...state, loaded: true }, action.events), loaded: true, olderBefore: action.olderBefore };
    case "older-page":
      return { ...withEvents(state, action.events), olderBefore: action.olderBefore };
    case "events":
      return withEvents(state, action.events);
    case "live": {
      // A frame for a segment already committed is late: its message is in the log.
      const committed = state.events.some(
        ({ event }) => (event.kind === "agent.message" || event.kind === "agent.thought") && event.segmentId === action.frame.segmentId,
      );
      if (committed) return state;
      const live = applyLiveTextFrame(state.live, action.frame);
      return live === state.live ? state : { ...state, live };
    }
    case "live-end": {
      if (!state.live.has(action.segmentId)) return state;
      const live = new Map(state.live);
      live.delete(action.segmentId);
      return { ...state, live };
    }
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    default:
      return action satisfies never;
  }
};
