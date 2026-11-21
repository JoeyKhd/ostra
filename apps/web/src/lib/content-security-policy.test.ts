import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "./content-security-policy";

// The panel's CSP and the preview domain (milestone 8, ticket 25, F-144, ADR 0068): frames come
// only from the preview domain's hosts, and only when there is one; the panel is never framed.

const directives = (policy: string): ReadonlyMap<string, string> =>
  new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(" ");
      return [name, values.join(" ")] as const;
    }),
  );

describe("the panel's CSP", () => {
  it("F-144/c6: with no preview domain the panel frames nothing, and nothing frames the panel", () => {
    for (const previewDomain of [undefined, "", "  "]) {
      const policy = directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain, publicUrl: "https://ostra.acme.dev", corePublicUrl: "https://core.acme.dev" }));
      expect(policy.has("frame-src")).toBe(false);
      expect(policy.get("default-src")).toBe("'self'");
      expect(policy.get("frame-ancestors")).toBe("'none'");
    }
  });

  it("F-144/c6: with a preview domain the panel frames its hosts on core's public scheme and port, nothing wider, and is still never framed itself", () => {
    const set = directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: "Previews.Acme.dev.", publicUrl: "https://ostra.acme.dev", corePublicUrl: "https://core.acme.dev" }));
    expect(set.get("frame-src")).toBe("https://*.previews.acme.dev");
    expect(set.get("frame-ancestors")).toBe("'none'");
    expect(set.get("default-src")).toBe("'self'");
    // A development install on `preview.localhost`, with core on its own port over http.
    const dev = directives(contentSecurityPolicy({ nonce: "n", dev: true, previewDomain: "preview.localhost", publicUrl: "http://localhost:3000", corePublicUrl: "http://localhost:8787" }));
    expect(dev.get("frame-src")).toBe("http://*.preview.localhost:8787");
    expect(dev.get("frame-ancestors")).toBe("'none'");
  });

  it("F-144/c10: a one-machine install frames its default preview.localhost hosts with the setting unset, a public host frames nothing, and off frames nothing", () => {
    // The panel and core on this machine, the setting unset: `preview.localhost` on core's port.
    for (const [publicUrl, corePublicUrl] of [
      ["http://localhost:3000", "http://localhost:8787"],
      ["http://127.0.0.1:3710", "http://127.0.0.1:9310"],
      ["http://[::1]:3000", "http://[::1]:8787"],
    ] as const) {
      const port = new URL(corePublicUrl).port;
      const local = directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: undefined, publicUrl, corePublicUrl }));
      expect(local.get("frame-src"), corePublicUrl).toBe(`http://*.preview.localhost:${port}`);
      expect(local.get("frame-ancestors")).toBe("'none'");
      // Empty is unset, as the server reads it.
      expect(directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: "", publicUrl, corePublicUrl })).get("frame-src")).toBe(`http://*.preview.localhost:${port}`);
      // `off` turns it off, whatever its case.
      expect(directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: " OFF ", publicUrl, corePublicUrl })).has("frame-src")).toBe(false);
    }
    // Core on loopback but the panel on a public host, or the other way: `*.localhost` would be the viewer's own machine.
    expect(directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: undefined, publicUrl: "https://ostra.acme.dev", corePublicUrl: "http://localhost:8787" })).has("frame-src")).toBe(false);
    expect(directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: undefined, publicUrl: "http://localhost:3000", corePublicUrl: "https://core.acme.dev" })).has("frame-src")).toBe(false);
    // An explicit domain still wins on one machine.
    expect(directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: "apps.localhost", publicUrl: "http://localhost:3000", corePublicUrl: "http://localhost:8787" })).get("frame-src")).toBe("http://*.apps.localhost:8787");
  });
});
