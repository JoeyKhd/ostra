import assert from "node:assert/strict";
import * as z from "zod";
import { INVITATION_HEADER, createAuth } from "../auth/create-auth.ts";
import { InvitationId, OrganizationId, UserId } from "../ids.ts";
import { buildInviteLink, parseInviteLink } from "../ostra/admin-actions.ts";
import { browserHeaders, send } from "./http.ts";
import { cookieHeaderFrom, expectRefused, signUp } from "./support.ts";
import type { Actor } from "./support.ts";
import { accountSpec, actorOf, organizationOf } from "./world.ts";
import type { World } from "./world.ts";

const signUpReplySchema = z.object({ user: z.object({ id: z.string() }).loose() }).loose();
const acceptReplySchema = z
  .object({ member: z.object({ role: z.string(), organizationId: z.string() }).loose() })
  .loose();

export const createOrganization = async (world: World, owner: Actor, key: string): Promise<OrganizationId> => {
  const created = await world.auth.api.createOrganization({
    body: { name: `${key} ${world.tag}`, slug: `${key}-${world.tag}` },
    headers: owner.headers,
  });
  const id = OrganizationId.parse(created.id);
  world.organizations.set(key, id);
  const creator = created.members.find((member) => member?.userId === owner.userId);
  assert.equal(creator?.role, "admin", "the creator of an organization is its admin (there is no owner role)");
  return id;
};

/** Invites `email` and returns the copyable link. No mail is sent: there is no mail server. */
export const inviteByLink = async (
  world: World,
  inviter: Actor,
  organizationId: OrganizationId,
  email: string,
  role: "admin" | "member",
): Promise<{ readonly invitationId: InvitationId; readonly link: string }> => {
  const invitation = await world.auth.api.createInvitation({
    body: { email, role, organizationId },
    headers: inviter.headers,
  });
  assert.equal(invitation.status, "pending");
  assert.equal(invitation.role, role);
  const invitationId = InvitationId.parse(invitation.id);
  const link = buildInviteLink(world.server.url, invitationId);
  assert.equal(parseInviteLink(link), invitationId, "the link carries the invitation ID and nothing else is needed");
  return { invitationId, link };
};

/** A new member follows an invite link: signs up with the invited email and the link's ID, then accepts. */
export const joinThroughLink = async (
  world: World,
  key: string,
  organizationId: OrganizationId,
  role: "admin" | "member",
  inviter: Actor,
): Promise<Actor> => {
  const spec = accountSpec(world, key);
  const { invitationId } = await inviteByLink(world, inviter, organizationId, spec.email, role);
  const account = await signUp(world.auth, spec, invitationId);
  const accepted = await world.auth.api.acceptInvitation({
    body: { invitationId },
    headers: account.headers,
  });
  assert.equal(accepted.member.role, role);
  world.actors.set(key, account);
  return account;
};

/**
 * Pass bar: "an invite link with no mail server". An admin invites by email
 * address, copies the link, and the invitee signs up and joins through it.
 */
export const inviteLinkScenario = async (world: World): Promise<string> => {
  const alice = actorOf(world, "alice");
  const acme = await createOrganization(world, alice, "acme");

  // Only the roles ADR 0026 names exist. better-auth alone would accept "owner" here (it knows the name
  // from its defaults); ostra's organization hooks refuse it.
  const ownerInvite = await expectRefused(() =>
    world.auth.api.createInvitation({
      // @ts-expect-error "owner" is not an ostra role, so the call is typed to refuse it; this proves the server does too
      body: { email: `owner.${world.tag}@example.test`, role: "owner", organizationId: acme },
      headers: alice.headers,
    }),
  );
  assert.equal(ownerInvite.status, 400);
  assert.equal(ownerInvite.code, "ROLE_NOT_FOUND", "refused by ostra's hook, not by the library");

  const bobSpec = accountSpec(world, "bob");

  // A stranger (no invitation for their email) cannot create an account on this install.
  const stranger = await expectRefused(() => signUp(world.auth, accountSpec(world, "stranger")));
  assert.equal(stranger.code, "SIGN_UP_CLOSED");

  const { invitationId, link } = await inviteByLink(world, alice, acme, bobSpec.email, "member");
  const invitationRow = await world.prisma.invitation.findUnique({ where: { id: invitationId } });
  assert.ok(invitationRow !== null, "the invitation is stored");
  assert.equal(invitationRow.email, bobSpec.email);
  assert.equal(invitationRow.status, "pending");
  assert.ok(invitationRow.expiresAt.getTime() > Date.now() + 6 * 24 * 3600 * 1000, "valid for a week");

  // Knowing the invited address is not enough. With no mail server nothing proves the mailbox is the
  // stranger's to use, so the invitation ID (the secret in the link) is what admits a sign-up, and it
  // has to belong to the address that signs up.
  const emailOnly = await expectRefused(() => signUp(world.auth, bobSpec));
  assert.equal(emailOnly.code, "SIGN_UP_CLOSED", "a stranger who knows only the invited address is refused");
  const guessedId = await expectRefused(() => signUp(world.auth, bobSpec, InvitationId.parse(`guess-${world.tag}`)));
  assert.equal(guessedId.code, "SIGN_UP_CLOSED", "a made-up invitation ID is refused");
  const elsewhere = await inviteByLink(world, alice, acme, `other.${world.tag}@example.test`, "member");
  const borrowedId = await expectRefused(() => signUp(world.auth, bobSpec, elsewhere.invitationId));
  assert.equal(borrowedId.code, "SIGN_UP_CLOSED", "another address's invitation ID does not admit this address");
  await world.auth.api.cancelInvitation({ body: { invitationId: elsewhere.invitationId }, headers: alice.headers });
  assert.equal(
    await world.prisma.user.count({ where: { email: bobSpec.email } }),
    0,
    "none of the refused sign-ups left an account behind",
  );

  // Following the link: the sign-up page gets the invited email; an invitee still cannot take
  // another account's username or use a weak password.
  const takenUsername = await expectRefused(() =>
    signUp(world.auth, { ...bobSpec, username: actorOf(world, "alice").username.toUpperCase() }, invitationId),
  );
  assert.ok(takenUsername.status === 400 || takenUsername.status === 422 || takenUsername.status === 409);
  const weakPassword = await expectRefused(() => signUp(world.auth, { ...bobSpec, password: "short" }, invitationId));
  assert.equal(weakPassword.status, 400);

  // The panel's sign-up page reads the ID out of the pasted link and sends it with the sign-up.
  // That step runs over real HTTP, as the browser would make it.
  const linkedId = parseInviteLink(link);
  assert.ok(linkedId !== null, "the pasted link parses back to an invitation ID");
  const signedUp = await send(world.server.url, "/sign-up/email", {
    method: "POST",
    body: { name: bobSpec.key, email: bobSpec.email, password: bobSpec.password, username: bobSpec.username },
    headers: { ...browserHeaders(world, null), [INVITATION_HEADER]: linkedId },
  });
  assert.equal(signedUp.status, 200, `sign-up with the link's ID answered ${String(signedUp.status)}`);
  const bob: Actor = {
    ...bobSpec,
    userId: UserId.parse(signUpReplySchema.parse(signedUp.body).user.id),
    headers: cookieHeaderFrom(signedUp.headers),
  };
  world.actors.set("bob", bob);

  // Before accepting, bob belongs to nothing.
  const before = await world.auth.api.listOrganizations({ headers: bob.headers });
  assert.equal(before.length, 0);

  // Someone else cannot use bob's invitation, even with a valid session of their own.
  // (alice is already a member and is not the invited address.)
  const wrongRecipient = await expectRefused(() =>
    world.auth.api.acceptInvitation({ body: { invitationId }, headers: alice.headers }),
  );
  assert.ok(wrongRecipient.status === 403 || wrongRecipient.status === 400);

  // The accept step is the same HTTP call the panel's page would make once it has the ID from the link.
  const accepted = await send(world.server.url, "/organization/accept-invitation", {
    method: "POST",
    body: { invitationId: linkedId },
    headers: browserHeaders(world, bob.headers.get("cookie")),
  });
  assert.equal(accepted.status, 200, `accepting answered ${String(accepted.status)}`);
  const member = acceptReplySchema.parse(accepted.body).member;
  assert.equal(member.role, "member");
  assert.equal(member.organizationId, acme);

  const after = await world.auth.api.listOrganizations({ headers: bob.headers });
  assert.deepEqual(
    after.map((organization) => organization.id),
    [acme],
  );

  // A link works once.
  await expectRefused(() => world.auth.api.acceptInvitation({ body: { invitationId }, headers: bob.headers }));

  // Role: a member cannot invite. An admin can.
  await expectRefused(() =>
    world.auth.api.createInvitation({
      body: { email: `x.${world.tag}@example.test`, role: "member", organizationId: acme },
      headers: bob.headers,
    }),
  );

  // An invitation that has expired can neither admit a sign-up nor be accepted.
  const lateSpec = accountSpec(world, "late");
  const late = await inviteByLink(world, alice, acme, lateSpec.email, "member");
  await world.prisma.invitation.update({
    where: { id: late.invitationId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expired = await expectRefused(() => signUp(world.auth, lateSpec, late.invitationId));
  assert.equal(expired.code, "SIGN_UP_CLOSED");

  assert.ok(link.startsWith(`${world.server.url}/accept-invitation/`));
  return "invitation created by an admin and claimed by ID over HTTP (sign-up with the link's ID, then accept); the <panel>/accept-invitation/<id> link format is built and parsed back, the panel page that consumes it is not built; an address alone, a wrong ID and another address's ID are refused; single-use; expired and foreign invitations refused";
};

/**
 * Pass bar: "two organizations with one member in both". dave belongs to acme
 * as a member and to globex as an admin, with one account and two memberships.
 */
export const twoOrganizationsScenario = async (world: World): Promise<string> => {
  const alice = actorOf(world, "alice");
  const acme = organizationOf(world, "acme");
  const globex = await createOrganization(world, alice, "globex");

  // dave joins acme through a link, which also creates his account.
  const dave = await joinThroughLink(world, "dave", acme, "member", alice);
  // carol belongs to globex only.
  await joinThroughLink(world, "carol", globex, "member", alice);

  // Then globex invites dave's existing account, as an admin. No second account is made.
  const second = await inviteByLink(world, alice, globex, dave.email, "admin");
  const accepted = await world.auth.api.acceptInvitation({
    body: { invitationId: second.invitationId },
    headers: dave.headers,
  });
  assert.equal(accepted.member.role, "admin");

  assert.equal(await world.prisma.user.count({ where: { email: dave.email } }), 1, "one account");
  assert.equal(await world.prisma.member.count({ where: { userId: dave.userId } }), 2, "two memberships");

  const listed = await world.auth.api.listOrganizations({ headers: dave.headers });
  assert.deepEqual(new Set(listed.map((organization) => organization.id)), new Set([acme, globex]));

  // The same person has a different role in each, and switches between them.
  await world.auth.api.setActiveOrganization({ body: { organizationId: acme }, headers: dave.headers });
  const inAcme = await world.auth.api.getActiveMemberRole({ headers: dave.headers });
  assert.equal(inAcme.role, "member");
  assert.equal((await world.auth.api.getSession({ headers: dave.headers }))?.session.activeOrganizationId, acme);

  await world.auth.api.setActiveOrganization({ body: { organizationId: globex }, headers: dave.headers });
  const inGlobex = await world.auth.api.getActiveMemberRole({ headers: dave.headers });
  assert.equal(inGlobex.role, "admin");
  assert.equal((await world.auth.api.getSession({ headers: dave.headers }))?.session.activeOrganizationId, globex);

  // Permissions follow the organization, not the person.
  const mayInviteInAcme = await world.auth.api.hasPermission({
    body: { organizationId: acme, permissions: { invitation: ["create"] } },
    headers: dave.headers,
  });
  const mayInviteInGlobex = await world.auth.api.hasPermission({
    body: { organizationId: globex, permissions: { invitation: ["create"] } },
    headers: dave.headers,
  });
  assert.equal(mayInviteInAcme.success, false, "a member of acme cannot invite there");
  assert.equal(mayInviteInGlobex.success, true, "an admin of globex can invite there");
  await expectRefused(() =>
    world.auth.api.createInvitation({
      body: { email: `y.${world.tag}@example.test`, role: "member", organizationId: acme },
      headers: dave.headers,
    }),
  );

  // The database refuses a second membership of the same pair, whatever the library does.
  await assert.rejects(
    world.prisma.member.create({
      data: { id: `dup-${world.tag}`, organizationId: globex, userId: dave.userId, role: "member", createdAt: new Date() },
    }),
    "a duplicate (organization, user) membership is impossible",
  );

  return "dave: one account, two memberships (member of acme, admin of globex), role and permissions follow the active organization";
};

/**
 * ADR 0026 and Q102, beyond the pass bar: two roles at the organization level,
 * the instance admin as a separate thing, and who may create an organization.
 */
export const rolesScenario = async (world: World): Promise<string> => {
  const alice = actorOf(world, "alice");
  const bob = actorOf(world, "bob");
  const dave = actorOf(world, "dave");

  // The instance admin and an organization admin are different people with different reach.
  const asAlice = await world.auth.api.listUsers({ query: { limit: 50 }, headers: alice.headers });
  assert.ok(asAlice.total >= 4);
  await expectRefused(() => world.auth.api.listUsers({ query: { limit: 50 }, headers: dave.headers }));
  await expectRefused(() => world.auth.api.listUsers({ query: { limit: 50 }, headers: bob.headers }));
  assert.equal((await world.auth.api.getSession({ headers: dave.headers }))?.user.role, "user");

  // Q102: only the instance admin creates organizations, unless the install opens sign-up for them.
  const refused = await expectRefused(() =>
    world.auth.api.createOrganization({
      body: { name: `dave org ${world.tag}`, slug: `dave-org-${world.tag}` },
      headers: dave.headers,
    }),
  );
  assert.equal(refused.status, 403);

  const open = createAuth({
    prisma: world.prisma,
    baseURL: world.server.url,
    secret: world.secret,
    settings: { openOrganizationSignup: true, openAccountSignup: false },
    logLevel: "error",
  });
  const allowed = await open.api.createOrganization({
    body: { name: `dave org ${world.tag}`, slug: `dave-org-${world.tag}` },
    headers: dave.headers,
  });
  assert.equal(allowed.members[0]?.role, "admin");

  // An admin of one organization changes roles only inside it.
  const bobMembership = await world.prisma.member.findFirst({
    where: { userId: bob.userId, organizationId: organizationOf(world, "acme") },
    select: { id: true },
  });
  assert.ok(bobMembership !== null);
  await expectRefused(() =>
    world.auth.api.updateMemberRole({
      body: { memberId: bobMembership.id, role: "admin", organizationId: organizationOf(world, "acme") },
      headers: dave.headers,
    }),
  );
  await world.auth.api.updateMemberRole({
    body: { memberId: bobMembership.id, role: "admin", organizationId: organizationOf(world, "acme") },
    headers: alice.headers,
  });
  const promoted = await world.prisma.member.findUnique({ where: { id: bobMembership.id }, select: { role: true } });
  assert.equal(promoted?.role, "admin");
  await world.auth.api.updateMemberRole({
    body: { memberId: bobMembership.id, role: "member", organizationId: organizationOf(world, "acme") },
    headers: alice.headers,
  });

  return "two org roles (admin, member); instance admin is separate; org creation closed unless the install opens it; role changes stay inside one organization";
};
