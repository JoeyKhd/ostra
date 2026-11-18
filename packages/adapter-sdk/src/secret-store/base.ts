import type { OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { SecretStoreCapabilities } from "./capabilities.ts";

// The secret store kind (ADR 0025): built in (encrypted in Postgres) for v1, Vault and cloud key
// managers later. Every other record holds a reference, never a value.

/**
 * A secret's reference: `<store>:<opaque>`, such as `builtin:0196…`. It holds no part of the value,
 * so it's safe to store and to log.
 */
export const secretRefSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[a-z][a-z0-9-]*:[^\s]+$/, "a secret reference, <store>:<id>")
  .brand<"SecretRef">();
export type SecretRef = z.infer<typeof secretRefSchema>;

/** Who a secret belongs to and what it's for. `purpose` names it, never holds it. */
export type SecretScope = {
  readonly organizationId: OrganizationId;
  readonly purpose: string;
};

export abstract class SecretStoreAdapter {
  readonly kind = "secret-store" as const;
  abstract readonly name: string;
  abstract readonly capabilities: SecretStoreCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  abstract health(): Promise<HealthReport>;

  /** Stores a value and returns its new reference. */
  abstract put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>>;

  /** The value behind a reference, only for its own organization: another's answers `not-found`. */
  abstract get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>>;

  /** Deletes a value. Deleting one that's gone answers `not-found`. */
  abstract delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>>;
}
