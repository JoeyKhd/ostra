import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureFirstAdmin } from "../auth/first-admin.ts";
import { createApiHarness, createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { createContext } from "../trpc/context.ts";

// F-082 (milestone 7, ticket 11): a member's theme. `account.setTheme` saves the member's own
// choice on their account, sets the cookie the panel reads before first paint, and is in the
// session's payload; nobody can set another member's.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("account.setTheme", () => {
  it("F-082/c2: setTheme saves the choice and sets the cookie; another member's theme is untouched", async () => {
    const { member, insider } = harness.fixture.a;
    const context = await harness.contextOf(member);
    const caller = harness.callerFor(context);
    // A new member's theme is dark, in the session's payload too.
    expect((await caller.me.get()).theme).toBe("dark");
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: insider.userId } })).theme).toBe("dark");

    expect(await caller.account.setTheme({ theme: "light" })).toEqual({ theme: "light", changed: true });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: member.userId } })).theme).toBe("light");
    const cookie = context.resHeaders.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ostra-theme=light; Path=\/; Max-Age=31536000; SameSite=Lax; HttpOnly/);
    // The next request's session carries it.
    expect((await (await harness.as(member)).me.get()).theme).toBe("light");
    // The change is in the audit log, from and to.
    const entry = await harness.test.db.auditEntry.findFirst({ where: { action: "account.theme_changed", entityId: member.userId } });
    expect(entry?.data).toEqual({ from: "dark", to: "light" });

    // "Match my system", and the same choice again changes nothing and writes no second entry.
    expect(await caller.account.setTheme({ theme: "system" })).toEqual({ theme: "system", changed: true });
    expect(await caller.account.setTheme({ theme: "system" })).toEqual({ theme: "system", changed: false });
    expect(await harness.test.db.auditEntry.count({ where: { action: "account.theme_changed", entityId: member.userId } })).toBe(2);

    // Only the caller's own: the other member's account is as it was.
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: insider.userId } })).theme).toBe("dark");
  });

  it("F-082/c2: refuses a theme other than the three, and any way of naming another account", async () => {
    const { member, insider } = harness.fixture.a;
    const caller = await harness.as(member);
    // @ts-expect-error: a theme the type refuses, sent as any client could send it
    await expect(caller.account.setTheme({ theme: "sepia" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // @ts-expect-error: a field the input doesn't have, naming another account
    await expect(caller.account.setTheme({ theme: "dark", userId: insider.userId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: insider.userId } })).theme).toBe("dark");
    // Signed out, nothing is saved.
    await expect(harness.anonymous().account.setTheme({ theme: "light" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("the theme in the session's payload", () => {
  it("F-082/c1: a signed-in session carries the saved theme through better-auth, which no profile update can set", async () => {
    const bare = await createBareHarness();
    try {
      const seeded = await ensureFirstAdmin({
        db: bare.test.db,
        settings: { firstAdmin: { email: "ada@example.com", username: "ada", password: TEST_PASSWORD, organizationName: "Calculator Co" } },
        hashPassword: bare.deps.hashPassword,
        ports: bare.deps.ports,
        logger: bare.deps.logger,
      });
      if (seeded === null) throw new Error("the first admin was not seeded");
      const { headers } = await bare.auth.api.signInEmail({ body: { email: "ada@example.com", password: TEST_PASSWORD }, returnHeaders: true });
      const cookie = cookieHeaderFrom(headers);
      const callerOf = async () => bare.callerFor(await createContext(bare.deps, { headers: cookie, resHeaders: new Headers() }));
      expect((await (await callerOf()).me.get()).theme).toBe("dark");
      expect(await (await callerOf()).account.setTheme({ theme: "light" })).toEqual({ theme: "light", changed: true });
      expect((await (await callerOf()).me.get()).theme).toBe("light");
      expect((await bare.auth.api.getSession({ headers: cookie }))?.user).toMatchObject({ theme: "light" });
      // better-auth's own profile update can't set it: the field takes no input.
      // @ts-expect-error: a field better-auth's input refuses, sent as any client could send it
      await expect(bare.auth.api.updateUser({ body: { theme: "system" }, headers: cookie })).rejects.toThrow();
      expect((await (await callerOf()).me.get()).theme).toBe("light");
    } finally {
      await bare.dispose();
    }
  });
});
