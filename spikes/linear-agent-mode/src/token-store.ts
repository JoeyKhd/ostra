import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppUserId, OrganizationId } from "./ids.ts";
import { OSTRA_SCOPES } from "./manifest.ts";
import type { AdoptFailure, InstallationSummary, OstraServer } from "./server.ts";

// The app's OAuth token, kept between runs so a second `pnpm spike:real` does not need the admin to click Authorize
// again. It lives outside the repo (the repo is public) and is never logged: this module returns reasons, never values.
//
// An `actor=app` token lasts 24 hours (README, "What's left"). This stores only the access token. A refresh token is
// not kept, because nothing here uses one: an expired token is simply refused by Linear and the install runs again.

export const DEFAULT_TOKEN_PATH = join(homedir(), ".config", "ostra-dev", "linear-app-token.json");

/** ostra owns this format, so unknown fields are refused. */
export const storedTokenSchema = z.strictObject({
  version: z.literal(1),
  accessToken: z.string().min(1),
  /** The scopes the token was issued with, as the token response said. */
  scopes: z.array(z.string().min(1)),
  organizationId: OrganizationId,
  appUserId: AppUserId,
  savedAt: z.iso.datetime(),
});
export type StoredToken = z.infer<typeof storedTokenSchema>;

export type LoadResult =
  | { readonly ok: true; readonly token: StoredToken }
  | { readonly ok: false; readonly reason: "missing" | "unreadable" | "invalid" };

export const loadToken = async (path: string): Promise<LoadResult> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { ok: false, reason: missing ? "missing" : "unreadable" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = storedTokenSchema.safeParse(json);
  return parsed.success ? { ok: true, token: parsed.data } : { ok: false, reason: "invalid" };
};

/** Written next to the target and renamed into place, so a crash cannot leave half a token. Owner-only where the OS has modes. */
export const saveToken = async (path: string, token: StoredToken): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(storedTokenSchema.parse(token), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

/** The scopes ostra needs, all present in what the token was issued with. */
export const hasRequiredScopes = (scopes: readonly string[]): boolean => OSTRA_SCOPES.every((scope) => scopes.includes(scope));

export type ReuseOutcome =
  | { readonly kind: "reused"; readonly installation: InstallationSummary }
  | { readonly kind: "not-reused"; readonly why: string };

const ADOPT_WHY: Readonly<Record<AdoptFailure, string>> = {
  "missing-scopes": "the saved token was not issued with the scopes agent mode needs",
  rejected: "Linear refused the saved token (expired after 24 hours, revoked, or from another app)",
  unreachable: "Linear could not be reached to check the saved token",
  "not-an-app-user": "the saved token belongs to a person, not to the app's own user",
  "different-user": "the saved token belongs to another user or workspace than the one it was saved for",
};

const LOAD_WHY: Readonly<Record<Extract<LoadResult, { ok: false }>["reason"], string>> = {
  missing: "no token is saved yet",
  unreadable: "the token file could not be read",
  invalid: "the token file is not in the expected format",
};

/** Takes the saved token as the install when Linear confirms it, and says why not otherwise. Never returns the token. */
export const reuseSavedToken = async (server: Pick<OstraServer, "adoptToken">, path: string): Promise<ReuseOutcome> => {
  const loaded = await loadToken(path);
  if (!loaded.ok) return { kind: "not-reused", why: LOAD_WHY[loaded.reason] };
  const adopted = await server.adoptToken(loaded.token);
  return adopted.ok ? { kind: "reused", installation: adopted.installation } : { kind: "not-reused", why: ADOPT_WHY[adopted.reason] };
};
