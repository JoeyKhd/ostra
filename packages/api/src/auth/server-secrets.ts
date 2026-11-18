import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ServerSettings } from "@ostra/domain";

// The two secrets a fresh install needs and is never asked for (the self-hosting rule): the key
// that signs sessions (`BETTER_AUTH_SECRET`) and the setup token (`OSTRA_SETUP_TOKEN`, F-001,
// Q117). A setting wins. Without one, the server generates a value on first start and keeps it in
// `OSTRA_DATA_DIR` (mode 0600), so a restart finds the same value and a second web process reading
// the same folder agrees. Neither value is ever logged, except the one setup line below.

export type ServerSecrets = {
  /** Signs sessions and tokens. Never logged. */
  readonly betterAuthSecret: string;
  /** Needed once, to create the first admin. Printed by `announceSetupToken` only. */
  readonly setupToken: string;
};

const SECRET_FILE = "better-auth-secret";
const SETUP_TOKEN_FILE = "setup-token";

/** `ostra-setup-` marks the token for the log guard (adapter-sdk's `redactTokens` knows the prefix). */
export const generateSetupToken = (): string => `ostra-setup-${randomBytes(24).toString("hex")}`;

const generateSecret = (): string => randomBytes(48).toString("base64url");

const isMissing = (error: unknown): boolean => Reflect.get(Object(error), "code") === "ENOENT";

const readKept = async (file: string): Promise<string | null> => {
  try {
    const value = (await readFile(file, "utf8")).trim();
    return value === "" ? null : value;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
};

const keep = async (file: string, value: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  // `wx`: never overwrite a value another process just wrote.
  try {
    await writeFile(file, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") {
      throw error;
    }
  }
  // Windows has no file modes; chmod there is a no-op, not an error.
  await chmod(file, 0o600).catch(() => undefined);
};

/** A kept value, or a new one generated and kept. The kept file wins over a racing writer. */
const keptOrNew = async (file: string, make: () => string): Promise<string> => {
  const existing = await readKept(file);
  if (existing !== null) {
    return existing;
  }
  await keep(file, make());
  const written = await readKept(file);
  if (written === null) {
    throw new Error("a kept secret could not be read back");
  }
  return written;
};

export const loadServerSecrets = async (
  settings: Pick<ServerSettings, "dataDir" | "betterAuthSecret" | "setupToken">,
): Promise<ServerSecrets> => ({
  betterAuthSecret: settings.betterAuthSecret ?? (await keptOrNew(path.join(settings.dataDir, SECRET_FILE), generateSecret)),
  setupToken: settings.setupToken ?? (await keptOrNew(path.join(settings.dataDir, SETUP_TOKEN_FILE), generateSetupToken)),
});

/**
 * The one line that prints the setup token, with the panel's address, at start while no account
 * exists. It writes through `write`, not the structured logger, whose guard would (rightly)
 * redact a token. Nothing else ever logs the token.
 */
export const announceSetupToken = (write: (text: string) => void, input: { readonly panelUrl: string; readonly setupToken: string }): void => {
  write(
    [
      "",
      `ostra: this install has no account yet. Open ${input.panelUrl} and create the first admin.`,
      `ostra: setup token (needed once, stops working after the first account): ${input.setupToken}`,
      "",
    ].join("\n"),
  );
};
