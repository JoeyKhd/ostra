import { z } from "zod";
import { callJson, describeFailure, joinUrl } from "./http.ts";

// The device flow (RFC 8628) against the panel's better-auth, for a personal runner's first
// sign-in (ADR 0029 as amended, Q115). The runner asks for a code, prints it with the panel's
// `/device` address, and polls until the member approves it. What it gets is a session of that
// member, used once as the bearer of `POST /runner/v1/register` and then forgotten: the server
// revokes it. The session token and the device code are never printed or logged.
//
// Ported from spikes/auth-foundation/src/scenarios/device-code.ts (the runner's side of it).

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The scope the panel's better-auth grants a runner's device code. */
export const RUNNER_DEVICE_SCOPE = "runner";
/** RFC 8628, section 3.5: each `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_STEP_MS = 5_000;

export const devicePaths = {
  code: "/api/auth/device/code",
  token: "/api/auth/device/token",
  approve: "/device",
} as const;

// better-auth's answers: a vendor's format, so unknown fields are tolerated.
const deviceCodeSchema = z.looseObject({
  device_code: z.string().min(8),
  user_code: z.string().min(4).max(64),
  verification_uri: z.string().min(1).optional(),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});

const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
});

const oauthErrorSchema = z.looseObject({ error: z.string() });

export type DeviceFlowPrompt = {
  /** The code the member types, or sees, in the panel. */
  readonly userCode: string;
  /** The panel's `/device` page. */
  readonly verificationUrl: string;
  /** The same page with the code filled in, when the panel gives one. */
  readonly verificationUrlComplete: string | null;
  readonly expiresInMs: number;
};

export type DeviceFlowResult =
  | { readonly ok: true; readonly sessionToken: string }
  | {
      readonly ok: false;
      readonly reason: "denied" | "expired" | "refused" | "unreachable" | "aborted";
      readonly message: string;
    };

export type DeviceFlowInput = {
  readonly panelUrl: string;
  readonly clientId: string;
  /** Called once the code is issued, to show it. */
  readonly onPrompt: (prompt: DeviceFlowPrompt) => void;
  /** Waits; a test passes one that doesn't. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const absolute = (panelUrl: string, uri: string | undefined): string | null => {
  if (uri === undefined) {
    return null;
  }
  try {
    return new URL(uri, `${panelUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return null;
  }
};

const EXPIRED = "the code expired before it was approved; start the runner again";

export const runDeviceFlow = async (input: DeviceFlowInput): Promise<DeviceFlowResult> => {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const issued = await callJson({
    url: joinUrl(input.panelUrl, devicePaths.code),
    method: "POST",
    schema: deviceCodeSchema,
    body: { client_id: input.clientId, scope: RUNNER_DEVICE_SCOPE },
    ...signal,
  });
  if (!issued.ok) {
    return {
      ok: false,
      reason: issued.failure.kind === "network" ? "unreachable" : "refused",
      message: `the panel didn't issue a device code: ${describeFailure(issued.failure)}`,
    };
  }
  const code = issued.value;
  const expiresAt = now() + code.expires_in * 1000;
  input.onPrompt({
    userCode: code.user_code,
    verificationUrl: absolute(input.panelUrl, code.verification_uri) ?? joinUrl(input.panelUrl, devicePaths.approve),
    verificationUrlComplete: absolute(input.panelUrl, code.verification_uri_complete),
    expiresInMs: code.expires_in * 1000,
  });
  let intervalMs = (code.interval ?? 5) * 1000;
  for (;;) {
    await sleep(intervalMs);
    if (input.signal?.aborted === true) {
      return { ok: false, reason: "aborted", message: "the sign-in was cancelled" };
    }
    if (now() >= expiresAt) {
      return { ok: false, reason: "expired", message: EXPIRED };
    }
    const polled = await callJson({
      url: joinUrl(input.panelUrl, devicePaths.token),
      method: "POST",
      schema: tokenSchema,
      body: { grant_type: GRANT_TYPE, device_code: code.device_code, client_id: input.clientId },
      ...signal,
    });
    if (polled.ok) {
      return { ok: true, sessionToken: polled.value.access_token };
    }
    const failure = polled.failure;
    if (failure.kind === "network") {
      // A blip while waiting for the member: keep polling until the code expires.
      continue;
    }
    const oauth = failure.kind === "refused" ? oauthErrorSchema.safeParse(failure.body) : undefined;
    const error = oauth?.success === true ? oauth.data.error : null;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalMs += SLOW_DOWN_STEP_MS;
      continue;
    }
    if (error === "access_denied") {
      return { ok: false, reason: "denied", message: "the code was denied in the panel" };
    }
    if (error === "expired_token") {
      return { ok: false, reason: "expired", message: EXPIRED };
    }
    return { ok: false, reason: "refused", message: `the panel refused the device code: ${error ?? describeFailure(failure)}` };
  }
};
