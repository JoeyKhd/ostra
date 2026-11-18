import type {
  LiveTextFrame,
  LiveTextKind,
  SegmentId,
  SessionId,
  StoredEvent,
  TurnId,
} from "@ostra/protocol";

// Partial text, held by the viewer (ADR 0035). A frame with offset 0 is a snapshot that replaces
// the segment's text; any other offset appends at that position. A frame whose offset doesn't
// match what the viewer holds is dropped, and the segment waits for its next snapshot. Partial
// text is never saved: the completed `agent.message` or `agent.thought` replaces it.

export type LiveText = {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly segmentId: SegmentId;
  readonly kind: LiveTextKind;
  readonly text: string;
  /** True after a frame was dropped: deltas are ignored until the next snapshot. */
  readonly awaitingSnapshot: boolean;
};

export type LiveTextState = ReadonlyMap<SegmentId, LiveText>;

export const emptyLiveText: LiveTextState = new Map();

/** Applies one frame. Returns the same map when nothing changed, so a render can be skipped. */
export const applyLiveTextFrame = (state: LiveTextState, frame: LiveTextFrame): LiveTextState => {
  const current = state.get(frame.segmentId);
  let next: LiveText;
  if (frame.offset === 0) {
    next = {
      sessionId: frame.sessionId,
      turnId: frame.turnId,
      segmentId: frame.segmentId,
      kind: frame.kind,
      text: frame.text,
      awaitingSnapshot: false,
    };
  } else if (current === undefined || current.awaitingSnapshot) {
    // A delta for a segment we have no snapshot of: wait for the next snapshot.
    if (current?.awaitingSnapshot === true) return state;
    next = {
      sessionId: frame.sessionId,
      turnId: frame.turnId,
      segmentId: frame.segmentId,
      kind: frame.kind,
      text: "",
      awaitingSnapshot: true,
    };
  } else if (frame.offset === current.text.length) {
    next = { ...current, text: current.text + frame.text };
  } else {
    next = { ...current, awaitingSnapshot: true };
  }
  const copy = new Map(state);
  copy.set(frame.segmentId, next);
  return copy;
};

/** Drops the segments whose completed message is among `events`. */
export const pruneLiveText = (
  state: LiveTextState,
  events: readonly StoredEvent[],
): LiveTextState => {
  if (state.size === 0) return state;
  let copy: Map<SegmentId, LiveText> | undefined;
  for (const { event } of events) {
    if (
      (event.kind === "agent.message" || event.kind === "agent.thought") &&
      state.has(event.segmentId)
    ) {
      copy ??= new Map(state);
      copy.delete(event.segmentId);
    }
    if ((event.kind === "turn.ended" || event.kind === "turn.failed") && state.size > 0) {
      for (const [segmentId, live] of copy ?? state) {
        if (live.turnId === event.turnId) {
          copy ??= new Map(state);
          copy.delete(segmentId);
        }
      }
    }
  }
  return copy ?? state;
};

/**
 * The segments to show: every one with text. A segment waiting for a snapshot keeps showing what
 * it held, which was correct up to the dropped frame.
 */
export const visibleLiveText = (state: LiveTextState): LiveText[] =>
  [...state.values()].filter((live) => live.text.length > 0);
