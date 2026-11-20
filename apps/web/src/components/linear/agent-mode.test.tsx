import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentModeState, PublicAddress } from "./agent-mode";
import type { AgentMode } from "./agent-mode";

// Milestone 6's review follow-ups (ticket 41, F-012): agent mode's State and Public address rows,
// as `linear-agent-mode.md` gives them.

const agent = (over: Partial<AgentMode> = {}): AgentMode => ({
  on: true,
  since: Date.UTC(2026, 10, 18, 9),
  turnedOnByName: "Alex Kim",
  grantedScopes: ["app:assignable", "app:mentionable"],
  missingScopes: [],
  reachable: true,
  unreachableReason: null,
  publicAddress: "https://ostra.acme.dev",
  nextRenewalAt: null,
  boards: [],
  sessions: { open: 0, awaitingApproval: 0, postedToday: 0 },
  lastSessionEvents: [],
  ...over,
});

describe("Linear agent mode (linear-agent-mode.md)", () => {
  it("F-012/c3: the Public address row shows the address Linear's webhooks arrive at, or why Linear can't reach it", () => {
    const reachable = renderToStaticMarkup(<PublicAddress agent={agent()} />);
    expect(reachable).toContain(">https://ostra.acme.dev</span>");
    expect(reachable).toContain("Reachable: Linear&#x27;s webhooks arrive here");
    const unreachable = renderToStaticMarkup(<PublicAddress agent={agent({ reachable: false, unreachableReason: "a private address" })} />);
    expect(unreachable).toContain("Not reachable from Linear");
    expect(unreachable).toContain("· a private address");
  });

  it("F-012/c3: with agent mode on and the address unreachable, State reads On, not receiving", () => {
    expect(renderToStaticMarkup(<AgentModeState agent={agent()} justTurnedOn={false} />)).toContain(">On</");
    const deaf = renderToStaticMarkup(<AgentModeState agent={agent({ reachable: false, unreachableReason: "polling" })} justTurnedOn={false} />);
    expect(deaf).toContain("On, not receiving");
    expect(deaf).toContain("by Alex Kim");
    expect(renderToStaticMarkup(<AgentModeState agent={agent({ on: false, reachable: false })} justTurnedOn={false} />)).toContain("Off");
  });
});
