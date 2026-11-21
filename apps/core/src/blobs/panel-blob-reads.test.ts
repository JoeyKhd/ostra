import { randomBytes, randomUUID } from "node:crypto";

import { S3BlobStore } from "@ostra/adapter-blob-s3";
import { createFakeS3 } from "@ostra/adapter-blob-s3/testing";
import type { FakeS3 } from "@ostra/adapter-blob-s3/testing";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { coreBlobReader, corePanelUploader, serveCheckOutput, serveTaskAttachment } from "@ostra/api";
import type { Context } from "@ostra/api";
import { createApiHarness, pngBytes, seedAttachment, seedTask, SITE_URL, trpcFailure } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import type { SeededMember } from "@ostra/db/testing";
import { createPanelBlobReadTokens, libraryVersionFilesSchema, panelBlobReadPath, systemClock } from "@ostra/domain";
import type { PanelBlobReadClaims } from "@ostra/domain";
import { blobIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BlobId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { createBlobService } from "./blob-service.ts";
import type { BlobService } from "./blob-service.ts";
import { handlePanelBlobEndpoint } from "./panel-endpoints.ts";

// F-114 with F-054, F-121 and F-145: the panel's three blob reads on an install whose blob store is
// S3-compatible (a fake S3 server). The panel's side is the real one, `coreBlobReader` and
// `corePanelUploader` from `@ostra/api`, and core's is its real panel blob endpoint on a blob service
// with the S3 adapter, over HTTP. A check's full output, a task's screenshot and a library skill's
// file each read back whole, with the panel's own fixed type and headers; a member who may not see
// them is refused as before, and core refuses a read token for any other blob or owner.

const SECRET = randomBytes(32).toString("hex");
const MAX_BYTES = 4 * 1024 * 1024;
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});

let harness: ApiHarness;
let fake: FakeS3;
let store: S3BlobStore;
let blobs: BlobService;
let core: GatewayHarness;
let organizationId: OrganizationId;
let restrictedProjectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  restrictedProjectId = projectIdSchema.parse(harness.fixture.a.restrictedProject.id);
  fake = await createFakeS3();
  const s3 = { endpoint: fake.endpoint, bucket: fake.bucket, region: fake.region, accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey };
  store = new S3BlobStore({ ...s3, maxBytes: MAX_BYTES });
  blobs = createBlobService({ db: harness.test.db, settings: { kind: "s3", maxBytes: MAX_BYTES, ...s3 }, context: { logger, clock: systemClock }, s3: store });
  core = await startGateway(harness.test.db, harness.test.url, {}, () => [handlePanelBlobEndpoint({ blobs, secret: () => Promise.resolve(SECRET), clock: systemClock, logger })]);
}, 120_000);

afterAll(async () => {
  await core.stop();
  store.close();
  await fake.close();
  await harness.dispose();
});

/** A member's request as the web app builds it, with the panel's blob store reaching this core as `apps/web` wires it. */
const asPanel = (context: Context): Context => ({
  ...context,
  deps: {
    ...context.deps,
    blobStore: {
      ...context.deps.blobStore,
      name: "s3",
      read: coreBlobReader({ db: harness.test.db, coreUrl: core.url, secret: SECRET, logger: silentLogger }),
      upload: corePanelUploader({ coreUrl: core.url, secret: SECRET, logger: silentLogger }),
    },
  },
});

const contextOf = async (member: SeededMember): Promise<Context> => asPanel(await harness.contextOf(member));

/** A blob of a task, written by core's blob service into the bucket, stored with a type that would run as a page. */
const putTaskBlob = async (taskId: TaskId, purpose: string, bytes: Uint8Array): Promise<BlobId> => {
  const stored = await blobs.put({ organizationId, task: { projectId: restrictedProjectId, taskId } }, { purpose, contentType: "text/html", bytes });
  if (!stored.ok) throw new Error(`the blob was not stored: ${stored.message}`);
  return stored.value.blobId;
};

/** The blob's row says S3, and the built-in store holds none of its bytes. */
const expectInS3 = async (blobId: string): Promise<void> => {
  expect(await harness.test.db.blob.findUniqueOrThrow({ where: { id: blobId }, select: { store: true } })).toEqual({ store: "s3" });
  expect(await harness.test.db.blobChunk.count({ where: { blobId } })).toBe(0);
};

/** A failed check's run in A's restricted project, its full output in the bucket. */
const seedCheckOutput = async (text: string) => {
  const task = await seedTask(harness, { organizationId, projectId: restrictedProjectId, title: "S3 output" });
  const blobId = await putTaskBlob(task.taskId, "check-output", new TextEncoder().encode(text));
  const runId = randomUUID();
  await harness.test.db.checkRun.create({
    data: { id: runId, organizationId, projectId: restrictedProjectId, taskId: task.taskId, sessionId: task.sessionId, turnOrdinal: 1, checkId: randomUUID(), name: "lint", status: "failed", outputBlobId: blobId },
  });
  return { task, runId, blobId };
};

describe("the panel's blob reads on an S3-compatible store (F-114)", () => {
  it("F-054/c2: a check's full output kept in S3 is served whole, as plain text and an attachment, to members of the project and to no one else", async () => {
    const text = "line one\n<script>alert(1)</script>\n\u001b[31mred\u001b[0m\n";
    const { task, runId, blobId } = await seedCheckOutput(text);
    await expectInS3(blobId);

    const response = await serveCheckOutput(await contextOf(harness.fixture.a.insider), task.taskId, runId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="lint-turn-1.txt"');
    expect(response.headers.get("content-length")).toBe(String(text.length));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(text);

    // A member the restricted project doesn't list, another organization's admin, a signed-out request.
    expect((await serveCheckOutput(await contextOf(harness.fixture.a.member), task.taskId, runId)).status).toBe(404);
    expect((await serveCheckOutput(await contextOf(harness.fixture.b.admin), task.taskId, runId)).status).toBe(404);
    expect((await serveCheckOutput({ ...(await contextOf(harness.fixture.a.insider)), user: null, member: null }, task.taskId, runId)).status).toBe(401);
    // Lines carry IDs and sizes, never the output.
    expect(JSON.stringify(records)).not.toContain("alert(1)");
  });

  it("F-121/c4: a screenshot kept in S3 downloads as a PNG file whatever type it was stored with, never as a page, and only for those who can open the task", async () => {
    const task = await seedTask(harness, { organizationId, projectId: restrictedProjectId, title: "S3 screenshot" });
    const bytes = pngBytes(4096);
    const seeded = await seedAttachment(harness, { organizationId, projectId: restrictedProjectId, taskId: task.taskId }, { bytes });
    // The attachment's blob is the one core's blob service keeps in the bucket.
    const blobId = await putTaskBlob(task.taskId, "app-screenshot", bytes);
    await harness.test.db.taskAttachment.updateMany({ where: { attachmentId: seeded.attachmentId, taskId: task.taskId }, data: { blobId } });
    await expectInS3(blobId);

    const response = await serveTaskAttachment(await contextOf(harness.fixture.a.insider), task.taskId, seeded.attachmentId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="screenshot-${seeded.attachmentId}.png"`);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    expect((await serveTaskAttachment(await contextOf(harness.fixture.a.member), task.taskId, seeded.attachmentId)).status).toBe(404);
    expect((await serveTaskAttachment(await contextOf(harness.fixture.b.admin), task.taskId, seeded.attachmentId)).status).toBe(404);
    const other = await seedTask(harness, { organizationId, projectId: restrictedProjectId });
    expect((await serveTaskAttachment(await contextOf(harness.fixture.a.insider), other.taskId, seeded.attachmentId)).status).toBe(404);
  });

  it("F-145/c1: a library skill's file an admin installs goes to S3 through core and reads back as text, for the organization's admins only", async () => {
    const admin = harness.callerFor(await contextOf(harness.fixture.a.admin));
    const look = await admin.library.resolve({ reference: SITE_URL });
    if (look.resolved.kind !== "skills") throw new Error("the fake site lists no skills");
    const [skill] = look.resolved.skills;
    if (skill === undefined) throw new Error("the fake site lists no skills");
    const lookFile = await admin.library.lookFile({ reference: SITE_URL, folder: skill.folder, commit: null, computedHash: skill.computedHash, path: "SKILL.md" });
    const installed = await admin.library.install({ kind: "skill", reference: SITE_URL, folder: skill.folder, commit: null, computedHash: skill.computedHash, allowSource: true });
    const version = await harness.test.db.libraryItemVersion.findUniqueOrThrow({ where: { id: installed.versionId }, select: { files: true } });
    const blobIdOfSkill = libraryVersionFilesSchema.parse(version.files).find((file) => file.path === "SKILL.md")?.blobId;
    if (blobIdOfSkill === undefined) throw new Error("the version names no blob");
    await expectInS3(blobIdOfSkill);

    expect(await admin.library.file({ versionId: installed.versionId, path: "SKILL.md" })).toEqual(lookFile);

    // A member who isn't an admin, and another organization's admin.
    const member = harness.callerFor(await contextOf(harness.fixture.a.member));
    expect(await trpcFailure(member.library.file({ versionId: installed.versionId, path: "SKILL.md" }))).toMatchObject({ code: "FORBIDDEN" });
    const theirs = harness.callerFor(await contextOf(harness.fixture.b.admin));
    expect(await trpcFailure(theirs.library.file({ versionId: installed.versionId, path: "SKILL.md" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-054/c2: bytes in the store that aren't the blob's row never pass as whole, and a store that refuses is said so", async () => {
    const text = "the real output\n";
    const { task, runId, blobId } = await seedCheckOutput(text);
    const row = await harness.test.db.blob.findUniqueOrThrow({ where: { id: blobId }, select: { key: true } });
    const object = fake.objects.get(row.key);
    if (object === undefined) throw new Error("the bucket holds no object for the blob");
    // Same length, other bytes: the download stops short instead of ending as if whole.
    fake.objects.set(row.key, { ...object, body: new TextEncoder().encode("the fake output\n") });
    const tampered = await serveCheckOutput(await contextOf(harness.fixture.a.insider), task.taskId, runId);
    expect(tampered.status).toBe(200);
    await expect(tampered.text()).rejects.toThrow();
    fake.objects.set(row.key, object);

    fake.faults.push({ match: (request) => request.method === "GET" && request.key === row.key, action: { kind: "status", status: 403, code: "AccessDenied" } });
    const refused = await serveCheckOutput(await contextOf(harness.fixture.a.insider), task.taskId, runId);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await refused.text()).not.toContain(text);
    // The store answers again: so does the download.
    expect(await (await serveCheckOutput(await contextOf(harness.fixture.a.insider), task.taskId, runId)).text()).toBe(text);
  });

  it("F-114: core serves a blob only for the read token's own blob, organization and task, as bytes of no type of their own", async () => {
    const { task, blobId } = await seedCheckOutput("for core only\n");
    const otherTask = await seedTask(harness, { organizationId, projectId: restrictedProjectId });
    const tokens = createPanelBlobReadTokens(SECRET);
    const claims = (over: Partial<PanelBlobReadClaims> = {}): PanelBlobReadClaims => ({ organizationId, taskId: task.taskId, blobId, expiresAt: Date.now() + 30_000, ...over });
    const read = (token: string | null, id: string = blobId) =>
      fetch(`${core.url}${panelBlobReadPath(blobIdSchema.parse(id))}`, token === null ? {} : { headers: { authorization: `Bearer ${token}` } });

    const answer = await read(tokens.issue(claims()));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await answer.text()).toBe("for core only\n");

    // No token, another key's, an expired one, one longer-lived than the panel makes, and one for another blob.
    expect((await read(null)).status).toBe(401);
    expect((await read(createPanelBlobReadTokens("f".repeat(64)).issue(claims()))).status).toBe(401);
    expect((await read(tokens.issue(claims({ expiresAt: Date.now() - 1 })))).status).toBe(401);
    expect((await read(tokens.issue(claims({ expiresAt: Date.now() + 10 * 60_000 })))).status).toBe(401);
    expect((await read(tokens.issue(claims({ blobId: blobIdSchema.parse(randomUUID()) })))).status).toBe(401);
    // Another organization, another task, and the organization's own blobs with no task: not found.
    expect((await read(tokens.issue(claims({ organizationId: harness.fixture.b.organization.id })))).status).toBe(404);
    expect((await read(tokens.issue(claims({ taskId: otherTask.taskId })))).status).toBe(404);
    expect((await read(tokens.issue(claims({ taskId: null })))).status).toBe(404);
    // Only GET reads.
    expect((await fetch(`${core.url}${panelBlobReadPath(blobId)}`, { method: "POST", headers: { authorization: `Bearer ${tokens.issue(claims())}` } })).status).toBe(404);
  });
});
