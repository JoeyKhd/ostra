import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { adapterError, ok, secretRefSchema, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterResult,
  HealthReport,
  SecretRef,
  SecretRow,
  SecretRowStore,
  SecretScope,
  SecretStoreCapabilities,
} from "@ostra/adapter-sdk";
import { organizationIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

// The built-in secret store (ADR 0025, spec section 11 item 1): each value is sealed with
// AES-256-GCM under a fresh random nonce, and the row holds only the ciphertext. The organization
// ID, the secret's purpose and its row ID are the associated data, so a row moved to another
// organization (or given another purpose) fails its integrity check instead of decrypting.
// Rows go through the injected `SecretRowStore`: the server backs it with Postgres.

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const STORE_NAME = "builtin";

/** The 32-byte key the store seals values with. Never logged. */
export type SecretsKey = {
  /** Stored in each row, so a later release can rotate keys without losing old rows. */
  readonly version: number;
  readonly bytes: Uint8Array;
};

/**
 * Reads a key from the text an operator gives (`OSTRA_SECRETS_KEY`): 64 hex characters, or 32
 * bytes in base64 or base64url. The error names what was wrong, never the key.
 */
export const parseSecretsKey = (text: string, version = 1): AdapterResult<SecretsKey> => {
  const trimmed = text.trim();
  let bytes: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, "base64");
  }
  if (bytes?.length !== KEY_BYTES) {
    return adapterError("invalid-input", "the secrets key must be 32 bytes: 64 hex characters, or base64");
  }
  return ok({ version, bytes: new Uint8Array(bytes) });
};

/** A fresh random key, as hex: what the server generates into its data folder on first start. */
export const generateSecretsKey = (): string => randomBytes(KEY_BYTES).toString("hex");

const associatedData = (organizationId: string, purpose: string, id: string): Buffer =>
  Buffer.from(JSON.stringify(["ostra-secret-v1", organizationId, purpose, id]), "utf8");

export class BuiltinSecretStore extends SecretStoreAdapter {
  readonly name = STORE_NAME;
  readonly capabilities: SecretStoreCapabilities = { rotation: false };

  readonly #rows: SecretRowStore;
  readonly #key: SecretsKey;

  constructor(options: { readonly rows: SecretRowStore; readonly key: SecretsKey }, context?: AdapterContext) {
    super(context);
    if (options.key.bytes.length !== KEY_BYTES) {
      throw new Error("the secrets key must be 32 bytes");
    }
    this.#rows = options.rows;
    this.#key = options.key;
  }

  health(): Promise<HealthReport> {
    // A self-test of the key and the cipher. The rows' database has its own health check.
    const organizationId = organizationIdSchema.parse("health");
    const sealed = this.#seal(randomUUID(), organizationId, "health", "health");
    return Promise.resolve(
      this.#open(sealed, organizationId).ok
        ? { status: "ok" }
        : { status: "down", reason: "the secrets key can't open what it seals" },
    );
  }

  async put(scope: SecretScope, value: string): Promise<AdapterResult<SecretRef>> {
    const id = randomUUID();
    const row = this.#seal(value, scope.organizationId, scope.purpose, id);
    try {
      await this.#rows.insert(row);
    } catch {
      this.plumbing.logger.error("secret.put failed", { organizationId: scope.organizationId, purpose: scope.purpose });
      return adapterError("unavailable", "the secret store could not save the value");
    }
    this.plumbing.logger.info("secret.put", {
      organizationId: scope.organizationId,
      purpose: scope.purpose,
      secretId: id,
    });
    return ok(secretRefSchema.parse(`${STORE_NAME}:${id}`));
  }

  async get(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<string>> {
    const found = await this.#find(organizationId, ref);
    if (!found.ok) {
      return found;
    }
    const opened = this.#open(found.value, organizationId);
    if (!opened.ok) {
      this.plumbing.logger.error("secret.get failed its integrity check", {
        organizationId,
        secretId: found.value.id,
        keyVersion: found.value.keyVersion,
      });
    }
    return opened;
  }

  async delete(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<void>> {
    const found = await this.#find(organizationId, ref);
    if (!found.ok) {
      return found;
    }
    try {
      if (!(await this.#rows.delete(found.value.id))) {
        return adapterError("not-found", "no such secret");
      }
    } catch {
      this.plumbing.logger.error("secret.delete failed", { organizationId, secretId: found.value.id });
      return adapterError("unavailable", "the secret store could not delete the value");
    }
    this.plumbing.logger.info("secret.delete", { organizationId, secretId: found.value.id });
    return ok(undefined);
  }

  /** The row behind a reference, only when it's this store's and this organization's. */
  async #find(organizationId: OrganizationId, ref: SecretRef): Promise<AdapterResult<SecretRow>> {
    const prefix = `${STORE_NAME}:`;
    if (!ref.startsWith(prefix)) {
      return adapterError("not-found", "no such secret");
    }
    let row: SecretRow | undefined;
    try {
      row = await this.#rows.get(ref.slice(prefix.length));
    } catch {
      this.plumbing.logger.error("secret lookup failed", { organizationId });
      return adapterError("unavailable", "the secret store could not read the value");
    }
    return row?.organizationId === organizationId ? ok(row) : adapterError("not-found", "no such secret");
  }

  #seal(value: string, organizationId: OrganizationId, purpose: string, id: string): SecretRow {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key.bytes, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(organizationId, purpose, id));
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return {
      id,
      organizationId,
      purpose,
      ciphertext: new Uint8Array(sealed),
      nonce: new Uint8Array(nonce),
      keyVersion: this.#key.version,
    };
  }

  #open(row: SecretRow, organizationId: OrganizationId): AdapterResult<string> {
    if (row.keyVersion !== this.#key.version) {
      return adapterError("invalid-response", "the stored secret was sealed under a key this store doesn't hold");
    }
    if (row.ciphertext.length < TAG_BYTES || row.nonce.length !== NONCE_BYTES) {
      return adapterError("invalid-response", "the stored secret failed its integrity check");
    }
    const body = row.ciphertext.subarray(0, row.ciphertext.length - TAG_BYTES);
    const tag = row.ciphertext.subarray(row.ciphertext.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key.bytes, row.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(organizationId, row.purpose, row.id));
      decipher.setAuthTag(tag);
      return ok(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
    } catch {
      return adapterError("invalid-response", "the stored secret failed its integrity check");
    }
  }
}
