import { randomUUID } from "node:crypto";

import { segmentIdSchema } from "@ostra/protocol";
import type { SessionChannel } from "@ostra/runner";

import { drawRatePerMinute, newScriptState, nextEvent, pickKind } from "./mix.ts";

// A scripted agent in place of OpenCode (ticket 34, ADR 0061): it writes events into the runner's
// real session channel (numbered, spooled, sent and acked by `apps/runner`'s peer) at a rate drawn
// from spike 10's mix, and, when partial text is on, also streams the text it's writing as the real
// runner does. It never runs a model or touches a repo: everything past the channel is ostra's own.

export type ScriptedAgent = {
  readonly ratePerMinute: number;
  /** Events written into the channel so far: the highest session number. */
  readonly offered: () => number;
  /** Stops writing; what's written still goes. */
  readonly pause: () => void;
  /** Resolves once every event handed to the channel is in its spool. */
  readonly settled: () => Promise<void>;
  /** A line of partial text holding `marker`, for a browser to watch for. When it was handed to the channel. */
  readonly mark: (marker: string) => number;
  /** Notes an ack: each acked event's time from being written to being acked goes to `onAckLatency`. */
  readonly acked: (upTo: number) => void;
};

export type ScriptedAgentOptions = {
  readonly channel: SessionChannel;
  readonly partialText: boolean;
  readonly random?: () => number;
  /** Overrides the drawn rate (the end-to-end test's quick script). */
  readonly ratePerMinute?: number;
  readonly onAckLatency?: (ms: number) => void;
  readonly onError?: (error: unknown) => void;
};

/** How many characters of partial text each event adds, as the agent writes. */
const LIVE_DELTA = "and so the cursor moves on ";

export const startScriptedAgent = (options: ScriptedAgentOptions): ScriptedAgent => {
  const random = options.random ?? Math.random;
  const ratePerMinute = options.ratePerMinute ?? drawRatePerMinute(random);
  const gapMs = 60_000 / ratePerMinute;
  const channel = options.channel;
  const state = newScriptState();
  const writtenAt = new Map<number, number>();
  let last = 0;
  let paused = false;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();

  const write = (make: () => Parameters<SessionChannel["emit"]>[0]): void => {
    chain = chain
      .then(async () => {
        const at = performance.now();
        const sent = await channel.emit(make());
        last = sent.sessionSeq;
        if (options.onAckLatency !== undefined) writtenAt.set(sent.sessionSeq, at);
      })
      .catch((error: unknown) => options.onError?.(error));
  };

  const tick = (): void => {
    if (paused) return;
    const kind = pickKind(random);
    const segment = state.segmentId;
    write(() => nextEvent(state, kind));
    if (options.partialText && (kind === "agent.thought" || kind === "agent.message")) {
      // The text being written streams as partial text; the message event ends its segment.
      if (kind === "agent.message") channel.endLiveText(segment);
      else channel.appendLiveText({ turnId: state.turnId, segmentId: state.segmentId, kind: "message" }, LIVE_DELTA);
    }
    // A little jitter around the task's rate, so the runners don't tick in step.
    timer = setTimeout(tick, gapMs * (0.5 + random()));
    timer.unref();
  };

  write(() => ({ kind: "turn.started", turnId: state.turnId }));
  timer = setTimeout(tick, gapMs * random());
  timer.unref();

  return {
    ratePerMinute,
    offered: () => last,
    pause: () => {
      paused = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    settled: () => chain,
    mark: (marker) => {
      const segmentId = segmentIdSchema.parse(randomUUID());
      channel.appendLiveText({ turnId: state.turnId, segmentId, kind: "message" }, `Checking ${marker} now`);
      return Date.now();
    },
    acked: (upTo) => {
      if (options.onAckLatency === undefined) return;
      const now = performance.now();
      for (const [seq, at] of writtenAt) {
        if (seq > upTo) continue;
        options.onAckLatency(now - at);
        writtenAt.delete(seq);
      }
    },
  };
};
