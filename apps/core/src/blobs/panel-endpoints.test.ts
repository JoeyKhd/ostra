import { createHash, randomBytes } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { corePanelUploader } from "@ostra/api";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { createPanelBlobTokens, PANEL_BLOB_PATH, profileLimits, systemClock } from "@ostra/domain";
import { blobIdSchema, organizationIdSchema, sha256HexSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { createBlobService } from "./blob-service.ts";
import type { BlobService } from "./blob-service.ts";
import { handlePanelBlobEndpoint } from "./panel-endpoints.ts";

// F-021 (ticket 42, a skill's files): the panel's way to have core store a member's file. The panel
// side is the real `corePanelUploader`, and core's side is the real endpoint over HTTP on a real
// blob service, so the whole hand-over is exercised: a token under the shared secrets key, the
// bytes, the digest, the cap, and the blob that lands in the organization's store.

const SECRET = randomBytes(32).toString("hex");
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});

let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;
let blobs: BlobService;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 4 * 1024 * 1024 }, context: { logger, clock: systemClock } });
  harness = await startGateway(test.db, test.url, {}, () => [handlePanelBlobEndpoint({ blobs, secret: () => Promise.resolve(SECRET), clock: systemClock, logger })]);
});

afterAll(async () => {
  await harness.stop();
  await test.dispose();
});

const organizationId = (): string => fixture.a.organization.id;
const uploader = (secret = SECRET) => corePanelUploader({ coreUrl: harness.url, secret, logger: silentLogger });
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("core's endpoint for the panel's files", () => {
  it("F-021: stores a skill's file for the organization, as a blob with no task, and the bytes read back whole", async () => {
    const text = "2026-11-19: example line\nsecond line\n";
    const stored = await uploader()({ organizationId: organizationId(), purpose: "skill-file", bytes: bytesOf(text) });
    expect(stored.kind).toBe("stored");
    if (stored.kind !== "stored") return;
    expect(stored.size).toBe(text.length);
    const row = await test.db.blob.findUniqueOrThrow({ where: { id: stored.blobId } });
    expect(row).toMatchObject({ organizationId: organizationId(), taskId: null, purpose: "skill-file", size: text.length });
    const read = await blobs.read(organizationIdSchema.parse(organizationId()), blobIdSchema.parse(stored.blobId));
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.value.bytes)).toBe(text);
    // Lines say who, what and how big, never the file's text.
    expect(JSON.stringify(records)).not.toContain("second line");
  });

  it("F-021: a file over a skill file's limit is refused as too large and nothing is stored", async () => {
    const before = await test.db.blob.count({ where: { organizationId: organizationId(), purpose: "skill-file" } });
    const answer = await uploader()({ organizationId: organizationId(), purpose: "skill-file", bytes: new Uint8Array(profileLimits.skillFileMaxBytes + 1) });
    expect(answer).toEqual({ kind: "too-large" });
    expect(await test.db.blob.count({ where: { organizationId: organizationId(), purpose: "skill-file" } })).toBe(before);
  });

  it("F-021: a token made under another key is refused, and so is a request with none", async () => {
    const before = await test.db.blob.count();
    expect(await uploader("f".repeat(64))({ organizationId: organizationId(), purpose: "skill-file", bytes: bytesOf("x") })).toEqual({ kind: "unavailable" });
    const bare = await fetch(`${harness.url}${PANEL_BLOB_PATH}`, { method: "POST", body: bytesOf("x") });
    expect(bare.status).toBe(401);
    expect(await test.db.blob.count()).toBe(before);
  });

  it("F-021: a token is good for the bytes it names and for nothing else, and an expired one for nothing", async () => {
    const tokens = createPanelBlobTokens(SECRET);
    const digest = (text: string) => sha256HexSchema.parse(createHash("sha256").update(text).digest("hex"));
    const issue = (over: { size?: number; sha256?: string; expiresAt?: number }) =>
      tokens.issue({ organizationId: organizationIdSchema.parse(organizationId()), purpose: "skill-file", size: 5, sha256: sha256HexSchema.parse(over.sha256 ?? digest("hello")), expiresAt: over.expiresAt ?? Date.now() + 60_000, ...(over.size === undefined ? {} : { size: over.size }) });
    const post = (token: string, body: string) => fetch(`${harness.url}${PANEL_BLOB_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
    const before = await test.db.blob.count();
    // Other bytes of the same size, shorter bytes, and a token past its deadline.
    expect((await post(issue({}), "HELLO")).status).toBe(400);
    expect((await post(issue({}), "hell")).status).toBe(400);
    expect((await post(issue({ expiresAt: Date.now() - 1 }), "hello")).status).toBe(401);
    // A token for a size over the purpose's cap, whatever the bytes.
    expect((await post(issue({ size: profileLimits.skillFileMaxBytes + 1 }), "hello")).status).toBe(413);
    expect(await test.db.blob.count()).toBe(before);
    // The matching bytes pass.
    expect((await post(issue({}), "hello")).status).toBe(200);
  });

  it("F-021: only POST reaches it, and other paths are left to the other routes", async () => {
    expect((await fetch(`${harness.url}${PANEL_BLOB_PATH}`)).status).toBe(404);
    expect((await fetch(`${harness.url}/panel/v1/other`, { method: "POST" })).status).toBe(404);
  });
});
