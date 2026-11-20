import { checkParity, parityTable } from "@ostra/adapter-sdk/testing";
import { describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "./opencode-adapter.ts";

// Adapter parity for OpenCode, v1's one agent (milestone 7, ticket 03; spec section 6): its entry
// in the table names, for every feature that touches agents, the case that proves it on OpenCode,
// and every capability it declares, or lacks, has a case that runs that way on it.

describe("adapter parity, OpenCode", () => {
  it("F-019: OpenCode has an entry for every row, naming cases that exist and run the way it declares each capability", async () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.name).toBe("opencode");
    expect(await checkParity([adapter])).toEqual([]);
  });

  it("F-019: OpenCode's check fails when a row is deleted from its entry", async () => {
    const adapter = new OpenCodeAdapter();
    const rest = Object.fromEntries(Object.entries(parityTable["opencode"] ?? {}).filter(([feature]) => feature !== "F-062 Questions"));
    expect(await checkParity([adapter], { opencode: rest })).toEqual([
      "opencode: no entry for F-062 Questions",
      "opencode: declares elicitationForm on, and no case among its entries runs that way",
    ]);
  });
});
