import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
import { RUNNER_CLIENT_ID } from "../auth/create-auth.ts";
import { browserHeaders, send as sendRequest } from "./http.ts";
import type { Reply, RequestOptions } from "./http.ts";
import { actorOf } from "./world.ts";
import type { World } from "./world.ts";

// The runner is a separate program: it talks to the server over HTTP, with no
// cookie. This scenario plays the runner with `fetch` and validates every
// response with Zod, as the real runner will (they are external data).

const RUNNER_USER_AGENT = "ostra-runner/0.0.0 (spike)";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const deviceCodeSchema = z
  .object({
    device_code: z.string().min(20),
    user_code: z.string().min(6),
    verification_uri: z.string().min(1),
    verification_uri_complete: z.string().min(1),
    expires_in: z.number().int().positive(),
    interval: z.number().int().positive(),
  })
  .loose();

const tokenSchema = z
  .object({
    access_token: z.string().min(10),
    token_type: z.string(),
    expires_in: z.number().positive(),
  })
  .loose();

const verificationSchema = z
  .object({
    user_code: z.string(),
    status: z.string(),
    client_id: z.string().optional(),
    scope: z.string().optional(),
  })
  .loose();

const oauthErrorSchema = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .loose();

const sessionSchema = z
  .object({ user: z.object({ id: z.string(), username: z.string().nullish() }).loose() })
  .loose()
  .nullable();

const organizationListSchema = z.array(z.object({ id: z.string() }).loose());

/** The runner is its own client: whatever else it sends, it says who it is. */
const send = (base: string, path: string, init: RequestOptions): Promise<Reply> =>
  sendRequest(base, path, { ...init, headers: { "user-agent": RUNNER_USER_AGENT, ...init.headers } });

const requestCode = async (world: World, clientId: string): Promise<Reply> =>
  send(world.server.url, "/device/code", {
    method: "POST",
    body: { client_id: clientId, scope: "runner" },
  });

const pollToken = (world: World, deviceCode: string, clientId = RUNNER_CLIENT_ID): Promise<Reply> =>
  send(world.server.url, "/device/token", {
    method: "POST",
    body: { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: clientId },
  });

const errorOf = (reply: Reply): string => {
  const parsed = oauthErrorSchema.safeParse(reply.body);
  return parsed.success ? parsed.data.error : `unparsed (status ${String(reply.status)})`;
};

/**
 * Pass bar: "a device-code sign-in for a personal runner" (RFC 8628). The runner
 * asks for a code and prints it; the member approves it in the panel; the runner
 * polls and ends up holding a session of the member's.
 */
export const deviceCodeScenario = async (world: World): Promise<string> => {
  const dave = actorOf(world, "dave");
  const daveCookie = dave.headers.get("cookie");
  assert.ok(daveCookie !== null);

  // 1. The runner asks for a code.
  const issued = await requestCode(world, RUNNER_CLIENT_ID);
  assert.equal(issued.status, 200);
  const code = deviceCodeSchema.parse(issued.body);
  assert.ok(code.verification_uri_complete.includes(code.user_code), "the link carries the code, so a click is enough");
  assert.ok(code.expires_in <= 600, "codes live ten minutes");

  // 2. While nobody has approved, the runner is told to wait. Polling faster than allowed is told to slow down.
  const waiting = await pollToken(world, code.device_code);
  assert.equal(waiting.status, 400);
  assert.equal(errorOf(waiting), "authorization_pending");
  const tooFast = await pollToken(world, code.device_code);
  assert.equal(errorOf(tooFast), "slow_down");
  await sleep((code.interval * 1000) + 200);

  // 3. Someone without a session cannot approve.
  const anonymous = await send(world.server.url, "/device/approve", {
    method: "POST",
    body: { userCode: code.user_code },
    headers: browserHeaders(world, null),
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await pollToken(world, code.device_code)).status, 400, "still pending after the refused approval");
  await sleep((code.interval * 1000) + 200);

  // 4. The member opens the verification link in the panel. Opening it while signed in claims the
  // code for them: it shows what is asking, and from then on only they can approve or deny it.
  const dropIn = await send(world.server.url, `/device?user_code=${encodeURIComponent(code.user_code)}`, {
    method: "GET",
    headers: browserHeaders(world, null),
  });
  assert.equal(dropIn.status, 200);
  const unclaimedView = verificationSchema.parse(dropIn.body);
  assert.equal(unclaimedView.status, "pending");
  assert.equal(unclaimedView.client_id, undefined, "someone not signed in is not told what is asking");

  const carol = actorOf(world, "carol");
  const carolCookie = carol.headers.get("cookie");
  assert.ok(carolCookie !== null);
  const beforeClaim = await send(world.server.url, "/device/approve", {
    method: "POST",
    body: { userCode: code.user_code },
    headers: browserHeaders(world, carolCookie),
  });
  assert.equal(beforeClaim.status, 400, "a code nobody has claimed cannot be approved");

  const claim = await send(world.server.url, `/device?user_code=${encodeURIComponent(code.user_code)}`, {
    method: "GET",
    headers: browserHeaders(world, daveCookie),
  });
  assert.equal(claim.status, 200);
  const claimed = verificationSchema.parse(claim.body);
  assert.equal(claimed.client_id, RUNNER_CLIENT_ID, "the claimant is shown which client is asking");
  assert.equal(claimed.scope, "runner");

  // Another signed-in member cannot approve a code dave claimed, even holding the user code.
  const hijack = await send(world.server.url, "/device/approve", {
    method: "POST",
    body: { userCode: code.user_code },
    headers: browserHeaders(world, carolCookie),
  });
  assert.equal(hijack.status, 403, "only the member who claimed a code can approve it");

  // The claimant approves it.
  const approved = await send(world.server.url, "/device/approve", {
    method: "POST",
    body: { userCode: code.user_code },
    headers: browserHeaders(world, daveCookie),
  });
  assert.equal(approved.status, 200, `approve answered ${JSON.stringify(approved.body)}`);

  // 5. The runner's next poll gets a token.
  const granted = await pollToken(world, code.device_code);
  assert.equal(granted.status, 200, `token answered ${JSON.stringify(granted.body)}`);
  const token = tokenSchema.parse(granted.body);

  // 6. The token is a session of the member who approved, usable as a bearer token.
  const identity = await send(world.server.url, "/get-session", {
    method: "GET",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(identity.status, 200);
  const session = sessionSchema.parse(identity.body);
  assert.equal(session?.user.id, dave.userId, "the runner acts as the member who approved it");
  assert.equal(session.user.username, dave.username);

  // ostra's own server resolves a runner exactly as it resolves a browser: auth.api.getSession on the headers.
  const inProcess = await world.auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token.access_token}` }),
  });
  assert.equal(inProcess?.user.id, dave.userId, "the same server-side call identifies a runner by its bearer token");

  // It is a full session. Whatever the member can do in the panel, the runner's token can do.
  // (A finding for ostra to decide on; recorded here as today's behaviour.)
  const organizations = await send(world.server.url, "/organization/list", {
    method: "GET",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(organizations.status, 200);
  assert.equal(organizationListSchema.parse(organizations.body).length >= 2, true, "it sees both of dave's organizations");

  // The member can tell the runner's session from their browser's by the user agent it sent,
  // and can revoke it from the panel.
  const sessions = await world.auth.api.listSessions({ headers: dave.headers });
  const runnerSession = sessions.find((entry) => entry.userAgent?.startsWith("ostra-runner/") === true);
  assert.ok(runnerSession !== undefined, "the session list shows the runner by its user agent");
  await world.auth.api.revokeSession({ body: { token: runnerSession.token }, headers: dave.headers });
  const afterRevoke = await send(world.server.url, "/get-session", {
    method: "GET",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(sessionSchema.parse(afterRevoke.body), null, "revoking in the panel cuts the runner off");

  // 7. A code is worth one token.
  assert.equal(errorOf(await pollToken(world, code.device_code)), "invalid_grant");

  // 8. The member can refuse a code.
  const denied = await requestCode(world, RUNNER_CLIENT_ID);
  const deniedCode = deviceCodeSchema.parse(denied.body);
  await send(world.server.url, `/device?user_code=${encodeURIComponent(deniedCode.user_code)}`, {
    method: "GET",
    headers: browserHeaders(world, daveCookie),
  });
  const refusal = await send(world.server.url, "/device/deny", {
    method: "POST",
    body: { userCode: deniedCode.user_code },
    headers: browserHeaders(world, daveCookie),
  });
  assert.equal(refusal.status, 200);
  assert.equal(errorOf(await pollToken(world, deniedCode.device_code)), "access_denied");

  // 9. Only ostra's own runner client may ask for a code.
  const strangerClient = await requestCode(world, "some-other-tool");
  assert.equal(strangerClient.status, 400);
  assert.equal(errorOf(strangerClient), "invalid_client");

  // 10. An unknown device code, and an expired one, give nothing.
  assert.equal(errorOf(await pollToken(world, "x".repeat(40))), "invalid_grant");
  const stale = deviceCodeSchema.parse((await requestCode(world, RUNNER_CLIENT_ID)).body);
  await world.prisma.deviceCode.updateMany({
    where: { deviceCode: stale.device_code },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(errorOf(await pollToken(world, stale.device_code)), "expired_token");

  return "runner asked for a code, member approved it, runner got a bearer session of that member; pending, slow_down, deny, expiry, reuse and foreign clients all refused; revocable from the panel";
};
