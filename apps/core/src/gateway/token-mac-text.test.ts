import { randomBytes, randomUUID } from "node:crypto";

import { lenientTwins, tamperToken } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, organizationIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { createAccessTokens } from "./access-token.ts";
import { createTaskTokens } from "./task-token.ts";

// A runner's access token and a box's task token take their MAC's one canonical base64url text, and
// no other: Node's decoder reads several texts as the same bytes (a last character's unused bits,
// padding, `+` and `/`), so comparing decoded bytes would take them all.

const NOW = 1_800_000_000_000;
const key = randomBytes(32);
const organizationId = organizationIdSchema.parse(randomUUID());
const runnerId = runnerIdSchema.parse(randomUUID());

type Signed = { readonly name: string; readonly issue: () => string; readonly verifies: (token: string) => boolean };

const signed: readonly Signed[] = [
  {
    name: "a runner's access token",
    issue: () => createAccessTokens(key).issue(runnerId, organizationId, NOW).accessToken,
    verifies: (token) => createAccessTokens(key).verify(token, NOW) !== null,
  },
  {
    name: "a box's task token",
    issue: () =>
      createTaskTokens(key).issue({ organizationId, taskId: taskIdSchema.parse(randomUUID()), leaseEpoch: 1, boxId: boxIdSchema.parse(randomUUID()), runnerId }),
    verifies: (token) => createTaskTokens(key).verify(token) !== null,
  },
];

describe("core's signed tokens, by their MAC's text", () => {
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
