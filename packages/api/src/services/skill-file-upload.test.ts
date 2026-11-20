import { createHash, randomBytes } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createPanelBlobTokens, PANEL_BLOB_PATH, PANEL_BLOB_TOKEN_PREFIX } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { corePanelUploader } from "./panel-blobs.ts";
import { serveSkillFileUpload } from "./skill-file-upload.ts";

// F-021, ticket 42: a skill's file, from the profile editor to core's blob service. The route's
// service checks who sends it and how big it is; the uploader makes the token core checks. Core's own
// endpoint is proved against the real uploader in `apps/core/src/blobs/panel-endpoints.test.ts`.

let harness: ApiHarness;
const MIB = 1024 * 1024;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const post = (body: string | Uint8Array | null, headers: Record<string, string> = { "content-type": "application/octet-stream" }): Request =>
  new Request("http://panel.test/api/agent-profiles/skill-files", { method: "POST", headers, body });

describe("a skill's file, uploaded from the profile editor", () => {
  it("F-021/c1: an organization admin's file is stored for the organization as a skill file, and the answer names its blob", async () => {
    const before = harness.uploads.length;
    const response = await serveSkillFileUpload(await harness.contextOf(harness.fixture.a.admin), post("2026-11-19: example line\n"));
    expect(response.status).toBe(200);
    const answer: unknown = await response.json();
    expect(answer).toMatchObject({ size: 25 });
    expect(harness.uploads).toHaveLength(before + 1);
    expect(harness.uploads.at(-1)).toMatchObject({ organizationId: harness.fixture.a.organization.id, purpose: "skill-file", size: 25 });
  });

  it("F-021/c1: a member who is not an admin, another organization's member and a stranger store nothing", async () => {
    const before = harness.uploads.length;
    expect((await serveSkillFileUpload(await harness.contextOf(harness.fixture.a.member), post("x"))).status).toBe(403);
    expect((await serveSkillFileUpload(await harness.contextOf(harness.fixture.a.insider), post("x"))).status).toBe(403);
    const stranger = { ...(await harness.contextOf(harness.fixture.a.admin)), user: null, member: null };
    expect((await serveSkillFileUpload(stranger, post("x"))).status).toBe(401);
    expect(harness.uploads).toHaveLength(before);
  });

  it("F-021/c1: a file over 1 MiB is refused whether it declares its size or streams past the limit, and an empty one is refused", async () => {
    const admin = await harness.contextOf(harness.fixture.a.admin);
    const before = harness.uploads.length;
    // Declared: the header alone refuses it before a byte is read.
    const declared = post("x", { "content-type": "application/octet-stream", "content-length": String(MIB + 1) });
    expect((await serveSkillFileUpload(admin, declared)).status).toBe(413);
    // Streamed with no length: the reader stops at the cap.
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (sent > 100 * chunk.length) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const streamed = new Request("http://panel.test/api/agent-profiles/skill-files", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: stream, duplex: "half" });
    expect((await serveSkillFileUpload(admin, streamed)).status).toBe(413);
    expect(sent).toBeLessThan(MIB + 3 * chunk.length);
    expect((await serveSkillFileUpload(admin, post(new Uint8Array()))).status).toBe(400);
    // Exactly 1 MiB is a file.
    expect((await serveSkillFileUpload(admin, post(new Uint8Array(MIB)))).status).toBe(200);
    expect(harness.uploads).toHaveLength(before + 1);
  });

  it("F-021: only application/octet-stream is taken, so a form on another site cannot send it with a member's cookie", async () => {
    const admin = await harness.contextOf(harness.fixture.a.admin);
    const before = harness.uploads.length;
    for (const type of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "application/json"]) {
      expect((await serveSkillFileUpload(admin, post("x", { "content-type": type }))).status).toBe(415);
    }
    expect((await serveSkillFileUpload(admin, post("x", {}))).status).toBe(415);
    expect(harness.uploads).toHaveLength(before);
  });

  it("F-021: when core does not take the file the member is told to try again, and no log line holds the file's text", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger((record) => {
      records.push(record);
    });
    const context = await harness.contextOf(harness.fixture.a.admin);
    const refusing = {
      ...context,
      deps: { ...context.deps, blobStore: { ...context.deps.blobStore, upload: corePanelUploader({ coreUrl: "http://core.invalid", secret: "c".repeat(64), logger, fetch: () => Promise.reject(new Error("connection refused: the-secret-text")) }) } },
    };
    const response = await serveSkillFileUpload(refusing, post("the-secret-text"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(records)).not.toContain("the-secret-text");
  });
});

describe("the panel's uploader", () => {
  const organizationId = (): string => harness.fixture.a.organization.id;
  const secret = randomBytes(32).toString("hex");

  it("F-021: sends the bytes to core with a token that is good for those bytes, that organization and a minute", async () => {
    const bytes = new TextEncoder().encode("hello skill");
    let seen: { url: string; auth: string; body: Uint8Array } | undefined;
    const upload = corePanelUploader({
      coreUrl: "http://core.test",
      secret,
      logger: silentLogger,
      now: () => 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen = { url: request.url, auth: request.headers.get("authorization") ?? "", body: new Uint8Array(await request.arrayBuffer()) };
        return Response.json({ blobId: "01900000-0000-7000-8000-0000000000ee", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      },
    });
    const answer = await upload({ organizationId: organizationId(), purpose: "skill-file", bytes });
    expect(answer).toEqual({ kind: "stored", blobId: "01900000-0000-7000-8000-0000000000ee", size: bytes.length });
    expect(seen?.url).toBe(`http://core.test${PANEL_BLOB_PATH}`);
    expect(seen?.body).toEqual(bytes);
    const token = (seen?.auth ?? "").replace("Bearer ", "");
    expect(token.startsWith(PANEL_BLOB_TOKEN_PREFIX)).toBe(true);
    expect(createPanelBlobTokens(secret).verify(token, 1_000)).toMatchObject({ organizationId: organizationId(), purpose: "skill-file", size: bytes.length, expiresAt: 61_000 });
    expect(createPanelBlobTokens(secret).verify(token, 61_000)).toBeNull();
  });

  it("F-021/c1: a core that answers another digest, an error or nothing is unavailable, and a 413 is too large", async () => {
    const bytes = new TextEncoder().encode("hello skill");
    const asking = (respond: () => Promise<Response>) => corePanelUploader({ coreUrl: "http://core.test", secret, logger: silentLogger, fetch: respond })({ organizationId: organizationId(), purpose: "skill-file", bytes });
    expect(await asking(() => Promise.resolve(Response.json({ blobId: "01900000-0000-7000-8000-0000000000ee", size: 11, sha256: "0".repeat(64) })))).toEqual({ kind: "unavailable" });
    expect(await asking(() => Promise.resolve(new Response("nope", { status: 500 })))).toEqual({ kind: "unavailable" });
    expect(await asking(() => Promise.reject(new Error("down")))).toEqual({ kind: "unavailable" });
    expect(await asking(() => Promise.resolve(Response.json({ error: { code: "too-large" } }, { status: 413 })))).toEqual({ kind: "too-large" });
  });
});
