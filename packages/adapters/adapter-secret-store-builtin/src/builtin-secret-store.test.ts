import { defineSecretStoreContractSuite, memoryAdapterContext, memorySecretRowStore } from "@ostra/adapter-sdk/testing";
import { organizationIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { BuiltinSecretStore, generateSecretsKey, parseSecretsKey } from "./builtin-secret-store.ts";

const orgA = organizationIdSchema.parse("org-a");
const orgB = organizationIdSchema.parse("org-b");

const newKey = () => {
  const parsed = parseSecretsKey(generateSecretsKey());
  if (!parsed.ok) {
    throw new Error("a generated key must parse");
  }
  return parsed.value;
};

defineSecretStoreContractSuite({
  name: "builtin secret store, in-memory rows",
  create: () =>
    Promise.resolve({
      adapter: new BuiltinSecretStore({ rows: memorySecretRowStore(), key: newKey() }),
      fixture: { organizationId: orgA, otherOrganizationId: orgB },
    }),
});

const setup = () => {
  const rows = memorySecretRowStore();
  const context = memoryAdapterContext();
  const store = new BuiltinSecretStore({ rows, key: newKey() }, context);
  return { rows, context, store };
};

const secretValue = "tok-a-very-distinctive-secret-value-0123456789";

describe("the built-in secret store's encryption", () => {
  it("keeps no part of the value in its row", async () => {
    const { rows, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "model-provider.token" }, secretValue);
    expect(ref.ok).toBe(true);
    const [row] = [...rows.rows.values()];
    expect(row).toBeDefined();
    expect(Buffer.from(row?.ciphertext ?? []).toString("utf8")).not.toContain("distinctive");
    expect(row?.nonce.length).toBe(12);
  });

  it("uses a fresh nonce for every put, even for the same value", async () => {
    const { rows, store } = setup();
    await store.put({ organizationId: orgA, purpose: "x" }, secretValue);
    await store.put({ organizationId: orgA, purpose: "x" }, secretValue);
    const nonces = [...rows.rows.values()].map((row) => Buffer.from(row.nonce).toString("hex"));
    expect(new Set(nonces).size).toBe(2);
  });

  it("fails with a typed failure when a row is moved to another organization", async () => {
    const { rows, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "x" }, secretValue);
    if (!ref.ok) {
      throw new Error("put failed");
    }
    const [row] = [...rows.rows.values()];
    if (row === undefined) {
      throw new Error("no row");
    }
    await rows.delete(row.id);
    await rows.insert({ ...row, organizationId: orgB });
    expect(await store.get(orgB, ref.value)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    expect(await store.get(orgA, ref.value)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("fails with a typed failure when a row's purpose changes", async () => {
    const { rows, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "git.token" }, secretValue);
    if (!ref.ok) {
      throw new Error("put failed");
    }
    const [row] = [...rows.rows.values()];
    if (row === undefined) {
      throw new Error("no row");
    }
    await rows.delete(row.id);
    await rows.insert({ ...row, purpose: "other.token" });
    expect(await store.get(orgA, ref.value)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("fails with a typed failure when one byte of the ciphertext changes", async () => {
    const { rows, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "x" }, secretValue);
    if (!ref.ok) {
      throw new Error("put failed");
    }
    const [row] = [...rows.rows.values()];
    if (row === undefined) {
      throw new Error("no row");
    }
    const changed = new Uint8Array(row.ciphertext);
    changed[0] = (changed[0] ?? 0) ^ 1;
    await rows.delete(row.id);
    await rows.insert({ ...row, ciphertext: changed });
    expect(await store.get(orgA, ref.value)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("fails with a typed failure under another key", async () => {
    const { rows, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "x" }, secretValue);
    if (!ref.ok) {
      throw new Error("put failed");
    }
    const other = new BuiltinSecretStore({ rows, key: newKey() });
    expect(await other.get(orgA, ref.value)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("answers unavailable, not a throw, when the rows fail", async () => {
    const failing = new BuiltinSecretStore({
      rows: {
        insert: () => Promise.reject(new Error(`database down with ${secretValue}`)),
        get: () => Promise.reject(new Error("database down")),
        delete: () => Promise.reject(new Error("database down")),
      },
      key: newKey(),
    });
    const put = await failing.put({ organizationId: orgA, purpose: "x" }, secretValue);
    expect(put).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(put)).not.toContain("distinctive");
  });
});

describe("the built-in secret store's keys", () => {
  it("accepts 64 hex characters and 32 bytes of base64", () => {
    expect(parseSecretsKey("a".repeat(64)).ok).toBe(true);
    expect(parseSecretsKey(Buffer.alloc(32, 7).toString("base64")).ok).toBe(true);
    expect(parseSecretsKey(Buffer.alloc(32, 7).toString("base64url")).ok).toBe(true);
  });

  it("refuses a short or odd key without echoing it", () => {
    const refused = parseSecretsKey("not-a-key-at-all");
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(JSON.stringify(refused)).not.toContain("not-a-key");
    expect(parseSecretsKey(Buffer.alloc(16, 1).toString("hex")).ok).toBe(false);
  });

  it("refuses a key of the wrong length at construction", () => {
    expect(() => new BuiltinSecretStore({ rows: memorySecretRowStore(), key: { version: 1, bytes: new Uint8Array(8) } })).toThrow(
      "32 bytes",
    );
  });
});

describe("the built-in secret store's logs", () => {
  it("holds no value on any path", async () => {
    const { rows, context, store } = setup();
    const ref = await store.put({ organizationId: orgA, purpose: "model-provider.token" }, secretValue);
    if (!ref.ok) {
      throw new Error("put failed");
    }
    await store.get(orgA, ref.value);
    await store.get(orgB, ref.value);
    const [row] = [...rows.rows.values()];
    if (row === undefined) {
      throw new Error("no row");
    }
    await rows.delete(row.id);
    const changed = new Uint8Array(row.ciphertext);
    changed[1] = (changed[1] ?? 0) ^ 1;
    await rows.insert({ ...row, ciphertext: changed });
    await store.get(orgA, ref.value);
    await store.delete(orgA, ref.value);
    await store.delete(orgA, ref.value);

    const logged = JSON.stringify(context.logger.records);
    expect(context.logger.records.length).toBeGreaterThan(0);
    expect(logged).not.toContain("distinctive");
    expect(logged).not.toContain(secretValue);
  });
});
