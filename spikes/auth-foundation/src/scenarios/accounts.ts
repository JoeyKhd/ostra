import assert from "node:assert/strict";
import { signInWithEmail, signInWithUsername, expectRefused, signUp } from "./support.ts";
import type { AccountSpec } from "./support.ts";
import { accountSpec, actorOf } from "./world.ts";
import type { World } from "./world.ts";

/**
 * Pass bar: "sign up". The first account on an empty install, by username and
 * email and password, with no mail server in the picture.
 */
export const signUpScenario = async (world: World): Promise<string> => {
  const spec = accountSpec(world, "alice");

  // Q54: every account has a username. Refused before anything is written.
  const withoutUsername = await expectRefused(() =>
    world.auth.api.signUpEmail({ body: { name: "alice", email: spec.email, password: spec.password } }),
  );
  assert.equal(withoutUsername.code, "USERNAME_REQUIRED");
  assert.equal(await world.prisma.user.count(), 0, "a refused sign-up must leave no account behind");

  // A username that looks like an email address would make "sign in with either" ambiguous.
  const emailShaped = await expectRefused(() =>
    world.auth.api.signUpEmail({
      body: { name: "alice", email: spec.email, password: spec.password, username: "alice@home" },
    }),
  );
  assert.equal(emailShaped.status, 400, "an email-shaped username is a validation error");
  assert.equal(await world.prisma.user.count(), 0);

  const alice = await signUp(world.auth, spec);
  world.actors.set("alice", alice);

  const session = await world.auth.api.getSession({ headers: alice.headers });
  assert.ok(session !== null, "sign-up signs the new account in");
  assert.equal(session.user.id, alice.userId);
  assert.equal(session.user.email, spec.email);
  assert.equal(session.user.username, spec.username, "the username is stored normalised (lower case)");
  assert.equal(session.user.emailVerified, false, "with no mail server, nothing is verified, and nothing blocks sign-in");

  // The password is stored as a hash, never as typed.
  const credential = await world.prisma.account.findFirst({
    where: { userId: alice.userId, providerId: "credential" },
    select: { password: true },
  });
  assert.ok(credential?.password !== null && credential?.password !== undefined);
  assert.notEqual(credential.password, spec.password);
  assert.ok(credential.password.length > 40, "a salted hash, not a short value");

  return `account ${spec.username} created, signed in on sign-up, session read back, password hashed`;
};

/** Pass bar: "sign in by username and by email". One login field, either name. */
export const signInScenario = async (world: World): Promise<string> => {
  const alice = actorOf(world, "alice");

  // The login form has one field. An "@" can only be an email, since a username cannot contain one.
  const identify = (identifier: string, spec: AccountSpec) =>
    identifier.includes("@")
      ? signInWithEmail(world.auth, { ...spec, email: identifier })
      : signInWithUsername(world.auth, { ...spec, username: identifier });

  const byEmail = await identify(alice.email.toUpperCase(), alice);
  const byUsername = await identify(alice.username.toUpperCase(), alice);
  assert.equal(byEmail.userId, alice.userId);
  assert.equal(byUsername.userId, alice.userId, "both names reach the same account, in any case");
  assert.notEqual(byEmail.headers.get("cookie"), byUsername.headers.get("cookie"), "each sign-in is its own session");

  for (const actor of [byEmail, byUsername]) {
    const session = await world.auth.api.getSession({ headers: actor.headers });
    assert.equal(session?.user.id, alice.userId);
  }

  // A wrong password and an unknown name are the same answer: no way to probe which accounts exist.
  const wrongByEmail = await expectRefused(() =>
    signInWithEmail(world.auth, { ...alice, password: "not the password at all" }),
  );
  const unknownEmail = await expectRefused(() =>
    signInWithEmail(world.auth, { ...alice, email: `nobody.${world.tag}@example.test` }),
  );
  assert.equal(wrongByEmail.status, 401);
  assert.deepEqual(unknownEmail, wrongByEmail, "unknown email answers exactly as a wrong password does");

  const wrongByUsername = await expectRefused(() =>
    signInWithUsername(world.auth, { ...alice, password: "not the password at all" }),
  );
  const unknownUsername = await expectRefused(() =>
    signInWithUsername(world.auth, { ...alice, username: `nobody_${world.tag}` }),
  );
  assert.equal(wrongByUsername.status, 401);
  assert.deepEqual(unknownUsername, wrongByUsername, "unknown username answers exactly as a wrong password does");

  // Signing out ends that session and only that one.
  await world.auth.api.signOut({ headers: byEmail.headers });
  assert.equal(await world.auth.api.getSession({ headers: byEmail.headers }), null);
  const stillIn = await world.auth.api.getSession({ headers: byUsername.headers });
  assert.equal(stillIn?.user.id, alice.userId);

  return "sign-in by email and by username (either case) reach one account; wrong password and unknown name are indistinguishable; sign-out ends one session";
};
