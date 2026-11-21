import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { testPort } from "@ostra/adapter-sdk/testing/net";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { LOCAL_PREVIEW_DOMAIN, parseServerSettings, PREVIEW_CHECK_HEADER, PREVIEW_CHECK_PATH, previewCheckMark, previewDomainStatus, postgresAuditLog, systemClock } from "@ostra/domain";
import type { ServerSettings } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCore } from "../core.ts";
import type { RunningCore } from "../core.ts";
import { loadSecretsKey } from "../secrets.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { checkLocalPreviewDomain } from "./local-check.ts";

// A one-machine install's preview domain (F-144/c10; ADR 0068, the lead, 2026-11-21): with
// OSTRA_PREVIEW_DOMAIN unset and the panel and core on loopback, the whole of core, as `startCore`
// runs it, serves the preview hosts under `preview.localhost` and checks the domain at its start, as
// Instance › Previews' "Check again" would: kept for the install, by no one, and audited as the
// system. Core's public address is its own port here, as `pnpm dev` and `docker compose up` have it.

let test: TestDatabase;
let fixture: IsolationFixture;
let core: RunningCore;
let settings: ServerSettings;
let dataDir: string;
let port = 0;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-local-preview-"));
  port = await testPort();
  // Only what a one-machine install sets: no OSTRA_PREVIEW_DOMAIN.
  const parsed = parseServerSettings({
    DATABASE_URL: test.url,
    OSTRA_DATA_DIR: dataDir,
    OSTRA_CATALOG_FETCH: "false",
    OSTRA_CORE_PORT: String(port),
    OSTRA_CORE_PUBLIC_URL: `http://localhost:${String(port)}`,
  });
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  settings = parsed.settings;
  core = await startCore(settings, silentLogger, {
    host: "127.0.0.1",
    adapters: { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore(), modelProvider: new FakeModelProvider() },
  });
}, 60_000);

afterAll(async () => {
  await core.stop();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

/** A GET to core's port on loopback, with the browser's `Host`, as a `*.localhost` name reaches it. */
const getOn = (host: string, pathname: string): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: string }> =>
  new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path: pathname, headers: { host: `${host}:${String(port)}` } }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    call.on("error", reject);
    call.end();
  });

describe("a one-machine install's preview domain", () => {
  it("F-144/c10: with the setting unset and the panel and core on this machine, core serves the preview hosts under preview.localhost, and none of its own routes there", async () => {
    expect(settings.previews).toMatchObject({ domain: LOCAL_PREVIEW_DOMAIN, localDefault: true });
    // A preview host reaches core's preview proxy, which answers the check with this install's mark.
    const name = "ostra-check-0123456789ab.preview.localhost";
    const check = await getOn(name, PREVIEW_CHECK_PATH);
    expect(check.headers[PREVIEW_CHECK_HEADER]).toBe(previewCheckMark(await loadSecretsKey(settings), name));
    // Core's own routes never answer on one, `/healthz` included; on core's own host they do.
    const onPreview = await getOn(`5173-${"a".repeat(26)}.preview.localhost`, "/healthz");
    expect(onPreview.headers[PREVIEW_CHECK_HEADER]).toBeUndefined();
    expect(onPreview.body).not.toContain('"ok":true');
    const own = await getOn("localhost", "/healthz");
    expect(own).toMatchObject({ status: 200, body: '{"ok":true}' });
  });

  it("F-144/c10: core checks the default domain at its start: kept for the install as passed, by no one, and audited as the system in each organization", async () => {
    expect(await core.previewCheck).toEqual({ kind: "checked", passed: true });
    const status = await previewDomainStatus(test.db, LOCAL_PREVIEW_DOMAIN);
    expect(status).toMatchObject({ state: "checked", domain: LOCAL_PREVIEW_DOMAIN, passed: true, byName: null });
    if (status.state !== "checked") throw new Error("not checked");
    expect(status.check).toMatchObject({ dns: { state: "not-needed" }, certificate: { state: "not-needed" }, proxy: { state: "passed" }, upgrade: { state: "passed" } });
    const audited = await test.db.auditEntry.findMany({ where: { action: "instance.preview_domain_checked" }, select: { organizationId: true, actorKind: true, actorId: true, entityId: true, data: true } });
    const organizations = [fixture.a.organization.id, fixture.b.organization.id].sort();
    expect(audited.map((entry) => entry.organizationId).sort()).toEqual(organizations);
    for (const entry of audited) {
      expect(entry).toMatchObject({ actorKind: "system", actorId: null, entityId: entry.organizationId, data: { passed: true } });
    }
  });

  it("F-144/c10: it runs only for the default, on core's own port, and not again once it passed", async () => {
    const deps = { db: test.db, audit: postgresAuditLog, clock: systemClock, logger: silentLogger, secret: () => loadSecretsKey(settings) };
    const before = await test.db.auditEntry.count({ where: { action: "instance.preview_domain_checked" } });
    // A restart: the last result for the domain passed, so nothing runs.
    expect(await checkLocalPreviewDomain(deps, { previews: settings.previews, corePublicUrl: settings.corePublicUrl, port })).toEqual({ kind: "skipped", why: "passed-before" });
    // A domain an admin set stays theirs to check, `preview.localhost` included.
    expect(await checkLocalPreviewDomain(deps, { previews: { domain: LOCAL_PREVIEW_DOMAIN, localDefault: false }, corePublicUrl: settings.corePublicUrl, port })).toEqual({ kind: "skipped", why: "not-the-default" });
    expect(await checkLocalPreviewDomain(deps, { previews: { domain: null, localDefault: false }, corePublicUrl: settings.corePublicUrl, port })).toEqual({ kind: "skipped", why: "not-the-default" });
    // Core's public port isn't the one it listens on: another program may answer there, so it doesn't ask.
    expect(await checkLocalPreviewDomain(deps, { previews: settings.previews, corePublicUrl: "http://localhost:8787", port })).toEqual({ kind: "skipped", why: "another-port" });
    expect(await test.db.auditEntry.count({ where: { action: "instance.preview_domain_checked" } })).toBe(before);
  });
});
