import { eventFixtures } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { storableEvent } from "./storable-event.ts";

describe("storableEvent", () => {
  it("keeps an event without a NUL as it is", () => {
    const event = { ...eventFixtures["agent.message"], text: "plain text" };
    expect(storableEvent(event)).toBe(event);
  });

  it("replaces each NUL, which jsonb refuses, with U+FFFD", () => {
    const event = { ...eventFixtures["agent.message"], text: "a\u0000b\u0000" };
    expect(storableEvent(event)).toEqual({ ...event, text: "a�b�" });
  });

  it("leaves a literal backslash-u0000 in the text alone", () => {
    const event = { ...eventFixtures["agent.message"], text: String.raw`a\u0000b` };
    expect(storableEvent(event)).toEqual(event);
  });
});
