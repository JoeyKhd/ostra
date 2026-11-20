import os from "node:os";
import type { InfoResponse, RunnerConfig } from "@ostra/protocol";
import type { Terminal } from "./cli/terminal.ts";
import { generateRunnerKeyPair } from "./identity/key-pair.ts";
import { dataPaths, loadIdentity, saveIdentity, signInAgainAdvice, updateStatus } from "./identity/store.ts";
import type { RefusalReason, RunnerIdentity } from "./identity/store.ts";
import { createAccessTokens } from "./server/access-token.ts";
import type { AccessTokens } from "./server/access-token.ts";
import { runDeviceFlow } from "./server/device-flow.ts";
import type { DeviceFlowInput } from "./server/device-flow.ts";
import { describeFailure } from "./server/http.ts";
import { fetchInfo } from "./server/info.ts";
import { hostSlots } from "./reports.ts";
import type { CallFailure } from "./server/http.ts";
import { register } from "./server/register.ts";
import type { RegisterProof } from "./server/register.ts";
import { RUNNER_VERSION } from "./version.ts";

// `ostra runner`'s sign-in (ticket 15, ADR 0029 as amended, Q115):
//
// - the first time: read `/runner/v1/info`, refuse a server outside the version window, run the
//   device flow against the panel (or use the join token of a pool runner), make the key pair,
//   register, and keep the runner ID and the key
// - every start after: the key signs an assertion for a 10-minute access token, held in memory.
//   Only a revoked runner or a key the server doesn't know stops here; a refusal that can pass (the
//   clocks disagree, say) is told and left to the connection, which asks again with its backoff
//
// The device session is used once, as the bearer of the register call, and forgotten.

export type SignedIn = {
  readonly identity: RunnerIdentity;
  readonly info: InfoResponse;
  readonly tokens: AccessTokens;
};

export type SignInFailure = {
  readonly reason: RefusalReason | "broken-identity" | "other-server" | "device-flow" | "join-refused";
  /** For the person at the terminal: what happened and what to do. Never holds a token. */
  readonly message: string;
};

export type SignInResult = { readonly ok: true; readonly value: SignedIn } | { readonly ok: false; readonly failure: SignInFailure };

export type SignInInput = {
  readonly config: RunnerConfig;
  readonly dataDir: string;
  readonly terminal: Terminal;
  readonly now?: () => number;
  /** For tests: the device flow's waits. */
  readonly deviceFlow?: Pick<DeviceFlowInput, "sleep" | "now">;
  readonly signal?: AbortSignal;
};

const fail = (reason: SignInFailure["reason"], message: string): SignInResult => ({ ok: false, failure: { reason, message } });

/** Why core refused a join token (milestone 5, F-091): its 401 says so in words. */
export type JoinRefusal = "expired" | "revoked" | "unknown";

/** The refusal of a pool's join token in core's register answer, or `null` when it's something else. */
export const joinRefusalOf = (failure: CallFailure): JoinRefusal | null => {
  if (failure.kind !== "refused" || failure.status !== 401) {
    return null;
  }
  const words = failure.error?.message ?? "";
  return /expired/i.test(words) ? "expired" : /revoked/i.test(words) ? "revoked" : "unknown";
};

const joinRefusalWords: Readonly<Record<JoinRefusal, string>> = {
  expired: "it has expired",
  revoked: "it was revoked",
  unknown: "the server doesn't know it",
};

const recordRefusal = async (input: SignInInput, reason: RefusalReason, message: string): Promise<void> => {
  await updateStatus(input.dataDir, { lastRefusal: { at: (input.now ?? Date.now)(), reason, message } });
};

const obtainProof = async (input: SignInInput, info: InfoResponse): Promise<RegisterProof | SignInFailure> => {
  if (input.config.joinToken !== undefined) {
    return { kind: "join-token", joinToken: input.config.joinToken };
  }
  input.terminal.say("This runner isn't signed in yet. Approve it in the panel:");
  const flow = await runDeviceFlow({
    panelUrl: info.panelUrl,
    clientId: info.deviceClientId,
    onPrompt: (prompt) => {
      input.terminal.say("");
      input.terminal.say(`  Open   ${prompt.verificationUrlComplete ?? prompt.verificationUrl}`);
      input.terminal.say(`  Code   ${prompt.userCode}`);
      input.terminal.say("");
      input.terminal.say(`The code works for ${String(Math.round(prompt.expiresInMs / 60_000))} minutes. Waiting for approval...`);
    },
    ...input.deviceFlow,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!flow.ok) {
    return { reason: "device-flow", message: `Sign-in failed: ${flow.message}.` };
  }
  return { kind: "device-session", sessionToken: flow.sessionToken };
};

export const signIn = async (input: SignInInput): Promise<SignInResult> => {
  const { config, dataDir, terminal } = input;
  const now = input.now ?? Date.now;
  const loaded = await loadIdentity(dataDir);
  if (loaded.kind === "broken") {
    return fail(
      "broken-identity",
      `The runner's identity is damaged (${loaded.message}). Move ${dataPaths(dataDir).identityDir} aside and start the runner again to sign in afresh.`,
    );
  }
  if (loaded.kind === "found" && loaded.identity.record.serverUrl !== config.serverUrl) {
    return fail(
      "other-server",
      `This data folder belongs to runner ${loaded.identity.record.runnerId} of ${loaded.identity.record.serverUrl}. ` +
        `Use another --data-dir for ${config.serverUrl}.`,
    );
  }

  const infoResult = await fetchInfo(config.serverUrl, input.signal);
  if (!infoResult.ok) {
    if (infoResult.reason === "version") {
      await updateStatus(dataDir, {
        versionWindow: {
          protocolMajor: infoResult.info.protocolMajor,
          serverMinor: infoResult.info.serverMinor,
          min: infoResult.info.supported.min,
          max: infoResult.info.supported.max,
          serverVersion: infoResult.info.serverVersion,
        },
      });
      await recordRefusal(input, "version-unsupported", infoResult.fix);
      return fail("version-unsupported", infoResult.fix);
    }
    const message = `Can't read ${config.serverUrl}: ${describeFailure(infoResult.failure)}.`;
    return fail("unreachable", message);
  }
  const info = infoResult.info;
  if (info.serverVersion !== RUNNER_VERSION) {
    // An npm install pinned itself before this (`pin.ts`); the image and a checkout only say so.
    terminal.logger.info("this runner's version differs from the server's", { version: RUNNER_VERSION, serverVersion: info.serverVersion });
  }
  await updateStatus(dataDir, {
    versionWindow: {
      protocolMajor: info.protocolMajor,
      serverMinor: info.serverMinor,
      min: info.supported.min,
      max: info.supported.max,
      serverVersion: info.serverVersion,
    },
  });

  let identity: RunnerIdentity;
  if (loaded.kind === "found") {
    identity = loaded.identity;
  } else {
    const proof = await obtainProof(input, info);
    if (!("kind" in proof)) {
      return { ok: false, failure: proof };
    }
    const keyPair = await generateRunnerKeyPair();
    const name = config.name ?? os.hostname();
    const registered = await register({
      serverUrl: config.serverUrl,
      publicKey: keyPair.publicKey,
      name,
      executor: config.executor,
      capacity: hostSlots(config),
      labels: config.labels,
      proof,
    });
    if (!registered.ok) {
      const refused = proof.kind === "join-token" ? joinRefusalOf(registered.failure) : null;
      if (refused !== null) {
        // Milestone 5 (F-091): the reason, `expired`, `revoked` or `unknown`, and the fix.
        const message = `The pool's join token was refused (${refused}): ${joinRefusalWords[refused]}. Ask an admin for a new one in the panel, under Runners.`;
        await recordRefusal(input, "invalid-response", message);
        return fail("join-refused", message);
      }
      const message = `The server didn't register this runner: ${describeFailure(registered.failure)}.`;
      await recordRefusal(input, "invalid-response", message);
      return fail("invalid-response", message);
    }
    identity = {
      keyPair,
      record: {
        runnerId: registered.value.runnerId,
        serverUrl: config.serverUrl,
        kind: registered.value.kind,
        poolId: registered.value.poolId,
        name,
        registeredAt: now(),
      },
    };
    await saveIdentity(dataDir, identity);
    terminal.logger.info("runner registered", { runnerId: identity.record.runnerId, kind: identity.record.kind });
    terminal.say(`Signed in. This is runner ${identity.record.runnerId} (${identity.record.kind}).`);
  }

  const tokens = createAccessTokens({
    serverUrl: config.serverUrl,
    runnerId: identity.record.runnerId,
    keyPair: identity.keyPair,
    now,
  });
  const first = await tokens.get();
  if (!first.ok) {
    switch (first.reason) {
      case "revoked":
      case "unknown-key": {
        const message = `${first.message} ${signInAgainAdvice(dataDir)}`;
        await recordRefusal(input, first.reason, message);
        return fail(first.reason, message);
      }
      case "clock-skew":
      case "replayed":
      case "token-refused":
        // Not for good: the connection asks again with its backoff, and connects once the server
        // agrees. The identity is fine, so nothing here says to delete it.
        terminal.warn(first.message);
        await recordRefusal(input, first.reason, first.message);
        break;
      case "unreachable":
      case "invalid-response":
        return fail(first.reason, `Can't get an access token: ${first.message}.`);
      default:
        return first satisfies never;
    }
  }
  return { ok: true, value: { identity, info, tokens } };
};
