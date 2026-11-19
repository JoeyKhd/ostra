import { describe, expect, it } from "vitest";

import { runnerStateText, runnerTone } from "./runner-words";
import type { RunnerState } from "./runner-words";

const states = ["joining", "online", "offline", "draining", "revoked"] as const satisfies readonly RunnerState[];

describe("runner words", () => {
  it("has a word for every state, never the raw name of an unmapped one", () => {
    expect(states.map(runnerStateText)).toEqual(["joining", "online", "offline", "draining", "revoked"]);
  });

  it("tones online green, draining amber and the rest grey", () => {
    expect(states.map(runnerTone)).toEqual(["grey", "green", "grey", "amber", "grey"]);
  });
});
