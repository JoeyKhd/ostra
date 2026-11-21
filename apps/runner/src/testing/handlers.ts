import type { CommandHandlers, CommandOutcome } from "../connection/peer.ts";

// Command handlers for tests that don't exercise commands.
const reject = (): Promise<CommandOutcome> => Promise.resolve({ result: "rejected", reason: "test" });

export const rejectAllHandlers: CommandHandlers = {
  dispatch: reject,
  steer: reject,
  interrupt: reject,
  stop: reject,
  "approval-answer": reject,
  drain: reject,
  "update-hint": reject,
  release: reject,
  "question-answer": reject,
  "plan-answer": reject,
  "snapshot-build": reject,
  "set-effort": reject,
  resume: reject,
  "app.start": reject,
  "app.stop": reject,
  "screenshot.take": reject,
  "preview.open": reject,
  "preview.close": reject,
  "preview.input": reject,
};
