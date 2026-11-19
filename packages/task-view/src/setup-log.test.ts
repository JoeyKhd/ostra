import { describe, expect, it } from "vitest";

import { foldTaskEvents } from "./fold.ts";
import { storeEvents } from "./testing/index.ts";
import type { TaskUIPart } from "./ui-types.ts";

// F-050: the panel shows the setup log. The task page renders the thread this fold makes; its
// `data-setup` part is the setup row (apps/web's `renderers.tsx`), with the script's output in order.

const setupParts = (parts: readonly TaskUIPart[]) => parts.flatMap((part) => (part.type === "data-setup" ? [part] : []));

describe("the setup log", () => {
  it("F-050: the setup's output, stdout and stderr in order, and how it ended make one setup row of the session", () => {
    const events = storeEvents([
      { kind: "environment.setup_started" },
      { kind: "environment.setup_output", stream: "stdout", text: "Installing...\n" },
      { kind: "environment.setup_output", stream: "stderr", text: "npm warn deprecated\n" },
      { kind: "environment.setup_output", stream: "stdout", text: "Done.\n" },
      { kind: "environment.setup_finished", exitCode: 0, durationMs: 1200 },
    ]);
    const running = setupParts(foldTaskEvents(events.slice(0, 3), []).flatMap((message) => message.parts));
    expect(running).toHaveLength(1);
    expect(running[0]?.data).toMatchObject({ state: "running", output: [{ stream: "stdout", text: "Installing...\n" }, { stream: "stderr", text: "npm warn deprecated\n" }] });

    const done = setupParts(foldTaskEvents(events, []).flatMap((message) => message.parts));
    expect(done).toHaveLength(1);
    expect(done[0]?.data).toEqual({
      sessionId: events[0]?.sessionId,
      state: "succeeded",
      output: [
        { stream: "stdout", text: "Installing...\n" },
        { stream: "stderr", text: "npm warn deprecated\n" },
        { stream: "stdout", text: "Done.\n" },
      ],
      exitCode: 0,
      durationMs: 1200,
    });
  });

  it("F-050: a failing setup shows as failed, with its exit code and its output", () => {
    const events = storeEvents([
      { kind: "environment.setup_started" },
      { kind: "environment.setup_output", stream: "stderr", text: "pnpm: command not found\n" },
      { kind: "environment.setup_finished", exitCode: 127, durationMs: 40 },
    ]);
    const [setup] = setupParts(foldTaskEvents(events, []).flatMap((message) => message.parts));
    expect(setup?.data).toMatchObject({ state: "failed", exitCode: 127, output: [{ stream: "stderr", text: "pnpm: command not found\n" }] });
  });
});
