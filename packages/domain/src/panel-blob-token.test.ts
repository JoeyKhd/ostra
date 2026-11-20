import { createHash } from "node:crypto";

import { organizationIdSchema, sha256HexSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { createPanelBlobTokens, PANEL_BLOB_TOKEN_PREFIX } from "./panel-blob-token.ts";
import type { PanelBlobClaims } from "./panel-blob-token.ts";

const SECRET = "a".repeat(64);
const NOW = 1_800_000_000_000;

const claims = (over: Partial<PanelBlobClaims> = {}): PanelBlobClaims => ({
  organizationId: organizationIdSchema.parse("01900000-0000-7000-8000-000000000001"),
  purpose: "skill-file",
  size: 12,
  sha256: sha256HexSchema.parse(createHash("sha256").update("hello world!").digest("hex")),
  expiresAt: NOW + 60_000,
  ...over,
});

describe("the token the panel gives core to store a member's file", () => {
  it("F-021: carries the organization, purpose, size and digest, and verifies until its deadline", () => {
    const tokens = createPanelBlobTokens(SECRET);
    const token = tokens.issue(claims());
    expect(token.startsWith(PANEL_BLOB_TOKEN_PREFIX)).toBe(true);
    expect(tokens.verify(token, NOW)).toEqual(claims());
    expect(tokens.verify(token, NOW + 59_999)).toEqual(claims());
    expect(tokens.verify(token, NOW + 60_000)).toBeNull();
  });

  it("F-021/c1: a token made under another key, or changed by one character in its claims, is refused", () => {
    const token = createPanelBlobTokens(SECRET).issue(claims());
    expect(createPanelBlobTokens("b".repeat(64)).verify(token, NOW)).toBeNull();
    // A forger swaps in a bigger organization or size and keeps the old signature.
    const [body, mac] = token.slice(PANEL_BLOB_TOKEN_PREFIX.length).split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")), s: 5_000_000 })).toString("base64url");
    expect(createPanelBlobTokens(SECRET).verify(`${PANEL_BLOB_TOKEN_PREFIX}${other}.${mac ?? ""}`, NOW)).toBeNull();
  });

  it("F-021: anything that isn't a token is refused, never thrown on", () => {
    const tokens = createPanelBlobTokens(SECRET);
    for (const junk of ["", "ostra-panel-", "ostra-panel-a.b.c", "Bearer x", `${PANEL_BLOB_TOKEN_PREFIX}${"x".repeat(3000)}`, "ostra-runner-abc.def"]) {
      expect(tokens.verify(junk, NOW)).toBeNull();
    }
  });
});
