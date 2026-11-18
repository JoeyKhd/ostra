import { describe, expect, it } from "vitest";
import { interruptedTurn, lastFinishedReply, lastTextOfAnyTurn, statedPort, type TurnLog } from "../src/harness/history.ts";

const turn = (n: number, stopReason: string): TurnLog => ({ n, stopReason, ms: 0, afterTurnMs: 0, committed: false, archiveBytes: 0 });

describe("the agent's last message, for the rebuild template", () => {
  const chatty = {
    turns: [turn(1, "end_turn"), turn(2, "end_turn"), turn(3, "end_turn"), turn(4, "cancelled")],
    agentTexts: ["OK", "I will use port 4377 because it is free.", "", "I'll start with step 1."],
  };

  it("is the last finished turn's reply, not an interrupted turn's fragment", () => {
    expect(lastFinishedReply(chatty)).toBe("I will use port 4377 because it is free.");
    expect(lastTextOfAnyTurn(chatty)).toBe("I'll start with step 1.");
  });

  it("keeps the interrupted turn's fragment on its own", () => {
    expect(interruptedTurn(chatty)).toEqual({ partialText: "I'll start with step 1." });
    expect(interruptedTurn({ turns: [turn(1, "end_turn")], agentTexts: ["done"] })).toBeUndefined();
  });

  it("is undefined when no finished turn said anything", () => {
    expect(lastFinishedReply({ turns: [turn(1, "cancelled")], agentTexts: ["partial"] })).toBeUndefined();
  });
});

describe("the port turn 5 settled on", () => {
  it("is the last one the agent stated, not the first it named", () => {
    expect(statedPort("I will use port 4173 is outside range... Let's choose 4500.\n\nI will use port 4500 because it is free.")).toBe("4500");
    expect(statedPort("I will use port 4377 because nothing uses it.")).toBe("4377");
    expect(statedPort("Port 4100, then.")).toBe("4100");
    expect(statedPort("no number here")).toBeUndefined();
  });
});
