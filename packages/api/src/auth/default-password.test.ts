import { isAPIError } from "better-auth/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { createContext } from "../trpc/context.ts";
import { PASSWORD_CHANGE_REQUIRED } from "../trpc/init.ts";
import { ensureFirstAdmin } from "./first-admin.ts";

// F-001's safety guard (the maintainer, 2026-11-19): the admin a fresh install seeds with the
// default password, demo, must choose a new one at its first sign-in. Until it has, every member
// procedure and every better-auth route but signing in, out and changing the password refuse it.
// OSTRA_ALLOW_DEFAULT_PASSWORD turns the forced change off (the panel's warning stays).

const defaultSettings = { firstAdmin: { email: "demo@demo.com", username: "demo", password: null, organizationName: "Demo" } } as const;

const seed = (harness: BareHarness) =>
  ensureFirstAdmin({ db: harness.test.db, settings: defaultSettings, hashPassword: harness.deps.hashPassword, ports: harness.deps.ports, logger: harness.deps.logger });

const signInAsDemo = async (harness: BareHarness, password = "demo") => {
  const { headers } = await harness.auth.api.signInEmail({ body: { email: "demo@demo.com", password }, returnHeaders: true });
  return cookieHeaderFrom(headers);
};

const callerWith = async (harness: BareHarness, cookie: Headers) =>
  harness.callerFor(await createContext(harness.deps, { headers: cookie, resHeaders: new Headers() }));

const refusalOf = async (call: () => Promise<unknown>): Promise<{ readonly code: string | undefined; readonly status: number }> => {
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

describe("the seeded admin with the default password", () => {
  let harness: BareHarness;

  beforeAll(async () => {
    harness = await createBareHarness();
    expect(await seed(harness)).not.toBeNull();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("F-001: the seeded default-password admin signs in, and is told to choose a new password", async () => {
    const caller = await callerWith(harness, await signInAsDemo(harness));
    expect(await caller.me.get()).toMatchObject({ username: "demo", instanceAdmin: true, passwordChange: "required" });
  });

  it("F-001: can do nothing else in the panel's API until it does", async () => {
    const caller = await callerWith(harness, await signInAsDemo(harness));
    await expect(caller.organization.get()).rejects.toMatchObject({ code: "FORBIDDEN", message: PASSWORD_CHANGE_REQUIRED });
    await expect(caller.setup.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.projects.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-001: can't reach better-auth's other routes either: no invitation, no organization, no device approval", async () => {
    const cookie = await signInAsDemo(harness);
    const organization = await harness.test.db.organization.findFirstOrThrow();
    expect(
      await refusalOf(() => harness.auth.api.createInvitation({ body: { email: "eve@example.com", role: "member", organizationId: organization.id }, headers: cookie })),
    ).toEqual({ code: "PASSWORD_CHANGE_REQUIRED", status: 403 });
    expect(await refusalOf(() => harness.auth.api.createOrganization({ body: { name: "Other", slug: "other" }, headers: cookie }))).toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    expect(await refusalOf(() => harness.auth.api.deviceApprove({ body: { userCode: "ABCDEFGH" }, headers: cookie }))).toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    // Nor its own account: no new name or username, and no ending its other sessions.
    expect(await refusalOf(() => harness.auth.api.updateUser({ body: { name: "Someone else" }, headers: cookie }))).toEqual({
      code: "PASSWORD_CHANGE_REQUIRED",
      status: 403,
    });
    expect(await refusalOf(() => harness.auth.api.updateUser({ body: { username: "someone-else" }, headers: cookie }))).toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    expect(await refusalOf(() => harness.auth.api.revokeOtherSessions({ headers: cookie }))).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    expect(await harness.test.db.user.findFirstOrThrow()).toMatchObject({ username: "demo", mustChangePassword: true });
    // Reading its own session still works: that's how the panel knows to ask.
    expect((await harness.auth.api.getSession({ headers: cookie }))?.user.mustChangePassword).toBe(true);
  });

  it("F-001: can't set the flag itself, nor clear it by updating its profile", async () => {
    const cookie = await signInAsDemo(harness);
    await expect(
      // @ts-expect-error -- `mustChangePassword` is `input: false`: the types leave it out, the route ignores or refuses it.
      harness.auth.api.updateUser({ body: { mustChangePassword: false }, headers: cookie }),
    ).rejects.toThrow();
    expect((await harness.test.db.user.findFirstOrThrow()).mustChangePassword).toBe(true);
  });

  it("F-001: must choose a password that meets the normal policy", async () => {
    const cookie = await signInAsDemo(harness);
    for (const newPassword of ["demo", "short-pass1"]) {
      expect(await refusalOf(() => harness.auth.api.changePassword({ body: { currentPassword: "demo", newPassword }, headers: cookie }))).toMatchObject({
        code: "PASSWORD_TOO_SHORT",
      });
    }
    expect(await refusalOf(() => harness.auth.api.changePassword({ body: { currentPassword: "not-the-password", newPassword: TEST_PASSWORD }, headers: cookie }))).toMatchObject({
      code: "INVALID_PASSWORD",
    });
    expect((await harness.test.db.user.findFirstOrThrow()).mustChangePassword).toBe(true);
  });

  it("F-001: changing it clears the flag, signs out the other sessions, and opens the panel", async () => {
    const other = await signInAsDemo(harness);
    const cookie = await signInAsDemo(harness);
    const { headers } = await harness.auth.api.changePassword({
      body: { currentPassword: "demo", newPassword: TEST_PASSWORD, revokeOtherSessions: true },
      headers: cookie,
      returnHeaders: true,
    });
    expect((await harness.test.db.user.findFirstOrThrow()).mustChangePassword).toBe(false);
    expect(await harness.auth.api.getSession({ headers: other })).toBeNull();

    const caller = await callerWith(harness, cookieHeaderFrom(headers));
    expect(await caller.me.get()).toMatchObject({ passwordChange: "none" });
    expect(await caller.organization.get()).toMatchObject({ name: "Demo", role: "admin" });
    // The default password is gone.
    await expect(signInAsDemo(harness)).rejects.toThrow();
    expect(await signInAsDemo(harness, TEST_PASSWORD)).toBeInstanceOf(Headers);
  });

  it("F-001: is never seeded again, whatever the settings say now", async () => {
    expect(await seed(harness)).toBeNull();
    expect(await harness.test.db.user.count()).toBe(1);
    expect((await harness.test.db.user.findFirstOrThrow()).mustChangePassword).toBe(false);
  });
});

describe("with OSTRA_ALLOW_DEFAULT_PASSWORD", () => {
  let harness: BareHarness;

  beforeAll(async () => {
    harness = await createBareHarness({ allowDefaultPassword: true });
    await seed(harness);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it("F-001: OSTRA_ALLOW_DEFAULT_PASSWORD forces no change, but still says the password is the default one (the panel's warning)", async () => {
    const cookie = await signInAsDemo(harness);
    const caller = await callerWith(harness, cookie);
    expect(await caller.me.get()).toMatchObject({ passwordChange: "suggested" });
    expect(await caller.organization.get()).toMatchObject({ name: "Demo" });
    const organization = await harness.test.db.organization.findFirstOrThrow();
    const invitation = await harness.auth.api.createInvitation({ body: { email: "bob@example.com", role: "member", organizationId: organization.id }, headers: cookie });
    expect(invitation.role).toBe("member");
  });

  it("F-001: OSTRA_ALLOW_DEFAULT_PASSWORD drops the warning once the password changes", async () => {
    const cookie = await signInAsDemo(harness);
    await harness.auth.api.changePassword({ body: { currentPassword: "demo", newPassword: TEST_PASSWORD }, headers: cookie });
    const caller = await callerWith(harness, await signInAsDemo(harness, TEST_PASSWORD));
    expect(await caller.me.get()).toMatchObject({ passwordChange: "none" });
  });
});
