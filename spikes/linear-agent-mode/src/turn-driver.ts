import { isAbortError } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { AgentSessionId } from "./ids.ts";

// The seam where, in ostra, a runner takes over. The spike has no runner: these drivers stand in for one,
// to show that the fast lane (acknowledge, first activity, keep-alive, stop) never waits for it.

export type TurnOutcome =
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "stopped" };

export type TurnHandle = {
  readonly done: Promise<TurnOutcome>;
  /** Stops the turn and settles `done` with `stopped`. */
  stop: () => Promise<void>;
  /** Passes a follow-up to the running turn. */
  steer: (text: string) => void;
};

export type TurnRequest =
  | { readonly sessionId: AgentSessionId; readonly reason: "delegated" }
  /** A follow-up that reopens a session: the new turn starts from this text, so it cannot be dropped. */
  | { readonly sessionId: AgentSessionId; readonly reason: "follow-up"; readonly text: string };

export type TurnStart =
  | { readonly kind: "started"; readonly handle: TurnHandle }
  | { readonly kind: "unavailable"; readonly reason: string };

export type TurnDriver = {
  startTurn: (request: TurnRequest) => TurnStart;
};

/** A driver that records what it was asked, so a scenario can check what the server did and when. */
export type RecordingDriver = TurnDriver & {
  readonly starts: { readonly request: TurnRequest; readonly at: number }[];
  readonly followUps: { readonly sessionId: AgentSessionId; readonly text: string }[];
  readonly stops: AgentSessionId[];
};

const createRecorder = (): Pick<RecordingDriver, "starts" | "followUps" | "stops"> => ({
  starts: [],
  followUps: [],
  stops: [],
});

/** A turn that runs for `durationMs` on `clock` and says nothing: a long tool call with no output. */
export const createSilentDriver = (options: { readonly clock: Clock; readonly durationMs: number }): RecordingDriver => {
  const recorder = createRecorder();
  return {
    ...recorder,
    startTurn: (request) => {
      recorder.starts.push({ request, at: performance.now() });
      if (request.reason === "follow-up") recorder.followUps.push({ sessionId: request.sessionId, text: request.text });
      const controller = new AbortController();
      const done = (async (): Promise<TurnOutcome> => {
        try {
          await options.clock.sleep(options.durationMs, controller.signal);
          return { kind: "completed", summary: "The simulated silent turn finished." };
        } catch (error: unknown) {
          if (isAbortError(error)) return { kind: "stopped" };
          throw error;
        }
      })();
      return {
        kind: "started",
        handle: {
          done,
          stop: async () => {
            recorder.stops.push(request.sessionId);
            controller.abort();
            await done;
          },
          steer: (text) => {
            recorder.followUps.push({ sessionId: request.sessionId, text });
          },
        },
      };
    },
  };
};

/** A runner pool with nothing free, or a laptop that is offline. */
export const createUnavailableDriver = (reason: string): RecordingDriver => {
  const recorder = createRecorder();
  return {
    ...recorder,
    startTurn: (request) => {
      recorder.starts.push({ request, at: performance.now() });
      if (request.reason === "follow-up") recorder.followUps.push({ sessionId: request.sessionId, text: request.text });
      return { kind: "unavailable", reason };
    },
  };
};

/** A turn that is already finished when it starts. */
export const createInstantDriver = (): RecordingDriver => {
  const recorder = createRecorder();
  return {
    ...recorder,
    startTurn: (request) => {
      recorder.starts.push({ request, at: performance.now() });
      if (request.reason === "follow-up") recorder.followUps.push({ sessionId: request.sessionId, text: request.text });
      return {
        kind: "started",
        handle: {
          done: Promise.resolve({ kind: "completed", summary: "Done." }),
          stop: async () => {
            recorder.stops.push(request.sessionId);
            await Promise.resolve();
          },
          steer: (text) => {
            recorder.followUps.push({ sessionId: request.sessionId, text });
          },
        },
      };
    },
  };
};
