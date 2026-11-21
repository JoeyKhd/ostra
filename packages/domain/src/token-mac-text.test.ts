import { createHash, randomUUID } from "node:crypto";

import { lenientTwins, tamperToken } from "@ostra/adapter-sdk/testing";
import {
  blobIdSchema,
  loginSessionIdSchema,
  memberIdSchema,
  organizationIdSchema,
  previewKeySchema,
  previewViewIdSchema,
  sha256HexSchema,
  taskIdSchema,
} from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { createPanelBlobReadTokens, createPanelBlobTokens } from "./panel-blob-token.ts";
import { createPanelStartAppTokens } from "./previews/start-app-on-core.ts";
import { createPanelPreviewTokens, createPreviewCookies, signReplicaRequest, verifyReplicaRequest } from "./previews/tokens.ts";

// Every token the domain signs with an HMAC: each takes its MAC's one canonical base64url text, and
// no other. Node's base64url decoder reads several texts as the same bytes (a last character's
// unused bits, padding, `+` and `/`), so a verifier that compares decoded bytes would take them all.

const SECRET = "k".repeat(44);
const NOW = 1_800_000_000_000;
const organizationId = organizationIdSchema.parse(randomUUID());
const memberId = memberIdSchema.parse(randomUUID());
const taskId = taskIdSchema.parse(randomUUID());
const viewId = previewViewIdSchema.parse(randomUUID());

type Signed = { readonly name: string; readonly issue: () => string; readonly verifies: (token: string) => boolean };

const signed: readonly Signed[] = [
  {
    name: "the panel's blob token",
    issue: () =>
      createPanelBlobTokens(SECRET).issue({
        organizationId,
        purpose: "skill-file",
        size: 12,
        sha256: sha256HexSchema.parse(createHash("sha256").update("hello world!").digest("hex")),
        expiresAt: NOW + 60_000,
      }),
    verifies: (token) => createPanelBlobTokens(SECRET).verify(token, NOW) !== null,
  },
  {
    name: "the panel's blob read token",
    issue: () => createPanelBlobReadTokens(SECRET).issue({ organizationId, taskId, blobId: blobIdSchema.parse(randomUUID()), expiresAt: NOW + 60_000 }),
    verifies: (token) => createPanelBlobReadTokens(SECRET).verify(token, NOW) !== null,
  },
  {
    name: "the panel's start-app token",
    issue: () => createPanelStartAppTokens(SECRET).issue({ organizationId, memberId, taskId, expiresAt: NOW + 60_000 }),
    verifies: (token) => createPanelStartAppTokens(SECRET).verify(token, NOW) !== null,
  },
  {
    name: "the panel's preview token",
    issue: () => createPanelPreviewTokens(SECRET).issue({ organizationId, viewId, viewer: { kind: "member", memberId }, expiresAt: NOW + 60_000 }),
    verifies: (token) => createPanelPreviewTokens(SECRET).verify(token, NOW, viewId) !== null,
  },
  {
    name: "the native preview's cookie",
    issue: () => {
      const cookies = createPreviewCookies(SECRET);
      return cookies.issue({
        grantId: cookies.newGrantId(),
        organizationId,
        taskId,
        key: previewKeySchema.parse("app-web"),
        port: 5173,
        viewer: { kind: "member", memberId, loginSessionId: loginSessionIdSchema.parse("login-1") },
        expiresAt: NOW + 3_600_000,
      });
    },
    verifies: (token) => createPreviewCookies(SECRET).verify(token, NOW) !== null,
  },
  {
    name: "a replica's forwarded request's signature",
    issue: () => signReplicaRequest(SECRET, { method: "GET", path: `/panel/v1/previews/${viewId}/stream`, viewId, at: NOW }),
    verifies: (signature) => verifyReplicaRequest(SECRET, { method: "GET", path: `/panel/v1/previews/${viewId}/stream`, viewId }, signature, NOW),
  },
];

describe("the domain's signed tokens, by their MAC's text", () => {
  it.each(signed)("$name verifies as issued, and not with a character of its MAC changed", ({ issue, verifies }) => {
    for (let round = 0; round < 50; round += 1) {
      const token = issue();
      expect(verifies(token)).toBe(true);
      expect(verifies(tamperToken(token))).toBe(false);
    }
  });

  it.each(signed)("$name refuses any other text of the same MAC", ({ issue, verifies }) => {
    for (let round = 0; round < 50; round += 1) {
      for (const twin of lenientTwins(issue())) {
        expect(verifies(twin), twin).toBe(false);
      }
    }
  });
});
