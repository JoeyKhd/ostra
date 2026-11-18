import { LIVE_TEXT_MAX_CHARS } from "@ostra/protocol";
import type { LiveTextFrame, LiveTextKind, SegmentId, SessionId, TaskId, TurnId } from "@ostra/protocol";

// Partial text (ADR 0035): what the agent is still writing, sent as unsequenced frames at most
// every 250 ms per segment, never spooled and never acked. The buffer keeps each open segment's
// whole text so far, and a flush sends what was added since the last one. After a reconnect the
// next flush starts again from offset 0, a snapshot, because the server may have lost the rest.

export type LiveSegment = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly segmentId: SegmentId;
  readonly kind: LiveTextKind;
};

type Open = { readonly segment: LiveSegment; text: string; sent: number };

/** About this much text goes in one `live-text` frame, well under the 1 MiB frame cap. */
const FRAME_TEXT_BUDGET = 256 * 1024;

export type LiveTextBuffer = {
  readonly append: (segment: LiveSegment, delta: string) => void;
  /** The segment is complete (its `agent.message` or `agent.thought` event carries the text). */
  readonly end: (segmentId: SegmentId) => void;
  /** Drops every segment of a session. */
  readonly endSession: (sessionId: SessionId) => void;
  /** The next flush sends every open segment from offset 0. */
  readonly resnapshot: () => void;
  /** What to send now, in batches that each fit one `live-text` frame. Marks it sent. */
  readonly take: (maxFramesPerBatch: number) => readonly (readonly LiveTextFrame[])[];
};

export const createLiveTextBuffer = (): LiveTextBuffer => {
  const open = new Map<SegmentId, Open>();
  return {
    append: (segment, delta) => {
      if (delta.length === 0) {
        return;
      }
      const existing = open.get(segment.segmentId);
      if (existing === undefined) {
        open.set(segment.segmentId, { segment, text: delta, sent: 0 });
      } else {
        existing.text += delta;
      }
    },
    end: (segmentId) => {
      open.delete(segmentId);
    },
    endSession: (sessionId) => {
      for (const [segmentId, entry] of open) {
        if (entry.segment.sessionId === sessionId) {
          open.delete(segmentId);
        }
      }
    },
    resnapshot: () => {
      for (const entry of open.values()) {
        entry.sent = 0;
      }
    },
    take: (maxFramesPerBatch) => {
      const batches: LiveTextFrame[][] = [];
      let batch: LiveTextFrame[] = [];
      let batchChars = 0;
      const push = (frame: LiveTextFrame): void => {
        if (batch.length >= maxFramesPerBatch || (batch.length > 0 && batchChars + frame.text.length > FRAME_TEXT_BUDGET)) {
          batches.push(batch);
          batch = [];
          batchChars = 0;
        }
        batch.push(frame);
        batchChars += frame.text.length;
      };
      for (const entry of open.values()) {
        while (entry.sent < entry.text.length) {
          const text = entry.text.slice(entry.sent, entry.sent + LIVE_TEXT_MAX_CHARS);
          push({ ...entry.segment, offset: entry.sent, text });
          entry.sent += text.length;
        }
      }
      if (batch.length > 0) {
        batches.push(batch);
      }
      return batches;
    },
  };
};
