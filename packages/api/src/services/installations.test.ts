import { randomUUID } from "node:crypto";

import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  connectExistingApp,
  installationAuditActions,
  installationUsable,
  linkInstallation,
  linkOwnInstallation,
  postgresAuditLog,
  removeInstallation,
  requiredRunnerMinor,
  unlinkInstallation,
} from "@ostra/domain";
import type { AuditLog, InstallationDeps, MemberScope } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { taskSpecFixture, taskSpecMinor2Fixture, taskSpecMinor3Fixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Linked installations and several Apps (milestone 4's ticket 46, ADR 0065), against Postgres:
// the rule every mint and listing asks, the owner's own installation linked when seen, an
// admin's link, unlink and removal, and connecting a client's App, each with its audit entry.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const admin = (): MemberScope => ({ organizationId: fixture.a.organization.id, memberId: fixture.a.admin.id, role: "admin", projectRoles: new Map() });
const deps = (audit: AuditLog = postgresAuditLog): InstallationDeps => ({ db: test.db, audit, clock: { now: () => 1_700_000_000_000 } });
const failingAfterAudit: AuditLog = {
  recordInTx: async (tx, entry) => {
    await postgresAuditLog.recordInTx(tx, entry);
    throw new Error("a later write in the same transaction failed");
  },
};
const auditCount = (action: string): Promise<number> => test.db.auditEntry.count({ where: { organizationId: fixture.a.organization.id, action } });
const rowOf = (connectionId: ConnectionId, installationId: string) =>
  test.db.codeHostInstallation.findUnique({ where: { connectionId_installationId: { connectionId, installationId } }, select: { state: true, removedAt: true, linkedByMemberId: true } });

const connectionFor = async (organizationId: string, ownerAccountId: string | null): Promise<ConnectionId> =>
  connectionIdSchema.parse(
    (await test.db.connection.create({ data: { organizationId, kind: "github", appId: `app-${randomUUID()}`, ownerLogin: "ostra-test", ownerAccountId } })).id,
  );

describe("linked installations", () => {
  it("F-136/c4: installationUsable is false for a removed or unknown installation", async () => {
    expect(installationUsable(null)).toBe(false);
    expect(installationUsable({ state: "removed", removedAt: new Date() })).toBe(false);
    expect(installationUsable({ state: "linked", removedAt: new Date() })).toBe(false);
    expect(installationUsable({ state: "linked", removedAt: null })).toBe(true);
    const connectionId = await connectionFor(fixture.a.organization.id, "100");
    expect(installationUsable(await rowOf(connectionId, "never-seen"))).toBe(false);
  });

  it("F-136/c4: links the App owner's own installation when seen, and leaves any other waiting", async () => {
    const connectionId = await connectionFor(fixture.a.organization.id, "100");
    const own = { installationId: "own-1", accountId: "100", accountLogin: "ostra-test", accountKind: "organization" } as const;
    const stranger = { installationId: "client-1", accountId: "200", accountLogin: "client-org", accountKind: "organization" } as const;
    const before = await auditCount(installationAuditActions.linked);
    expect(await linkOwnInstallation(deps(), { organizationId: fixture.a.organization.id, connectionId, installation: stranger })).toEqual({ ok: true, linked: false });
    expect(await rowOf(connectionId, "client-1")).toBeNull();
    expect(await linkOwnInstallation(deps(), { organizationId: fixture.a.organization.id, connectionId, installation: own })).toEqual({ ok: true, linked: true });
    expect(installationUsable(await rowOf(connectionId, "own-1"))).toBe(true);
    expect(await auditCount(installationAuditActions.linked)).toBe(before + 1);
    // Seen again, nothing more is written.
    await linkOwnInstallation(deps(), { organizationId: fixture.a.organization.id, connectionId, installation: own });
    expect(await auditCount(installationAuditActions.linked)).toBe(before + 1);
  });

  it("F-136: refuses linking another organization's installation", async () => {
    const theirs = await connectionFor(fixture.b.organization.id, "300");
    const result = await linkInstallation(deps(), admin(), { connectionId: theirs, installation: { installationId: "b-1", accountId: "300", accountLogin: "b-org", accountKind: "organization" } });
    expect(result).toMatchObject({ ok: false, error: "not-found" });
    expect(await rowOf(theirs, "b-1")).toBeNull();
    const member: MemberScope = { ...admin(), memberId: fixture.a.member.id, role: "member" };
    const ours = await connectionFor(fixture.a.organization.id, "100");
    expect(await linkInstallation(deps(), member, { connectionId: ours, installation: { installationId: "x", accountId: "1", accountLogin: "x", accountKind: "user" } })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("F-136/c5,c11: each use case writes its audit entry, and a rollback leaves none", async () => {
    const connectionId = await connectionFor(fixture.a.organization.id, "100");
    const client = { installationId: "client-2", accountId: "200", accountLogin: "client-org", accountKind: "organization" } as const;

    const linked = await auditCount(installationAuditActions.linked);
    await expect(linkInstallation(deps(failingAfterAudit), admin(), { connectionId, installation: client })).rejects.toThrow();
    expect(await rowOf(connectionId, "client-2")).toBeNull();
    expect(await auditCount(installationAuditActions.linked)).toBe(linked);
    expect(await linkInstallation(deps(), admin(), { connectionId, installation: client })).toEqual({ ok: true, linked: true });
    expect(await rowOf(connectionId, "client-2")).toMatchObject({ state: "linked", linkedByMemberId: fixture.a.admin.id });
    expect(await auditCount(installationAuditActions.linked)).toBe(linked + 1);

    const unlinked = await auditCount(installationAuditActions.unlinked);
    await expect(unlinkInstallation(deps(failingAfterAudit), admin(), { connectionId, installationId: "client-2" })).rejects.toThrow();
    expect(installationUsable(await rowOf(connectionId, "client-2"))).toBe(true);
    expect(await auditCount(installationAuditActions.unlinked)).toBe(unlinked);
    expect(await unlinkInstallation(deps(), admin(), { connectionId, installationId: "client-2" })).toEqual({ ok: true, at: 1_700_000_000_000 });
    expect(installationUsable(await rowOf(connectionId, "client-2"))).toBe(false);
    expect(await auditCount(installationAuditActions.unlinked)).toBe(unlinked + 1);

    // Removing uninstalls the App before the transaction commits; a failed uninstall leaves it linked.
    await linkInstallation(deps(), admin(), { connectionId, installation: { ...client, installationId: "client-3" } });
    const removed = await auditCount(installationAuditActions.removed);
    const uninstalled: string[] = [];
    await expect(
      removeInstallation({ ...deps(), uninstall: () => Promise.reject(new Error("GitHub refused")) }, admin(), { connectionId, installationId: "client-3" }),
    ).rejects.toThrow();
    expect(installationUsable(await rowOf(connectionId, "client-3"))).toBe(true);
    expect(await auditCount(installationAuditActions.removed)).toBe(removed);
    expect(
      await removeInstallation({ ...deps(), uninstall: (id) => Promise.resolve(void uninstalled.push(id)) }, admin(), { connectionId, installationId: "client-3" }),
    ).toMatchObject({ ok: true });
    expect(uninstalled).toEqual(["client-3"]);
    expect(installationUsable(await rowOf(connectionId, "client-3"))).toBe(false);
    expect(await auditCount(installationAuditActions.removed)).toBe(removed + 1);

    const added = await auditCount(installationAuditActions.connectionAdded);
    const app = {
      appId: `client-app-${randomUUID().slice(0, 6)}`,
      slug: "client-app",
      ownerLogin: "client-org",
      ownerAccountId: "200",
      botName: "client-app[bot]",
      botEmail: "9911+client-app[bot]@users.noreply.github.com",
      privateKeySecretRef: "ref-key",
      webhookSecretSecretRef: "ref-webhook",
    };
    await expect(connectExistingApp(deps(failingAfterAudit), admin(), app)).rejects.toThrow();
    expect(await test.db.connection.count({ where: { appId: app.appId } })).toBe(0);
    expect(await auditCount(installationAuditActions.connectionAdded)).toBe(added);
    const connected = await connectExistingApp(deps(), admin(), app);
    expect(connected.ok).toBe(true);
    expect(await auditCount(installationAuditActions.connectionAdded)).toBe(added + 1);
    expect(await connectExistingApp(deps(), admin(), app)).toMatchObject({ ok: false, error: "already-connected" });
  });

  it("F-136/c10: a task whose repos have different bots needs a minor-3 runner", () => {
    expect(requiredRunnerMinor(taskSpecMinor3Fixture)).toBe(3);
    expect(requiredRunnerMinor(taskSpecMinor2Fixture)).toBe(2);
    expect(requiredRunnerMinor(taskSpecFixture)).toBe(0);
  });
});
