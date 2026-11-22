import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canaryFile, canaryInEvents, fakeMarker } from "@ostra/adapter-sdk/testing";
import { expect } from "vitest";
import { startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "./task-host-harness.ts";

// F-116 (ADR 0031, ADR 0035): the canary. A file outside the task's workspace, read by a scripted
// shell call, must show in the task's event log: the scripted fake agent runs `cat <path>` as an
// `execute` tool call, and the session's events as core stores them hold that call with the
// canary's path in its input and the canary's marker in its output. The same case runs on every
// executor (`canary.{host,docker,kubernetes}.test.ts`): on `host` the agent is the runner's child;
// on `docker` and `kubernetes` it runs in the agent's container, through the real bridge to the
// box's init, as a box's sidecar drives it.

export type CanaryMode = {
  readonly name: "host" | "docker" | "kubernetes";
  readonly makeExecutor?: HarnessOptions["makeExecutor"];
};

export const canaryCases = (mode: CanaryMode) => {
  let current: Shared | undefined;
  let harness: Harness | undefined;
  let outside = "";

  return {
    setup: async (): Promise<void> => {
      current = await startShared(`canary-${mode.name}`);
      // Its own folder, apart from the runner's: nothing of a task's workspace is in it.
      outside = await mkdtemp(path.join(os.tmpdir(), "ostra-canary-outside-"));
    },
    teardown: async (): Promise<void> => {
      await current?.close();
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    cleanup: async (): Promise<void> => {
      await harness?.close();
      harness = undefined;
    },
    readShowsInTheLog: async (): Promise<void> => {
      if (current === undefined) {
        throw new Error("the cases' setup didn't run");
      }
      const h = await startHarness(current, mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor });
      harness = h;
      const canary = canaryFile(path.join(outside, "canary.txt"), `ostra-canary-${randomBytes(6).toString("hex")}`);
      await writeFile(canary.path, canary.content);
      // Outside the runner's whole folder, so outside every task's workspace.
      expect(path.relative(h.dataDir, canary.path).startsWith("..")).toBe(true);
      const { spec } = h.taskFor(fakeMarker("shell-read", canary.path));
      h.dispatch(spec);
      await h.waitForKind(spec, "tool.completed");

      const events = h.eventsOf(spec);
      // The shell call, with the canary's path in its full input.
      const call = h.ofKind(spec, "tool.called").find((event) => event.toolKind === "execute" && JSON.stringify(event.input).includes(JSON.stringify(canary.path).slice(1, -1)));
      expect(call, "the shell call, with the canary's path in its input").toBeDefined();
      // And what it read: the marker, in the call's output.
      const done = h.ofKind(spec, "tool.completed").find((event) => event.toolCallId === call?.toolCallId);
      expect(JSON.stringify(done?.output)).toContain(canary.content.trim());
      expect(canaryInEvents(events, canary)).toBe(true);
    },
  };
};
