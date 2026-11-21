import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "./content-security-policy";

// The panel's CSP and the preview domain (milestone 8, ticket 25, F-144, ADR 0068): frames come
// only from the preview domain's hosts, and only when one is set; the panel is never framed.

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
      const policy = directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain, corePublicUrl: "https://core.acme.dev" }));
      expect(policy.has("frame-src")).toBe(false);
      expect(policy.get("default-src")).toBe("'self'");
      expect(policy.get("frame-ancestors")).toBe("'none'");
    }
  });

  it("F-144/c6: with a preview domain the panel frames its hosts on core's public scheme and port, nothing wider, and is still never framed itself", () => {
    const set = directives(contentSecurityPolicy({ nonce: "n", dev: false, previewDomain: "Previews.Acme.dev.", corePublicUrl: "https://core.acme.dev" }));
    expect(set.get("frame-src")).toBe("https://*.previews.acme.dev");
    expect(set.get("frame-ancestors")).toBe("'none'");
    expect(set.get("default-src")).toBe("'self'");
    // A development install on `preview.localhost`, with core on its own port over http.
    const dev = directives(contentSecurityPolicy({ nonce: "n", dev: true, previewDomain: "preview.localhost", corePublicUrl: "http://localhost:8787" }));
    expect(dev.get("frame-src")).toBe("http://*.preview.localhost:8787");
    expect(dev.get("frame-ancestors")).toBe("'none'");
  });
});
