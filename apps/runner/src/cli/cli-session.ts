import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliSessionIdSchema, cliSessionTokenSchema, epochMsSchema, httpUrlSchema } from "@ostra/protocol";
import { z } from "zod";
import { makeOwnerOnlyDir, writeOwnerOnlyFile } from "../identity/owner-only.ts";

// The member's CLI session (F-103, ADR 0051): one file in the member's own config folder,
// `$XDG_CONFIG_HOME/ostra/cli.json` (or `~/.config/ostra/cli.json`), `%APPDATA%\ostra\cli.json` on
// Windows, readable by its owner only. It is a different credential from a runner's key, kept
// apart from the runner's data folder (ADR 0029, Q115). The token is never printed or logged.

export type CliEnv = Readonly<Record<string, string | undefined>>;

/** Where the CLI session lives on this machine. */
export const cliSessionPath = (env: CliEnv, platform: NodeJS.Platform = process.platform): string => {
  if (platform === "win32") {
    const appData = env["APPDATA"];
    const base = appData === undefined || appData === "" ? path.join(os.homedir(), "AppData", "Roaming") : appData;
    return path.join(base, "ostra", "cli.json");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg === undefined || xdg === "" || !path.isAbsolute(xdg) ? path.join(os.homedir(), ".config") : xdg;
  return path.join(base, "ostra", "cli.json");
};

/** The file's content. ostra owns it: strict. */
export const cliSessionFileSchema = z.strictObject({
  serverUrl: httpUrlSchema,
  sessionId: cliSessionIdSchema,
  token: cliSessionTokenSchema,
  expiresAt: epochMsSchema,
  username: z.string().min(1).max(128),
});
export type CliSessionFile = z.infer<typeof cliSessionFileSchema>;

export type LoadedCliSession =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly session: CliSessionFile }
  | { readonly kind: "broken"; readonly message: string };

export const loadCliSession = async (file: string): Promise<LoadedCliSession> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "none" };
    }
    return { kind: "broken", message: `can't read ${file}` };
  }
  try {
    const parsed = cliSessionFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: "found", session: parsed.data } : { kind: "broken", message: `${file} isn't a CLI session` };
  } catch {
    return { kind: "broken", message: `${file} isn't a CLI session` };
  }
};

/** Saves the session, replacing any earlier one: a second login replaces the first. */
export const saveCliSession = async (file: string, session: CliSessionFile): Promise<void> => {
  await makeOwnerOnlyDir(path.dirname(file));
  await writeOwnerOnlyFile(file, `${JSON.stringify(cliSessionFileSchema.parse(session), null, 2)}\n`);
};

export const removeCliSession = async (file: string): Promise<void> => {
  await rm(file, { force: true });
};
