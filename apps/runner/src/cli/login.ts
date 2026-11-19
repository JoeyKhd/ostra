import os from "node:os";
import { cliDeviceResponseSchema, cliDeviceTokenResponseSchema, cliPaths, cliSessionDeleteResponseSchema, httpUrlSchema } from "@ostra/protocol";
import { RUNNER_VERSION } from "../version.ts";
import { cliRequest } from "./cli-http.ts";
import { cliSessionPath, loadCliSession, removeCliSession, saveCliSession } from "./cli-session.ts";
import type { CliEnv } from "./cli-session.ts";
import type { Terminal } from "./terminal.ts";

// `ostra login` and `ostra logout` (F-103, ADR 0051): a member's CLI session, signed in with the
// device-code grant (purpose `cli`) that the member approves in the browser, as a runner's is. The
// token goes to the member's own config file and nowhere else: never a line of output, never a log.

export type CliCommandDeps = {
  readonly env: CliEnv;
  readonly terminal: Terminal;
  readonly signal: AbortSignal;
  /** For tests: the grant's waits and the clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /** The machine's name for the panel's list. Default: the host name. */
  readonly machineName?: string;
  /** For tests: the platform the config folder follows. */
  readonly platform?: NodeJS.Platform;
};

export type CliOutcome = { readonly ok: true } | { readonly ok: false; readonly usage?: boolean };

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The server's base URL, without a trailing path. */
const serverBase = (value: string): string | undefined => {
  const parsed = httpUrlSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const url = new URL(parsed.data);
  return url.origin;
};

export const runLogin = async (flags: Readonly<Record<string, string>>, deps: CliCommandDeps): Promise<CliOutcome> => {
  const { terminal } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const file = cliSessionPath(deps.env, deps.platform);
  const earlier = await loadCliSession(file);
  // The web app's address (the panel's), not core's: a runner's `OSTRA_SERVER_URL` names core.
  const named = flags["server"] ?? (earlier.kind === "found" ? earlier.session.serverUrl : undefined);
  if (named === undefined) {
    terminal.warn("ostra login: name the server: `ostra login --server <url>`.");
    return { ok: false, usage: true };
  }
  const serverUrl = serverBase(named);
  if (serverUrl === undefined) {
    terminal.warn(`ostra login: "${named}" isn't an http or https URL.`);
    return { ok: false, usage: true };
  }
  const machine = (deps.machineName ?? os.hostname()).trim().slice(0, 128) || "unnamed machine";
  const started = await cliRequest(
    { serverUrl, path: cliPaths.device, method: "POST", body: { name: machine, version: RUNNER_VERSION }, signal: deps.signal },
    cliDeviceResponseSchema,
    [200, 201],
  );
  if (!started.ok) {
    terminal.warn(`ostra login: ${started.message}`);
    return { ok: false };
  }
  const grant = started.value;
  terminal.say(`To sign in, open ${grant.verificationUrlComplete}`);
  terminal.say(`and check that it shows the code ${grant.userCode}.`);
  terminal.say("Waiting for the approval...");
  let intervalMs = grant.intervalSeconds * 1_000;
  for (;;) {
    if (deps.signal.aborted) {
      terminal.warn("ostra login: stopped.");
      return { ok: false };
    }
    if (now() >= grant.expiresAt) {
      terminal.warn("ostra login: the code expired before it was approved. Run `ostra login` again.");
      return { ok: false };
    }
    await sleep(intervalMs, deps.signal);
    const polled = await cliRequest(
      { serverUrl, path: cliPaths.deviceToken, method: "POST", body: { deviceCode: grant.deviceCode }, signal: deps.signal },
      cliDeviceTokenResponseSchema,
    );
    if (polled.ok) {
      await saveCliSession(file, { serverUrl, ...polled.value });
      terminal.say(`Signed in to ${serverUrl} as ${polled.value.username}. The session is saved in ${file}.`);
      return { ok: true };
    }
    if (polled.kind === "unreachable") {
      // A dropped poll is tried again at the next interval, until the code expires.
      terminal.logger.debug("cli.login.poll-unanswered", {});
      continue;
    }
    switch (polled.code) {
      case "authorization-pending":
        continue;
      case "slow-down":
        intervalMs += 5_000;
        continue;
      case "access-denied":
        terminal.warn("ostra login: the sign-in was denied in the browser.");
        return { ok: false };
      case "expired-token":
        terminal.warn("ostra login: the code expired before it was approved. Run `ostra login` again.");
        return { ok: false };
      default:
        terminal.warn(`ostra login: ${polled.message}`);
        return { ok: false };
    }
  }
};

export const runLogout = async (deps: CliCommandDeps): Promise<CliOutcome> => {
  const file = cliSessionPath(deps.env, deps.platform);
  const loaded = await loadCliSession(file);
  switch (loaded.kind) {
    case "none":
      deps.terminal.say("You're not signed in: nothing to sign out of.");
      return { ok: true };
    case "broken":
      await removeCliSession(file);
      deps.terminal.say(`Removed ${file}, which held no session this CLI can read.`);
      return { ok: true };
    case "found":
      break;
    default:
      return loaded satisfies never;
  }
  const { session } = loaded;
  const revoked = await cliRequest(
    { serverUrl: session.serverUrl, path: cliPaths.session, method: "DELETE", token: session.token, signal: deps.signal },
    cliSessionDeleteResponseSchema,
  );
  if (!revoked.ok && (revoked.kind === "unreachable" || revoked.status !== 401)) {
    // Kept: a session the server still honours must not be forgotten here while it's live there.
    deps.terminal.warn(`ostra logout: ${revoked.message}. The session is still signed in; try again.`);
    return { ok: false };
  }
  await removeCliSession(file);
  deps.terminal.say(`Signed out of ${session.serverUrl}.`);
  return { ok: true };
};
