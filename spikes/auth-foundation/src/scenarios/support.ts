import assert from "node:assert/strict";
import { isAPIError } from "better-auth/api";
import * as z from "zod";
import { INVITATION_HEADER } from "../auth/create-auth.ts";
import type { OstraAuth } from "../auth/create-auth.ts";
import { UserId } from "../ids.ts";
import type { InvitationId } from "../ids.ts";

// Helpers every scenario and the contract test share. A scenario is an async
// function that throws when its claim does not hold.

export type Actor = {
  readonly key: string;
  readonly userId: UserId;
  readonly email: string;
  readonly username: string;
  readonly password: string;
  /** Carries the session cookie, as a browser would. */
  readonly headers: Headers;
};

export type AccountSpec = {
  readonly key: string;
  readonly email: string;
  readonly username: string;
  readonly password: string;
};

/** Turns the `Set-Cookie` lines of a response into the `Cookie` header of the next request. */
export const cookieHeaderFrom = (responseHeaders: Headers): Headers => {
  const pairs = responseHeaders.getSetCookie().flatMap((line) => {
    const pair = line.split(";")[0]?.trim();
    return pair === undefined || pair === "" ? [] : [pair];
  });
  return new Headers({ cookie: pairs.join("; ") });
};

/**
 * Signs an account up. `invitationId` is what the panel's sign-up page sends after reading the
 * `/accept-invitation/<id>` link; an install that is not open to strangers refuses sign-up without it.
 */
export const signUp = async (
  auth: OstraAuth,
  spec: AccountSpec,
  invitationId?: InvitationId,
): Promise<Actor> => {
  const { headers, response } = await auth.api.signUpEmail({
    body: {
      name: spec.key,
      email: spec.email,
      password: spec.password,
      username: spec.username,
    },
    headers: invitationId === undefined ? new Headers() : new Headers({ [INVITATION_HEADER]: invitationId }),
    returnHeaders: true,
  });
  return {
    ...spec,
    userId: UserId.parse(response.user.id),
    headers: cookieHeaderFrom(headers),
  };
};

export const signInWithEmail = async (auth: OstraAuth, spec: AccountSpec): Promise<Actor> => {
  const { headers, response } = await auth.api.signInEmail({
    body: { email: spec.email, password: spec.password },
    returnHeaders: true,
  });
  return { ...spec, userId: UserId.parse(response.user.id), headers: cookieHeaderFrom(headers) };
};

export const signInWithUsername = async (auth: OstraAuth, spec: AccountSpec): Promise<Actor> => {
  const { headers, response } = await auth.api.signInUsername({
    body: { username: spec.username, password: spec.password },
    returnHeaders: true,
  });
  return { ...spec, userId: UserId.parse(response.user.id), headers: cookieHeaderFrom(headers) };
};

// ---- Errors ---------------------------------------------------------------

const apiErrorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() }).loose();

export type ApiFailure = {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string | undefined;
};

/** The HTTP status and error code of a better-auth failure, or `undefined` for any other error. */
export const apiFailureOf = (error: unknown): ApiFailure | undefined => {
  if (!isAPIError(error)) {
    return undefined;
  }
  const body = apiErrorBodySchema.safeParse(error.body);
  return {
    status: error.statusCode,
    code: body.success ? body.data.code : undefined,
    message: body.success ? body.data.message : undefined,
  };
};

/** Runs `work` and returns the failure it raised. Fails the scenario if it succeeded. */
export const failureOf = async (work: () => Promise<unknown>): Promise<ApiFailure> => {
  let raised: unknown;
  try {
    await work();
  } catch (error) {
    raised = error;
  }
  assert.notEqual(raised, undefined, "expected the call to be refused, but it succeeded");
  const failure = apiFailureOf(raised);
  assert.ok(failure !== undefined, `expected a better-auth error, got: ${String(raised)}`);
  return failure;
};

/** Asserts that `work` is refused with a 4xx status. Returns the failure for further checks. */
export const expectRefused = async (work: () => Promise<unknown>): Promise<ApiFailure> => {
  const failure = await failureOf(work);
  assert.ok(failure.status >= 400 && failure.status < 500, `expected a 4xx refusal, got ${String(failure.status)}`);
  return failure;
};

// ---- Names ----------------------------------------------------------------

/** A short random suffix, so a rerun against the same database never collides. */
export const runTag = (): string => Math.random().toString(36).slice(2, 8);

export const PASSWORD = "correct horse battery staple";
