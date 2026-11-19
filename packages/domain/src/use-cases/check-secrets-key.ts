import type { SecretRow, SecretsKeyCheck } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { organizationIdSchema } from "@ostra/protocol";

import { FIRST_ACCOUNT_LOCK_KEY } from "./seed-first-admin.ts";

// Q136, item 1 (milestone 2's ticket 45): the secrets key is generated on first start and kept in
// OSTRA_DATA_DIR, so a database restored onto a new machine, or a second server process with a data
// folder of its own, can hold a key that opens none of the stored secrets. The first time an install
// uses a key, the server stores a fixed value sealed with it, per key version; at every start core
// and the panel open it, and a key that can't refuses the start. Processes starting together on an
// empty install take the first admin's advisory lock, so one value is stored and all of them read it.

/** What the check needs of the secret store: the built-in store has these (`BuiltinSecretStore`). */
export type SecretsKeyProbe = {
  readonly sealKeyCheck: () => SecretsKeyCheck;
  readonly opensKeyCheck: (check: SecretsKeyCheck) => boolean;
  readonly opensRow: (row: SecretRow) => boolean;
};

export type SecretsKeyCheckResult =
  | { readonly ok: true; readonly outcome: "stored" | "matched" }
  | { readonly ok: false; readonly reason: "other-key" };

/** What a process that refuses to start says: the cause, and the two fixes. Holds no key. */
export const SECRETS_KEY_MISMATCH_MESSAGE =
  "This secrets key isn't the one the database's secrets were written with, so none of them could be read. " +
  "Set OSTRA_SECRETS_KEY to the key they were written with, or restore secrets-key in the data folder (OSTRA_DATA_DIR) " +
  "from the install this database comes from. Nothing was changed.";

/** The error's name a start fails with when the key doesn't match. */
export const SECRETS_KEY_MISMATCH = "SecretsKeyMismatchError";

/** The error a start fails with when the key doesn't match (no classes outside adapters: ADR 0025). */
export const secretsKeyMismatchError = (): Error => {
  const error = new Error(SECRETS_KEY_MISMATCH_MESSAGE);
  error.name = SECRETS_KEY_MISMATCH;
  return error;
};

/** Whether a start failed because the key doesn't match. By name: a bundler may hold two copies of this module. */
export const isSecretsKeyMismatch = (error: unknown): error is Error => error instanceof Error && error.name === SECRETS_KEY_MISMATCH;

type CheckDb = Pick<Db, "secretsKeyCheck" | "secret">;

const storedCheck = async (db: CheckDb, keyVersion: number): Promise<SecretsKeyCheck | null> => {
  const row = await db.secretsKeyCheck.findUnique({ where: { keyVersion } });
  return row === null ? null : { keyVersion: row.keyVersion, ciphertext: row.ciphertext, nonce: row.nonce };
};

/**
 * An install that stored secrets before the check existed: its key must open one of them before
 * the check is stored with it, or a wrong key would become the one the check vouches for.
 */
const opensAStoredSecret = async (db: CheckDb, probe: SecretsKeyProbe, keyVersion: number): Promise<boolean> => {
  const row = await db.secret.findFirst({ where: { keyVersion }, orderBy: { createdAt: "asc" } });
  if (row === null) {
    return true;
  }
  return probe.opensRow({
    id: row.id,
    organizationId: organizationIdSchema.parse(row.organizationId),
    purpose: row.purpose,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.keyVersion,
  });
};

/** Checks the secrets key against the database's, storing the check the first time. Writes nothing on a mismatch. */
export const checkSecretsKey = async (db: Db, probe: SecretsKeyProbe): Promise<SecretsKeyCheckResult> => {
  const sealed = probe.sealKeyCheck();
  // A restart is the common case: one read, no lock.
  const existing = await storedCheck(db, sealed.keyVersion);
  if (existing !== null) {
    return probe.opensKeyCheck(existing) ? { ok: true, outcome: "matched" } : { ok: false, reason: "other-key" };
  }
  return db.$transaction(async (tx): Promise<SecretsKeyCheckResult> => {
    // $executeRaw: Prisma 7's pg adapter can't read the `void` the lock returns (seed-first-admin.ts).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK_KEY})`;
    const won = await storedCheck(tx, sealed.keyVersion);
    if (won !== null) {
      return probe.opensKeyCheck(won) ? { ok: true, outcome: "matched" } : { ok: false, reason: "other-key" };
    }
    if (!(await opensAStoredSecret(tx, probe, sealed.keyVersion))) {
      return { ok: false, reason: "other-key" };
    }
    await tx.secretsKeyCheck.create({
      data: { keyVersion: sealed.keyVersion, ciphertext: Uint8Array.from(sealed.ciphertext), nonce: Uint8Array.from(sealed.nonce) },
    });
    return { ok: true, outcome: "stored" };
  });
};
