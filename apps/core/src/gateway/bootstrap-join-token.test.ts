import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { memoryJobQueue } from "@ostra/api/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, revokeJoinToken, systemClock } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { joinTokenIdSchema, memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_JOIN_TOKEN_FILE, ensureBootstrapJoinToken, hashJoinToken } from "./bootstrap-join-token.ts";

// The bootstrap join token is made once (F-091, F-013): an admin's revoke holds across core
// restarts, and making or replacing one is the system's audit entry.

let test: TestDatabase;
let fixture: IsolationFixture;
let dataDir: string;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-bootstrap-"));
  await test.db.joinToken.deleteMany({ where: { bootstrap: true } });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const admin = (): MemberScope => ({
  organizationId: organizationIdSchema.parse(fixture.a.admin.organizationId),
  memberId: memberIdSchema.parse(fixture.a.admin.id),
  role: "admin",
  projectRoles: new Map(),
});

const deps = () => ({ db: test.db, jobs: memoryJobQueue(), audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock });

const bootstrapRows = () => test.db.joinToken.findMany({ where: { bootstrap: true }, orderBy: { createdAt: "asc" } });

describe("the bootstrap join token", () => {
  it("F-091/c4: a bootstrap token an admin revokes stays revoked: core's next start makes no other and writes nothing", async () => {
    expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("created");
    const [made] = await bootstrapRows();
    expect(made).toBeDefined();
    if (made === undefined) {
      return;
    }
    const created = await test.db.auditEntry.findMany({ where: { action: "join-token.created", entityId: made.id } });
    expect(created).toMatchObject([{ actorKind: "system", actorId: null, organizationId: fixture.a.organization.id }]);

    expect(await revokeJoinToken(deps(), admin(), { joinTokenId: joinTokenIdSchema.parse(made.id) })).toMatchObject({ ok: true });
    const auditBefore = await test.db.auditEntry.count();

    // Core starts again, with the file still there, and then with the data folder gone (a new replica's emptyDir).
    expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("ready");
    await rm(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), { force: true });
    expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("ready");

    const rows = await bootstrapRows();
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.revokedAt === null)).toEqual([]);
    expect(await test.db.auditEntry.count()).toBe(auditBefore);
    await expect(readFile(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), "utf8")).rejects.toThrow();
  });

  it("F-091/c4: a live bootstrap token whose file no longer matches is replaced, the old one revoked, both audited as the system's", async () => {
    expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("created");
    await writeFile(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), "ostra-join-restored-from-an-old-backup");
    expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("created");

    const [old, current] = await bootstrapRows();
    expect(old?.revokedAt).not.toBeNull();
    expect(current?.revokedAt).toBeNull();
    const token = (await readFile(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), "utf8")).trim();
    expect(current?.tokenHash).toBe(hashJoinToken(token));
    expect(await test.db.auditEntry.count({ where: { action: "join-token.revoked", entityId: old?.id ?? "", actorKind: "system" } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { action: "join-token.created", entityId: current?.id ?? "", actorKind: "system" } })).toBe(1);
  });
});
