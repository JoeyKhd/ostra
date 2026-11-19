import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SecretRowStore } from "@ostra/adapter-sdk";
import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import type { Db } from "@ostra/db";
import type { ServerSettings } from "@ostra/domain";
import { errnoCode, organizationIdSchema } from "@ostra/protocol";

// The built-in secret store's two server-side pieces (ticket 26, spec section 11, item 1): its key
// and its rows. The panel builds the same pair (apps/web/src/server/deps.ts): both read the key
// from OSTRA_SECRETS_KEY, or from `OSTRA_DATA_DIR/secrets-key`, made once at first start (mode
// 0600), so a value the panel stored is one core can read. The key is never logged.

/** The file in OSTRA_DATA_DIR that holds the secrets key when OSTRA_SECRETS_KEY is unset. */
export const SECRETS_KEY_FILE = "secrets-key";

export const loadSecretsKey = async (settings: Pick<ServerSettings, "secretsKey" | "dataDir">): Promise<string> => {
  if (settings.secretsKey !== null) {
    return settings.secretsKey;
  }
  const file = path.join(settings.dataDir, SECRETS_KEY_FILE);
  try {
    const kept = (await readFile(file, "utf8")).trim();
    if (kept !== "") {
      return kept;
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${generateSecretsKey()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // The panel wrote it first: its key wins.
    if (errnoCode(error) !== "EEXIST") {
      throw error;
    }
  }
  await chmod(file, 0o600).catch(() => undefined);
  return (await readFile(file, "utf8")).trim();
};

/** The `Secret` table as the built-in store's rows. */
export const postgresSecretRows = (db: Db): SecretRowStore => ({
  insert: async (row) => {
    await db.secret.create({
      data: {
        id: row.id,
        organizationId: row.organizationId,
        purpose: row.purpose,
        ciphertext: Uint8Array.from(row.ciphertext),
        nonce: Uint8Array.from(row.nonce),
        keyVersion: row.keyVersion,
      },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) {
      return undefined;
    }
    return {
      id: row.id,
      organizationId: organizationIdSchema.parse(row.organizationId),
      purpose: row.purpose,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      keyVersion: row.keyVersion,
    };
  },
  delete: async (id) => {
    const { count } = await db.secret.deleteMany({ where: { id } });
    return count > 0;
  },
});
