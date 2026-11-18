import assert from "node:assert/strict";
import { createResetLink } from "../ostra/admin-actions.ts";
import { expectRefused, signInWithEmail } from "./support.ts";
import { actorOf } from "./world.ts";
import type { World } from "./world.ts";

const NEW_PASSWORD = "a brand new passphrase 2026";

/**
 * Pass bar: "an admin's reset link". With no mail server, the instance admin
 * creates a one-time link for a member who forgot their password, and the
 * member follows it and chooses a new one.
 */
export const resetLinkScenario = async (world: World): Promise<string> => {
  const alice = actorOf(world, "alice");
  const bob = actorOf(world, "bob");
  const dave = actorOf(world, "dave");
  const redirectTo = `${world.server.url}/reset-password`;

  // Who may create one: the instance admin, and nobody else. An organization admin
  // (dave administers globex) could otherwise take over accounts that also live elsewhere.
  const byOrganizationAdmin = await createResetLink(world.auth, dave.headers, bob.userId, redirectTo);
  assert.deepEqual(byOrganizationAdmin, { ok: false, reason: "not-instance-admin" });
  const byMember = await createResetLink(world.auth, bob.headers, bob.userId, redirectTo);
  assert.deepEqual(byMember, { ok: false, reason: "not-instance-admin" });
  const anonymous = await createResetLink(world.auth, new Headers(), bob.userId, redirectTo);
  assert.deepEqual(anonymous, { ok: false, reason: "unauthenticated" });

  const created = await createResetLink(world.auth, alice.headers, bob.userId, redirectTo);
  assert.ok(created.ok, `the instance admin gets a link: ${JSON.stringify(created)}`);

  // The link is valid for a day: an admin pastes it into a chat, not an inbox.
  const token = new URL(created.url).pathname.split("/").at(-1);
  assert.ok(token !== undefined && token !== "");
  const pending = await world.prisma.verification.findFirst({
    where: { identifier: `reset-password:${token}` },
    select: { expiresAt: true },
  });
  assert.ok(pending !== null, "the token is stored server-side, one row");
  const hoursLeft = (pending.expiresAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursLeft > 23 && hoursLeft <= 24, `expires in about 24 hours, not ${hoursLeft.toFixed(1)}`);

  // bob follows the link in a browser: the server checks it and redirects to ostra's page with the token.
  const followed = await fetch(created.url, { redirect: "manual" });
  assert.equal(followed.status, 302);
  const location = followed.headers.get("location");
  assert.ok(location !== null);
  const landing = new URL(location);
  assert.equal(landing.origin + landing.pathname, redirectTo);
  const redeemedToken = landing.searchParams.get("token");
  assert.equal(redeemedToken, token, "the page receives the same token");

  // bob sets a new password.
  await world.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token: token } });

  // His old sessions are gone, his old password no longer works, the new one does.
  assert.equal(await world.auth.api.getSession({ headers: bob.headers }), null, "reset signs out every old session");
  await expectRefused(() => signInWithEmail(world.auth, bob));
  const renewed = await signInWithEmail(world.auth, { ...bob, password: NEW_PASSWORD });
  world.actors.set("bob", renewed);

  // One time only.
  await expectRefused(() => world.auth.api.resetPassword({ body: { newPassword: "another passphrase 99", token } }));
  const reused = await fetch(created.url, { redirect: "manual" });
  const reusedLocation = reused.headers.get("location");
  assert.ok(reusedLocation !== null && new URL(reusedLocation).searchParams.get("error") !== null, "the link now reports an error");
  assert.equal(new URL(reusedLocation).searchParams.get("token"), null);

  // Nobody else's password changed.
  await signInWithEmail(world.auth, alice);

  // A visitor who asks for a reset themselves gets nothing on an install without mail:
  // the callback has no sink to put a link in, so no link exists for anyone to read.
  // The answer is the same for an address that has an account and for one that has not,
  // so the request cannot be used to find out who has an account, and it carries no token or link.
  const forKnown = await world.auth.api.requestPasswordReset({ body: { email: bob.email, redirectTo } });
  const forUnknown = await world.auth.api.requestPasswordReset({
    body: { email: `nobody.${world.tag}@example.test`, redirectTo },
  });
  assert.equal(forKnown.status, true);
  assert.deepEqual(forKnown, forUnknown, "an address with an account and one without get the same answer");
  assert.deepEqual(
    Object.keys(forKnown).sort(),
    ["message", "status"],
    "the answer holds a status and a message, no link or token",
  );

  return "instance admin created a 24 h link; follow, set a password, old sessions revoked, link single-use; org admins and members cannot create one";
};
