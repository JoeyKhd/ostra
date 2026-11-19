import { describe, expect, it } from "vitest";

import { ostraMentionText } from "./pr-comments.ts";

// Ticket 25 (F-053): which comments ask `@ostra`, and what they ask. Pure.

describe("an @ostra comment", () => {
  it("F-053: starts with @ostra after whitespace, in any case, or holds it on a line of its own", () => {
    expect(ostraMentionText("@ostra add a test")).toBe("add a test");
    expect(ostraMentionText("\n  @OSTRA: add a test\nfor the empty case")).toBe("add a test\nfor the empty case");
    expect(ostraMentionText("Nice work.\n@ostra\nRename the helper.")).toBe("Rename the helper.");
    expect(ostraMentionText("Rename the helper.\n  @Ostra  ")).toBe("Rename the helper.");
    // Not an ask: a mention inside a sentence, another account, or none.
    expect(ostraMentionText("Ask @ostra to do it later")).toBeNull();
    expect(ostraMentionText("@ostra-bot hello")).toBeNull();
    expect(ostraMentionText("@ostrabot hello")).toBeNull();
    expect(ostraMentionText("Looks good to me.")).toBeNull();
  });
});
