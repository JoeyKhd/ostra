import type { OrganizationId } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { SecretStoreAdapter } from "../secret-store/base.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every secret store passes (ADR 0025, ticket 14): values round-trip, references hold
// nothing of the value, and one organization never reads another's.

export type SecretStoreFixture = {
  readonly organizationId: OrganizationId;
  readonly otherOrganizationId: OrganizationId;
};

export const defineSecretStoreContractSuite = (
  options: ContractSuiteOptions<SecretStoreAdapter, SecretStoreFixture>,
): void => {
  describe(`secret store contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "secret-store", { rotation: "boolean" });

    const put = async (value: string) => {
      const { adapter, fixture } = subject();
      const ref = await adapter.put({ organizationId: fixture.organizationId, purpose: "contract.test" }, value);
      if (!ref.ok) {
        throw new Error(`put failed: ${ref.error.message}`);
      }
      return ref.value;
    };

    it("round-trips a value, unicode and newlines included", async () => {
      const value = "s3cret-🔑\nline two";
      const ref = await put(value);
      expect(await subject().adapter.get(subject().fixture.organizationId, ref)).toEqual({ ok: true, value });
    });

    it("gives each put its own reference, holding nothing of the value", async () => {
      const value = "a-distinctive-secret-value-0123456789";
      const first = await put(value);
      const second = await put(value);
      expect(first).not.toBe(second);
      expect(first.includes(value)).toBe(false);
      expect(first.includes("distinctive")).toBe(false);
    });

    it("never lets another organization read or delete it", async () => {
      const ref = await put("org-a-only");
      const { adapter, fixture } = subject();
      expect(await adapter.get(fixture.otherOrganizationId, ref)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.delete(fixture.otherOrganizationId, ref)).toMatchObject({
        ok: false,
        error: { code: "not-found" },
      });
      expect(await adapter.get(fixture.organizationId, ref)).toEqual({ ok: true, value: "org-a-only" });
    });

    it("deletes a value: reading or deleting it again is not-found", async () => {
      const ref = await put("short-lived");
      const { adapter, fixture } = subject();
      expect(await adapter.delete(fixture.organizationId, ref)).toEqual({ ok: true, value: undefined });
      expect(await adapter.get(fixture.organizationId, ref)).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await adapter.delete(fixture.organizationId, ref)).toMatchObject({ ok: false, error: { code: "not-found" } });
    });
  });
};
