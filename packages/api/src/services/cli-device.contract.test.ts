import { randomUUID } from "node:crypto";

import { cliDeviceResponseSchema, cliDeviceTokenErrorSchema, cliDeviceTokenResponseSchema, cliPaths } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureFirstAdmin } from "../auth/first-admin.ts";
import { cookieHeaderFrom, createBareHarness, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { CLI_CLIENT_ID, handleCliRequest } from "./cli-http.ts";

// F-103, ticket 39: `ostra login`'s device-code grant, approved the way the panel's `/device` page
// approves it: by a signed-in member, through better-auth's own verify and approve calls. The grant
// the CLI starts here is the one the page opens (it names the CLI's client), the approval is the
// member's, and the CLI session that comes out acts as that member.

let harness: BareHarness;

beforeAll(async () => {
  harness = await createBareHarness();
  await ensureFirstAdmin({
    db: harness.test.db,
    settings: { firstAdmin: { username: "ada", email: "ada@example.com", password: TEST_PASSWORD, organizationName: "Calculator Co" } },
    hashPassword: harness.deps.hashPassword,
    ports: harness.deps.ports,
    logger: harness.deps.logger,
  });
});

afterAll(async () => {
  await harness.dispose();
});

const post = (path: string, body: unknown) =>
  handleCliRequest(harness.deps, new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("a device sign-in for the CLI (RFC 8628)", () => {
  it("F-103: the member approves the code in the browser, and the CLI's poll then gets a session that acts as that member", async () => {
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const browser = cookieHeaderFrom(headers);

    const grant = cliDeviceResponseSchema.parse(await (await post(cliPaths.device, { name: "ada-laptop", version: "0.3.0" })).json());
    // The device page opens the code signed in: that claims it, and says whose client asked (the purpose).
    const verified = await harness.auth.api.deviceVerify({ query: { user_code: grant.userCode }, headers: browser });
    expect(verified).toMatchObject({ status: "pending", client_id: CLI_CLIENT_ID });
    // The member, who sees the machine's name on the page, has not approved yet: the poll waits.
    const waiting = await post(cliPaths.deviceToken, { deviceCode: grant.deviceCode });
    expect(cliDeviceTokenErrorSchema.parse(await waiting.json()).error.code).toBe("authorization-pending");

    await harness.auth.api.deviceApprove({ body: { userCode: grant.userCode }, headers: browser });
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: grant.deviceCode }, data: { lastPolledAt: new Date(Date.now() - 60_000) } });
    const granted = await post(cliPaths.deviceToken, { deviceCode: grant.deviceCode });
    expect(granted.status).toBe(200);
    const session = cliDeviceTokenResponseSchema.parse(await granted.json());
    expect(session.username).toBe("ada");
    const stored = await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: session.sessionId } });
    const member = await harness.test.db.member.findFirstOrThrow({ where: { user: { username: "ada" } } });
    expect(stored).toMatchObject({ memberId: member.id, userId: member.userId, name: "ada-laptop" });
    // It is not a login: the bearer is no better-auth session.
    expect(await harness.test.db.authSession.count({ where: { token: session.token } })).toBe(0);
  });

  it("F-103: a code the member denies ends the poll in a refusal, and no session is made", async () => {
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const browser = cookieHeaderFrom(headers);
    const before = await harness.test.db.cliSession.count();
    const grant = cliDeviceResponseSchema.parse(await (await post(cliPaths.device, { name: "other-laptop", version: "0.3.0" })).json());
    await harness.auth.api.deviceVerify({ query: { user_code: grant.userCode }, headers: browser });
    await harness.auth.api.deviceDeny({ body: { userCode: grant.userCode }, headers: browser });
    const polled = await post(cliPaths.deviceToken, { deviceCode: grant.deviceCode });
    expect(cliDeviceTokenErrorSchema.parse(await polled.json()).error.code).toBe("access-denied");
    expect(await harness.test.db.cliSession.count()).toBe(before);
  });

  it("F-103: the code approved while signed into a second organization makes a session of that organization", async () => {
    const ada = await harness.test.db.user.findFirstOrThrow({ where: { username: "ada" } });
    const second = await harness.test.db.organization.create({ data: { id: randomUUID(), name: "Second Co", slug: `second-${randomUUID().slice(0, 8)}`, createdAt: new Date() } });
    const secondMember = await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: second.id, userId: ada.id, role: "member", createdAt: new Date() } });
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const browser = cookieHeaderFrom(headers);
    // The login session starts in the oldest organization; the approver then switches to the second one.
    await harness.auth.api.setActiveOrganization({ body: { organizationId: second.id }, headers: browser });

    const grant = cliDeviceResponseSchema.parse(await (await post(cliPaths.device, { name: "ada-second", version: "0.3.0" })).json());
    await harness.auth.api.deviceVerify({ query: { user_code: grant.userCode }, headers: browser });
    await harness.auth.api.deviceApprove({ body: { userCode: grant.userCode }, headers: browser });
    expect((await harness.test.db.deviceCode.findFirstOrThrow({ where: { deviceCode: grant.deviceCode } })).organizationId).toBe(second.id);
    await harness.test.db.deviceCode.updateMany({ where: { deviceCode: grant.deviceCode }, data: { lastPolledAt: new Date(Date.now() - 60_000) } });
    const session = cliDeviceTokenResponseSchema.parse(await (await post(cliPaths.deviceToken, { deviceCode: grant.deviceCode })).json());
    expect(await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: session.sessionId } })).toMatchObject({ memberId: secondMember.id, organizationId: second.id });
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "cli-session.started", entityId: secondMember.id } });
    expect(entry.organizationId).toBe(second.id);
  });
});
