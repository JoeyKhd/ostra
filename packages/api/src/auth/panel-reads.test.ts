import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiHarness, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";
import { hashResetToken } from "./account-hooks.ts";

// F-002, F-003 (ticket 32 and 33's screens): the three reads the panel's account pages need beside
// ticket 22 and 43's procedures. `email.on` for the pages before sign-in, `accounts.resetPreview` for
// the reset link's page, and `instance.admins` for the Accounts page's "Instance admins".

let harness: ApiHarness;
let instanceAdmin: AppCaller;

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  harness = await createApiHarness();
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
  instanceAdmin = await harness.as(harness.fixture.a.admin);
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(() => {
  harness.emailSwitch.on = false;
  vi.useRealTimers();
});

describe("email.on", () => {
  it("F-002/c7: says whether the install mails, to a visitor who isn't signed in", async () => {
    expect(await harness.anonymous().email.on()).toEqual({ on: false });
    harness.emailSwitch.on = true;
    expect(await harness.anonymous().email.on()).toEqual({ on: true });
  });
});

describe("accounts.resetPreview", () => {
  const grantFor = async (input: { readonly expiresAt: Date; readonly usedAt?: Date }) => {
    const token = randomUUID();
    await harness.test.db.resetLinkGrant.create({
      data: { userId: harness.fixture.a.member.userId, kind: "admin_link", createdByUserId: harness.fixture.a.admin.userId, tokenHash: hashResetToken(token), expiresAt: input.expiresAt, usedAt: input.usedAt ?? null },
    });
    return token;
  };

  it("F-002/c7: a working link names its account's address; a used, an expired and an unknown one say which", async () => {
    const visitor = harness.anonymous();
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.member.userId } });
    const valid = await grantFor({ expiresAt: new Date(Date.now() + HOUR) });
    const used = await grantFor({ expiresAt: new Date(Date.now() + HOUR), usedAt: new Date() });
    const expired = await grantFor({ expiresAt: new Date(Date.now() - 1000) });
    expect(await visitor.accounts.resetPreview({ token: valid })).toEqual({ state: "valid", address: account.email });
    expect(await visitor.accounts.resetPreview({ token: used })).toEqual({ state: "used" });
    expect(await visitor.accounts.resetPreview({ token: expired })).toEqual({ state: "expired" });
    expect(await visitor.accounts.resetPreview({ token: "not-a-token-anyone-made" })).toEqual({ state: "unknown" });
  });

  it("F-002/c7: the instance admin's link opens the reset page, whose preview finds it", async () => {
    const created = await instanceAdmin.accounts.createResetLink({ userId: harness.fixture.a.member.userId });
    const url = new URL(created.link);
    expect(url.pathname).toBe("/reset/new");
    const token = url.searchParams.get("token") ?? "";
    expect(await harness.anonymous().accounts.resetPreview({ token })).toMatchObject({ state: "valid" });
  });
});

describe("instance.admins", () => {
  it("F-003/c2: lists the instance admins, for the instance admin only", async () => {
    const admins = await instanceAdmin.instance.admins();
    expect(admins.map((admin) => admin.userId)).toEqual([harness.fixture.a.admin.userId]);
    expect(admins[0]?.since).toEqual(expect.any(Number));
    const orgAdmin = await harness.as(harness.fixture.b.admin);
    expect(await trpcFailure(orgAdmin.instance.admins())).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(harness.anonymous().instance.admins())).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
