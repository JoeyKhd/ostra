import { describe, expect, it } from "vitest";

import { checkLine, checkStatus, imageNameOf, parseAddress, parsePrefix, shortDigest } from "./registry-words";

// F-120 (registry.md): the Registry page's address, prefix and check result.

describe("the registry's words", () => {
  it("F-120: an address is a host and port; https is dropped, http only for this machine", () => {
    expect(parseAddress("registry.acme.dev")).toBe("registry.acme.dev");
    expect(parseAddress("https://registry.acme.dev/")).toBe("registry.acme.dev");
    expect(parseAddress("localhost:5000")).toBe("localhost:5000");
    expect(parseAddress("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(parseAddress("http://registry.acme.dev")).toBeNull();
    expect(parseAddress("registry acme")).toBeNull();
    expect(parsePrefix("ostra/")).toBe("ostra");
    expect(parsePrefix("team/ostra-dev")).toBe("team/ostra-dev");
    expect(parsePrefix("Ostra/")).toBeNull();
    expect(parsePrefix("")).toBeNull();
    expect(imageNameOf("registry.acme.dev", "ostra/")).toBe("registry.acme.dev/ostra/<project>:<snapshot>");
    expect(shortDigest(`sha256:9f3c1e${"0".repeat(54)}b82a`)).toBe("sha256:9f3c1e…b82a");
  });

  it("F-120/c1: the check's three outcomes, and an unreachable registry", () => {
    expect(checkLine({ result: "push-and-pull", status: null, detail: "" }, "ostra", "registry.acme.dev")).toBe("Push and pull both allowed for ostra/");
    expect(checkLine({ result: "pull-only", status: 403, detail: "" }, "ostra", "registry.acme.dev")).toContain("Pull allowed, push refused for ostra/.");
    expect(checkLine({ result: "refused", status: 401, detail: "The push credential was refused (401)." }, "ostra", "registry.acme.dev")).toBe("Refused: The push credential was refused (401).");
    expect(checkLine({ result: "refused", status: null, detail: "The registry at registry.acme.dev didn't answer." }, "ostra", "registry.acme.dev")).toBe(
      "Couldn't reach registry.acme.dev: The registry at registry.acme.dev didn't answer.",
    );
    expect(checkStatus(null, false).text).toBe("Not set");
    expect(checkStatus(null, true).text).toBe("Not checked");
    expect(checkStatus({ result: "refused", status: 401, detail: "" }, true)).toEqual({ tone: "red", text: "Refused" });
  });
});
