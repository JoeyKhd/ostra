import { randomUUID } from "node:crypto";

import { SecretStoreAdapter, adapterError, ok, secretRefSchema } from "@ostra/adapter-sdk";
import type { AdapterResult, HealthReport, SecretRef, SecretScope } from "@ostra/adapter-sdk";
import type { OrganizationId } from "@ostra/protocol";

// Fake adapters for the domain's tests (milestone 11, ticket 06): small, in memory, never shipped.
// Each is a real subclass of its kind's base class (ADR 0025), as the API's are, so a use case that
// works with these works through the shared interface.

type StoredSecret = { readonly organizationId: OrganizationId; readonly purpose: string; readonly value: string };

/**
 * A secret store that keeps values in memory, scoped by organization like the real one. `onPut`
 * hears each put's purpose (so a test can order it against other calls), and `refuseNextPut`
 * makes the next put answer `unavailable`.
 */
export class FakeSecretStore extends SecretStoreAdapter {
  readonly name = "fake-secret-store";
  readonly capabilities = { rotation: false };
  readonly entries = new Map<string, StoredSecret>();
  refuseNextPut = false;
  readonly #onPut: (purpose: string) => void;

  constructor(options: { readonly onPut?: (purpose: string) => void } = {}) {
    super();
    this.#onPut = options.onPut ?? (() => undefined);
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>> {
    this.#onPut(scope.purpose);
    if (this.refuseNextPut) {
      this.refuseNextPut = false;
      return Promise.resolve(adapterError("unavailable", "the store is down"));
    }
    const ref = secretRefSchema.parse(`fake:${randomUUID()}`);
    this.entries.set(ref, { organizationId: scope.organizationId, purpose: scope.purpose, value });
    return Promise.resolve(ok(ref));
  }

  get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>> {
    const found = this.entries.get(ref);
    return Promise.resolve(found?.organizationId === organizationId ? ok(found.value) : adapterError("not-found", "no such secret"));
  }

  delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>> {
    const found = this.entries.get(ref);
    if (found?.organizationId !== organizationId) {
      return Promise.resolve(adapterError("not-found", "no such secret"));
    }
    this.entries.delete(ref);
    return Promise.resolve(ok(undefined));
  }

  /** Every value held, for a test that searches an output for them. */
  values(): readonly string[] {
    return [...this.entries.values()].map((entry) => entry.value);
  }

  /** Whether a reference column still names a value. */
  has(ref: string | null): boolean {
    return ref !== null && this.entries.has(ref);
  }
}
