import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Keys core makes for itself at first start and keeps in OSTRA_DATA_DIR (docs/configuration.md):
// the key that signs runners' access tokens, and the bootstrap join token's file. Each is written
// once, readable by its owner only, and never logged.

const readIfThere = async (file: string): Promise<string | null> => {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/** Writes a file only its owner can read. `wx`: two processes racing to make it can't both win. */
export const writeOwnerOnly = async (file: string, text: string): Promise<boolean> => {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${text}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "EEXIST") {
      return false;
    }
    throw error;
  }
};

/** A 32-byte key in `dataDir/<name>`, made on first use. */
export const loadOrCreateKey = async (dataDir: string, name: string): Promise<Buffer> => {
  const file = path.join(dataDir, name);
  const existing = await readIfThere(file);
  if (existing !== null && existing !== "") {
    return Buffer.from(existing, "base64url");
  }
  await writeOwnerOnly(file, randomBytes(32).toString("base64url"));
  // Read back: when another process won the race, its key is the one.
  const written = await readIfThere(file);
  if (written === null || written === "") {
    throw new Error(`could not keep the key ${name} in the data folder`);
  }
  return Buffer.from(written, "base64url");
};

export const readDataFile = (dataDir: string, name: string): Promise<string | null> => readIfThere(path.join(dataDir, name));
