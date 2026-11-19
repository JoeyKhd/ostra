import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ServerSettings } from "@ostra/domain";

// The secret a fresh install needs and is never asked for (the self-hosting rule): the key that
// signs sessions (`BETTER_AUTH_SECRET`). A setting wins. Without one, the server generates a value
// on first start and keeps it in `OSTRA_DATA_DIR` (mode 0600), so a restart finds the same value
// and a second web process reading the same folder agrees. It is never logged.
//
// (Until 2026-11-19 a setup token lived here too, Q117. The server now seeds the first admin
// itself, F-001, so there is no token; a `setup-token` file an older install left is ignored.)

export type ServerSecrets = {
  /** Signs sessions and tokens. Never logged. */
  readonly betterAuthSecret: string;
};

const SECRET_FILE = "better-auth-secret";

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
  // Written whole under a name of its own, then linked into place. A `wx` write made the file
  // before it held the value, so a second process starting at the same moment could read it
  // empty and fail. `link` is atomic and never overwrites a value another process just kept.
  const draft = `${file}.${randomBytes(6).toString("hex")}.draft`;
  await writeFile(draft, `${value}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(draft, file);
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") {
      throw error;
    }
  } finally {
    await rm(draft, { force: true });
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

export const loadServerSecrets = async (settings: Pick<ServerSettings, "dataDir" | "betterAuthSecret">): Promise<ServerSecrets> => ({
  betterAuthSecret: settings.betterAuthSecret ?? (await keptOrNew(path.join(settings.dataDir, SECRET_FILE), generateSecret)),
});
