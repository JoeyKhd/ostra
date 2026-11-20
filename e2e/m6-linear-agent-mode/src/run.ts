import { checkAppToken, refreshToken } from "@ostra/adapter-linear";
import type { LinearTokenSet } from "@ostra/adapter-linear";

import { writeEnvValue } from "./env-files.ts";
import { bulletOutcome } from "./judge.ts";
import type { InstallFacts } from "./judge.ts";
import { readAdmin } from "./linear-api.ts";
import type { LinearAccess } from "./linear-api.ts";
import { delegationsPhase, followUpAndStopPhase, installPhase, silentTurnPhase } from "./phases.ts";
import type { BulletResult, PhaseContext } from "./phases.ts";

// What the live run and its rehearsal share (ticket 38): the token's rotation, the install's facts,
// and the four bullets in order, each reported by the same judges.

export type RotatedToken = { readonly tokens: LinearTokenSet; readonly wroteBack: boolean };

/**
 * Refreshes the app's token with the saved refresh token, and writes the rotated one back to
 * `linear.env` before anything else uses it: Linear accepts a refresh token once, so the next run
 * needs the new one. Neither token is printed.
 */
export const rotateAppToken = async (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly linearEnvFile: string;
  /** Linear's own by default; the rehearsal passes the fake's. */
  readonly tokenUrl?: string;
}): Promise<RotatedToken> => {
  const refreshed = await refreshToken({ clientId: input.clientId, clientSecret: input.clientSecret, refreshToken: input.refreshToken, ...(input.tokenUrl === undefined ? {} : { tokenUrl: input.tokenUrl }) });
  if (!refreshed.ok) {
    throw new Error(`refreshing the app's token failed: ${refreshed.error.code}`);
  }
  const rotated = refreshed.value.refreshToken;
  if (rotated === input.refreshToken) {
    return { tokens: refreshed.value, wroteBack: false };
  }
  await writeEnvValue(input.linearEnvFile, "LINEAR_REFRESH_TOKEN", rotated);
  return { tokens: refreshed.value, wroteBack: true };
};

/** The install's facts: the token's user is the app's own, not the admin, with the scopes the answer granted. */
export const readInstall = async (access: LinearAccess, scopes: readonly string[]): Promise<InstallFacts & { readonly appUserName: string; readonly workspace: { readonly id: string; readonly key: string; readonly name: string }; readonly adminEmail: string }> => {
  const app = await checkAppToken({ accessToken: access.appToken, apiUrl: access.apiUrl });
  const admin = await readAdmin(access);
  return {
    viewerIsApp: app.ok,
    appUserId: app.ok ? app.value.appUserId : "",
    appUserName: app.ok ? app.value.appUserName : "",
    workspace: app.ok ? { id: app.value.workspaceId, key: app.value.workspaceKey, name: app.value.workspaceName } : { id: "", key: "", name: "" },
    adminUserId: admin.id,
    adminEmail: admin.email,
    scopes,
  };
};

/** The four bullets in order. A bullet that fails doesn't stop the next. */
export const runBullets = async (
  context: PhaseContext,
  install: InstallFacts,
  hooks: { /** Before bullet 3: the live run signs a runner in, for the follow-up's turn, the stop's and the silent one. */ readonly beforeFollowUp?: () => Promise<void> } = {},
): Promise<readonly BulletResult[]> => {
  const results: BulletResult[] = [installPhase(context, install)];
  const guard = async (bullet: string, run: () => Promise<readonly BulletResult[]>): Promise<void> => {
    try {
      results.push(...(await run()));
    } catch (error) {
      // The error's name and its own words: never a request or an answer.
      const detail = error instanceof Error ? error.message : "unknown";
      context.note(`FAIL ${bullet}: ${detail}`);
      results.push({ bullet, checks: [{ name: `${bullet} ran to its end`, outcome: "fail", detail }] });
    }
  };
  await guard("[2] delegations", async () => [await delegationsPhase(context)]);
  await guard("[3] follow-up and stop", async () => {
    await hooks.beforeFollowUp?.();
    return followUpAndStopPhase(context);
  });
  await guard("[4] 35 silent minutes", async () => [await silentTurnPhase(context)]);
  context.note("---- the four bullets");
  for (const result of results) context.note(`${bulletOutcome(result.checks).toUpperCase()} ${result.bullet}`);
  return results;
};
