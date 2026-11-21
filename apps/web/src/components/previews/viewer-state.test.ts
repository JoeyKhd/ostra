import { describe, expect, it } from "vitest";

import { previewViewIdSchema } from "@ostra/protocol";

import { expiryWords, learnedEnd, viewerOf } from "./viewer-state";

// The viewer page of a preview link (milestone 8, ticket 21, F-142; preview-viewer.md): what it
// shows for each state the server gives it, and what it learns while it's open. The live run is
// `e2e/24-preview.spec.ts`.

const viewId = previewViewIdSchema.parse("0193a1f0-0000-7000-8000-00000000f002");
const shown = { label: "web", port: 5173, organizationName: "Acme Corp", expiresAt: 10_000_000, input: false };

describe("the viewer page", () => {
  it("F-142/c7: a live link shows the preview's label and port, the organization, the expiry and the mode, and nothing else of the task", () => {
    const viewer = viewerOf({ state: "live", viewId, ...shown });
    expect(viewer).toEqual({ kind: "live", viewId, shown });
    expect(Object.keys(viewer.kind === "live" ? viewer.shown : {}).sort()).toEqual(["expiresAt", "input", "label", "organizationName", "port"]);
    expect(viewerOf({ state: "not-running", ...shown })).toEqual({ kind: "not-running", shown });
  });

  it("F-142/c4: an expired, revoked, disallowed or unserved link shows no picture and says why, and an unknown one never says whether it existed", () => {
    expect(viewerOf({ state: "expired", label: "web", port: 5173, organizationName: "Acme Corp", at: 5 })).toMatchObject({ kind: "ended", end: { kind: "expired", at: 5 } });
    expect(viewerOf({ state: "revoked", label: "web", port: 5173, organizationName: "Acme Corp", at: 6 })).toMatchObject({ kind: "ended", end: { kind: "revoked", at: 6 } });
    expect(viewerOf({ state: "not-allowed", organizationName: "Acme Corp" })).toMatchObject({ kind: "ended", end: { kind: "not-allowed" } });
    expect(viewerOf({ state: "runner-too-old", organizationName: "Acme Corp" })).toMatchObject({ kind: "ended", end: { kind: "runner-too-old" } });
    expect(viewerOf({ state: "unknown" })).toEqual({ kind: "ended", end: { kind: "unknown" }, shown: null });
    expect(viewerOf({ state: "too-many-tries" })).toEqual({ kind: "ended", end: { kind: "too-many-tries" }, shown: null });
    // What the heartbeat learns of an open page: a revoke now, an expiry at the link's own end.
    expect(learnedEnd("revoked", shown, 77)).toEqual({ kind: "revoked", organizationName: "Acme Corp", at: 77 });
    expect(learnedEnd("expired", shown, 77)).toEqual({ kind: "expired", label: "web", port: 5173, organizationName: "Acme Corp", at: 10_000_000 });
    expect(learnedEnd("unknown", shown, 77)).toEqual({ kind: "unknown" });
  });

  it("F-142/c3: says the link's time left as the page shows it: minutes under an hour, hours under two days, then days", () => {
    const now = 1_000_000;
    expect(expiryWords(now + 52 * 60_000, now)).toBe("Expires in 52 min");
    expect(expiryWords(now + 23 * 3_600_000 + 59 * 60_000, now)).toBe("Expires in 23 h");
    expect(expiryWords(now + 6 * 86_400_000 + 3_600_000, now)).toBe("Expires in 6 days");
    expect(expiryWords(now - 5, now)).toBe("Expires in 1 min");
  });
});
