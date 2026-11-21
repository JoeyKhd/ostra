import { describe, expect, it } from "vitest";

import { FakeAgentAdapter } from "./fake-acp-agent/fake-agent-adapter.ts";
import { checkParity, parityFeatures, parityTable, pendingParity, suiteCases } from "./parity.ts";
import type { ParitySubject } from "./parity.ts";

// Adapter parity for the scripted fakes (milestone 7, ticket 03; spec section 6): each fake the
// agent suite runs has an entry for every row, and each entry names cases that exist and run the
// way the fake declares its capabilities. OpenCode's entry is checked in its own package's tests.

/** The fakes exactly as `fake-agent.test.ts` runs the suite on them. */
const fakes: readonly ParitySubject[] = [
  new FakeAgentAdapter("rich"),
  new FakeAgentAdapter("plain"),
  new FakeAgentAdapter("plain", undefined, undefined, "index-only", "none", { unknownNotification: true }),
  new FakeAgentAdapter("rich", undefined, undefined, "mcp", "session-option"),
];

describe("adapter parity, the scripted fakes", () => {
  it("F-019/c3: every scripted fake has an entry for every row, naming cases that exist and run the way it declares each capability", async () => {
    expect(fakes.map((fake) => fake.name)).toEqual([
      "fake-acp-agent-rich",
      "fake-acp-agent-plain",
      "fake-acp-agent-plain-index-only-unknown-notification",
      "fake-acp-agent-rich-effort",
    ]);
    expect(await checkParity(fakes)).toEqual([]);
    // What still waits is milestone 6's rows and the fakes' milestone 8 app rows, each naming its ticket.
    expect(pendingParity().every((line) => line.includes("milestone 6") || line.includes("milestone 8, ticket 03"))).toBe(true);
    // OpenCode, the agent v1 ships, waits for none of milestone 8's rows.
    expect(pendingParity().filter((line) => line.startsWith("opencode:") && line.includes("milestone 8"))).toEqual([]);
  });

  it("F-019/c3: the check fails when a row is deleted from an adapter's entry, a case doesn't exist, or a declared capability has only its fallback", async () => {
    const [rich, plain] = fakes;
    if (rich === undefined || plain === undefined) throw new Error("the fakes are listed");
    const richEntries = parityTable[rich.name] ?? {};
    const withoutSteer = Object.fromEntries(Object.entries(richEntries).filter(([feature]) => feature !== "F-024 Steer"));
    expect(await checkParity([rich], { [rich.name]: withoutSteer })).toEqual(
      expect.arrayContaining([`${rich.name}: no entry for F-024 Steer`]),
    );
    // A case renamed in the table but not in the suite.
    const renamed = { ...richEntries, "F-025 Stop": { kind: "cases" as const, cases: [{ ...suiteCases.cancel, title: `${suiteCases.cancel.title}, renamed` }] } };
    expect(await checkParity([rich], { [rich.name]: renamed })).toEqual([
      `${rich.name}: packages/adapter-sdk/src/testing/agent-suite.ts has no case "${suiteCases.cancel.title}, renamed"`,
    ]);
    // The rich fake steers: naming only the fallback for steering is refused, and so is leaving steering's case out.
    const fallbackOnly = { ...richEntries, "F-024 Steer": { kind: "fallback" as const, capability: "steerMidTurn" as const, cases: [suiteCases.steerGuard] } };
    expect(await checkParity([rich], { [rich.name]: fallbackOnly })).toEqual([
      `${rich.name}: F-024 Steer names a fallback for steerMidTurn, which it declares: it must prove the capability itself`,
      `${rich.name}: declares steerMidTurn on, and no case among its entries runs that way`,
    ]);
    // An adapter the table doesn't know.
    expect(await checkParity([{ name: "another-agent", capabilities: plain.capabilities }])).toEqual(["another-agent: no entry in the parity table"]);
  });

  it("lists every row of spec section 6 once", () => {
    expect(new Set(parityFeatures).size).toBe(parityFeatures.length);
    expect(parityFeatures).toHaveLength(31);
  });
});
