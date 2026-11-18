import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAPIError } from "better-auth/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { RUNNER_CLIENT_ID } from "./create-auth.ts";
import { resolveSession } from "./scope.ts";

// The contract between ostra and better-auth (ADR 0003): what the server relies on, written as
// tests, so an upgrade, which can break in a minor version, shows up here first. It is the upgrade
// gate: a better-auth upgrade doesn't merge until this file is green.

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

let harness: BareHarness;

beforeAll(async () => {
  harness = await createBareHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const firstAdmin = {
  username: "ada",
  email: "ada@example.com",
  password: TEST_PASSWORD,
  organizationName: "Calculator Co",
} as const;

const refusedWith = async (call: () => Promise<unknown>): Promise<{ readonly code: string | undefined; readonly status: number }> => {
  try {
    await call();
  } catch (error) {
    if (isAPIError(error)) {
      const code: unknown = Reflect.get(error.body ?? {}, "code");
      return { code: typeof code === "string" ? code : undefined, status: error.statusCode };
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
};

describe("the pinned version", () => {
  it("is exact, and is the one installed", async () => {
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")));
    const declared = manifest.dependencies["better-auth"];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = z
      .object({ version: z.string() })
      .parse(JSON.parse(await readFile(path.join(packageRoot, "node_modules/better-auth/package.json"), "utf8")));
    expect(installed.version).toBe(declared);
  });
});

describe("the first account", () => {
  it("is asked for by an install with no account", async () => {
    expect(await harness.anonymous().setup.state()).toEqual({ needsFirstAdmin: true, openSignup: false });
  });

  it("is refused without the right setup token, and creates nothing", async () => {
    const caller = harness.anonymous();
    await expect(
      caller.setup.createFirstAdmin({ ...firstAdmin, setupToken: "ostra-setup-not-the-token-at-all" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.user.count()).toBe(0);
    expect(await harness.test.db.organization.count()).toBe(0);
  });

  it("refuses a short password and a bad username before anything happens", async () => {
    const caller = harness.anonymous();
    const base = { ...firstAdmin, setupToken: harness.setupToken };
    await expect(caller.setup.createFirstAdmin({ ...base, password: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.setup.createFirstAdmin({ ...base, username: "Not Valid!" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.user.count()).toBe(0);
  });

  it("closes sign-up at the better-auth route, before and after the first admin", async () => {
    const refusal = await refusedWith(() =>
      harness.auth.api.signUpEmail({
        body: { name: "mallory", email: "mallory@example.com", password: TEST_PASSWORD, username: "mallory" },
        // Even holding the setup token: the first admin comes from the first-run page, whole.
        headers: new Headers({ "x-ostra-setup-token": harness.setupToken }),
      }),
    );
    expect(refusal).toMatchObject({ code: "SIGN_UP_CLOSED", status: 403 });
    expect(await harness.test.db.user.count()).toBe(0);
  });

  it("creates the instance admin and the first organization, and signs the admin in", async () => {
    const resHeaders = new Headers();
    const created = await harness.anonymous(resHeaders).setup.createFirstAdmin({ ...firstAdmin, setupToken: harness.setupToken });

    const cookie = cookieHeaderFrom(resHeaders);
    expect(cookie.get("cookie")).toContain("better-auth.session_token=");
    const session = await resolveSession(harness.auth, cookie);
    expect(session).toMatchObject({ userId: created.userId, username: "ada", instanceAdmin: true, sessionOrganizationId: created.organizationId });

    const organization = await harness.test.db.organization.findUniqueOrThrow({ where: { id: created.organizationId } });
    expect(organization.name).toBe("Calculator Co");
    const member = await harness.test.db.member.findFirstOrThrow({ where: { userId: created.userId } });
    expect(member).toMatchObject({ organizationId: created.organizationId, role: "admin" });
    const setting = await harness.test.db.instanceSetting.findUniqueOrThrow({ where: { id: "instance" } });
    expect(setting.firstAdminCreatedAt).not.toBeNull();
    // The organization has its built-in OpenCode profile, with no model until the admin picks one.
    expect(await harness.test.db.agentProfile.findMany({ where: { organizationId: created.organizationId } })).toMatchObject([
      { name: "OpenCode", adapter: "opencode", builtIn: true, modelId: null },
    ]);
    const audit = await harness.test.db.auditEntry.findFirst({ where: { organizationId: created.organizationId, action: "instance.first-admin-created" } });
    expect(audit).not.toBeNull();
  });

  it("signs in by username and by email, and the session has the role", async () => {
    for (const attempt of ["username", "email"] as const) {
      const { headers, response } =
        attempt === "username"
          ? await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true })
          : await harness.auth.api.signInEmail({ body: { email: "ada@example.com", password: TEST_PASSWORD }, returnHeaders: true });
      expect(response.user.email).toBe("ada@example.com");
      const session = await resolveSession(harness.auth, cookieHeaderFrom(headers));
      expect(session?.instanceAdmin).toBe(true);
    }
  });

  it("is refused a second time, and the token is dead after use", async () => {
    await expect(
      harness.anonymous().setup.createFirstAdmin({
        ...firstAdmin,
        username: "grace",
        email: "grace@example.com",
        setupToken: harness.setupToken,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.user.count()).toBe(1);
    expect(await harness.anonymous().setup.state()).toEqual({ needsFirstAdmin: false, openSignup: false });
    const refusal = await refusedWith(() =>
      harness.auth.api.signUpEmail({
        body: { name: "latecomer", email: "late@example.com", password: TEST_PASSWORD, username: "latecomer" },
      }),
    );
    expect(refusal.code).toBe("SIGN_UP_CLOSED");
  });
});

describe("a device sign-in for a personal runner (RFC 8628)", () => {
  it("ends with a bearer session in the approving member's organization", async () => {
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const browser = cookieHeaderFrom(headers);

    // Another client ID is refused.
    const wrongClient = await refusedWith(() => harness.auth.api.deviceCode({ body: { client_id: "something-else", scope: "runner" } }));
    expect(wrongClient.status).toBe(400);

    const issued = await harness.auth.api.deviceCode({ body: { client_id: RUNNER_CLIENT_ID, scope: "runner" } });
    expect(issued.user_code.length).toBeGreaterThanOrEqual(8);

    // The member opens the verification link signed in (it claims the code), and approves it.
    await harness.auth.api.deviceVerify({ query: { user_code: issued.user_code }, headers: browser });
    await harness.auth.api.deviceApprove({ body: { userCode: issued.user_code }, headers: browser });

    const granted = await harness.auth.api.deviceToken({
      body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: issued.device_code, client_id: RUNNER_CLIENT_ID },
    });
    const bearer = new Headers({ authorization: `Bearer ${granted.access_token}` });
    const session = await resolveSession(harness.auth, bearer);
    expect(session).toMatchObject({ username: "ada", instanceAdmin: true });
    // The session starts in the member's organization, which a runner's registration records (ADR 0029).
    const organization = await harness.test.db.organization.findFirstOrThrow();
    expect(session?.sessionOrganizationId).toBe(organization.id);
  });
});

describe("the organization roles (ADR 0026)", () => {
  it("gives an organization an instance admin makes later its built-in profile too", async () => {
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const created = await harness.auth.api.createOrganization({ body: { name: "Second Org", slug: "second-org" }, headers: cookieHeaderFrom(headers) });
    expect(await harness.test.db.agentProfile.count({ where: { organizationId: created.id, builtIn: true } })).toBe(1);
  });

  it("accept admin and member, and refuse owner", async () => {
    const { headers } = await harness.auth.api.signInUsername({ body: { username: "ada", password: TEST_PASSWORD }, returnHeaders: true });
    const browser = cookieHeaderFrom(headers);
    const organization = await harness.test.db.organization.findFirstOrThrow();
    const refusal = await refusedWith(() =>
      harness.auth.api.createInvitation({
        // @ts-expect-error -- the types exclude "owner" (ostra registers two roles); the hook is the runtime guard.
        body: { email: "bob@example.com", role: "owner", organizationId: organization.id },
        headers: browser,
      }),
    );
    expect(refusal.code).toBe("ROLE_NOT_FOUND");
    const invitation = await harness.auth.api.createInvitation({
      body: { email: "bob@example.com", role: "member", organizationId: organization.id },
      headers: browser,
    });
    expect(invitation.role).toBe("member");
  });
});
