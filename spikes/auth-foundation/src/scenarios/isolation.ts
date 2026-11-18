import assert from "node:assert/strict";
import { ProjectId } from "../ids.ts";
import type { OrganizationId } from "../ids.ts";
import { requireMember } from "../ostra/organization-scope.ts";
import type { MemberScope } from "../ostra/organization-scope.ts";
import { expectRefused } from "./support.ts";
import type { Actor } from "./support.ts";
import { inviteByLink, joinThroughLink } from "./organizations.ts";
import { actorOf, organizationOf } from "./world.ts";
import type { World } from "./world.ts";

/**
 * Pass bar: "A member of one organization can't read the other's rows."
 *
 * Two kinds of rows are probed: ostra's own (projects and tasks, read through a
 * MemberScope) and better-auth's (members, invitations, the organization itself,
 * read through its endpoints). Every probe is one a member of acme would try
 * against globex, and each must be refused or come back empty.
 */
export const isolationScenario = async (world: World): Promise<string> => {
  const deps = { auth: world.auth, prisma: world.prisma };
  const alice = actorOf(world, "alice");
  const bob = actorOf(world, "bob"); // member of acme only
  const carol = actorOf(world, "carol"); // member of globex only
  const dave = actorOf(world, "dave"); // acme member, globex admin
  const acme = organizationOf(world, "acme");
  const globex = organizationOf(world, "globex");
  let probes = 0;

  const scopeOf = async (actor: Actor, organizationId: OrganizationId): Promise<MemberScope> => {
    const result = await requireMember(deps, actor.headers, organizationId);
    assert.ok(result.ok, `${actor.key} should be a member of ${organizationId}: ${JSON.stringify(result)}`);
    return result.scope;
  };

  // ---- Seed: each organization has a project, tasks and a pending invitation ----
  const aliceInAcme = await scopeOf(alice, acme);
  const aliceInGlobex = await scopeOf(alice, globex);
  const acmeProject = await world.store.createProject(aliceInAcme, `acme-project-${world.tag}`);
  const globexProject = await world.store.createProject(aliceInGlobex, `globex-project-${world.tag}`);
  assert.ok(acmeProject.ok && globexProject.ok);
  const acmeProjectId = ProjectId.parse(acmeProject.value.id);
  const globexProjectId = ProjectId.parse(globexProject.value.id);

  const bobInAcme = await scopeOf(bob, acme);
  const carolInGlobex = await scopeOf(carol, globex);
  const acmeTask = await world.store.createTask(bobInAcme, acmeProjectId, "acme task");
  const globexTask = await world.store.createTask(carolInGlobex, globexProjectId, "globex task");
  assert.ok(acmeTask.ok && globexTask.ok, "a plain member may add tasks to their own organization");

  const globexInvitation = await inviteByLink(world, alice, globex, `pending.${world.tag}@example.test`, "member");
  const globexMembers = await world.prisma.member.findMany({ where: { organizationId: globex }, select: { id: true } });
  const carolMemberId = (await world.prisma.member.findFirst({ where: { userId: carol.userId, organizationId: globex } }))?.id;
  assert.ok(carolMemberId !== undefined);

  // ---- 1. The guard itself ----
  assert.equal((await requireMember(deps, bob.headers, acme)).ok, true);
  const bobInGlobex = await requireMember(deps, bob.headers, globex);
  assert.deepEqual(bobInGlobex, { ok: false, reason: "not-a-member" });
  const bobInNowhere = await requireMember(deps, bob.headers, "no-such-organization");
  assert.deepEqual(bobInNowhere, bobInGlobex, "an organization that does not exist answers like one that is not yours");
  assert.deepEqual(await requireMember(deps, new Headers(), acme), { ok: false, reason: "unauthenticated" });
  const carolInAcme = await requireMember(deps, carol.headers, acme);
  assert.deepEqual(carolInAcme, { ok: false, reason: "not-a-member" });
  probes += 4;

  // ---- 2. Reads through a scope see one organization ----
  const acmeProjects = await world.store.listProjects(bobInAcme);
  assert.deepEqual(acmeProjects.map((project) => project.id), [acmeProjectId]);
  const globexProjects = await world.store.listProjects(carolInGlobex);
  assert.deepEqual(globexProjects.map((project) => project.id), [globexProjectId]);
  const daveInAcme = await scopeOf(dave, acme);
  const daveInGlobex = await scopeOf(dave, globex);
  assert.deepEqual((await world.store.listProjects(daveInAcme)).map((project) => project.id), [acmeProjectId]);
  assert.deepEqual((await world.store.listProjects(daveInGlobex)).map((project) => project.id), [globexProjectId]);
  for (const scope of [bobInAcme, daveInAcme]) {
    const rows = await world.store.listTasks(scope);
    assert.ok(rows.every((task) => task.organizationId === acme), "tasks listed in acme are all acme's");
  }
  assert.equal((await world.store.listTasks(carolInGlobex)).length, 1);
  probes += 6;

  // ---- 3. Guessing another organization's row IDs from inside your own ----
  assert.equal(await world.store.getProject(bobInAcme, globexProjectId), null);
  const renamed = await world.store.renameProject(aliceInAcme, globexProjectId, "pwned");
  assert.deepEqual(renamed, { ok: false, reason: "not-found" });
  const deleted = await world.store.deleteProject(aliceInAcme, globexProjectId);
  assert.deepEqual(deleted, { ok: false, reason: "not-found" });
  const taskInForeignProject = await world.store.createTask(bobInAcme, globexProjectId, "smuggled");
  assert.deepEqual(taskInForeignProject, { ok: false, reason: "not-found" });
  const stillThere = await world.prisma.project.findUnique({ where: { id: globexProjectId } });
  assert.equal(stillThere?.name, `globex-project-${world.tag}`, "the foreign project is untouched");
  probes += 4;

  // Even code that skips the store cannot file a task under another organization's project:
  // the composite foreign key (projectId, organizationId) rejects it in the database.
  await assert.rejects(
    world.prisma.task.create({
      data: { title: "smuggled", organizationId: acme, projectId: globexProjectId },
    }),
    "the database refuses a task whose project belongs to another organization",
  );
  assert.equal(await world.prisma.task.count({ where: { title: "smuggled" } }), 0);
  probes += 1;

  // ---- 4. better-auth's own endpoints, asked about globex by a member of acme only ----
  const beforeName = (await world.prisma.organization.findUnique({ where: { id: globex } }))?.name;
  const beforeMembers = globexMembers.length;
  const beforeInvitations = await world.prisma.invitation.count({ where: { organizationId: globex } });

  await expectRefused(() => world.auth.api.getFullOrganization({ query: { organizationId: globex }, headers: bob.headers }));
  await expectRefused(() => world.auth.api.listMembers({ query: { organizationId: globex }, headers: bob.headers }));
  await expectRefused(() => world.auth.api.listInvitations({ query: { organizationId: globex }, headers: bob.headers }));
  await expectRefused(() => world.auth.api.getInvitation({ query: { id: globexInvitation.invitationId }, headers: bob.headers }));
  await expectRefused(() =>
    world.auth.api.createInvitation({
      body: { email: `intruder.${world.tag}@example.test`, role: "member", organizationId: globex },
      headers: bob.headers,
    }),
  );
  await expectRefused(() => world.auth.api.setActiveOrganization({ body: { organizationId: globex }, headers: bob.headers }));
  await expectRefused(() =>
    world.auth.api.updateOrganization({ body: { data: { name: "pwned" }, organizationId: globex }, headers: bob.headers }),
  );
  await expectRefused(() =>
    world.auth.api.updateMemberRole({ body: { memberId: carolMemberId, role: "admin", organizationId: globex }, headers: bob.headers }),
  );
  await expectRefused(() =>
    world.auth.api.removeMember({ body: { memberIdOrEmail: carol.email, organizationId: globex }, headers: bob.headers }),
  );
  await expectRefused(() => world.auth.api.deleteOrganization({ body: { organizationId: globex }, headers: bob.headers }));
  probes += 10;

  const permission = await world.auth.api
    .hasPermission({ body: { organizationId: globex, permissions: { invitation: ["create"] } }, headers: bob.headers })
    .then((result) => result.success, () => false);
  assert.equal(permission, false, "a non-member holds no permission in globex");
  probes += 1;

  // The same probes the other way round: carol (globex only) against acme.
  await expectRefused(() => world.auth.api.getFullOrganization({ query: { organizationId: acme }, headers: carol.headers }));
  await expectRefused(() => world.auth.api.listMembers({ query: { organizationId: acme }, headers: carol.headers }));
  await expectRefused(() => world.auth.api.setActiveOrganization({ body: { organizationId: acme }, headers: carol.headers }));
  probes += 3;

  // Nothing changed behind the refusals.
  assert.equal((await world.prisma.organization.findUnique({ where: { id: globex } }))?.name, beforeName);
  assert.equal(await world.prisma.member.count({ where: { organizationId: globex } }), beforeMembers);
  assert.equal(await world.prisma.invitation.count({ where: { organizationId: globex } }), beforeInvitations);
  assert.equal((await world.auth.api.getSession({ headers: bob.headers }))?.session.activeOrganizationId ?? null, null, "bob's active organization was not moved");

  // What a member does get back is their own organization only.
  const mine = await world.auth.api.listOrganizations({ headers: bob.headers });
  assert.deepEqual(mine.map((organization) => organization.id), [acme]);
  await world.auth.api.setActiveOrganization({ body: { organizationId: acme }, headers: bob.headers });
  const full = await world.auth.api.getFullOrganization({ headers: bob.headers });
  const serialised = JSON.stringify(full);
  assert.ok(!serialised.includes(globex), "acme's view mentions nothing of globex");
  assert.ok(!serialised.includes(carol.email) && !serialised.includes(carol.userId), "nor any globex-only member");
  probes += 3;

  // ---- 5. Membership is read on every request, never cached in the session ----
  const erin = await joinThroughLink(world, "erin", acme, "member", alice);
  await world.auth.api.setActiveOrganization({ body: { organizationId: acme }, headers: erin.headers });
  const erinInAcme = await scopeOf(erin, acme);
  assert.deepEqual((await world.store.listProjects(erinInAcme)).map((project) => project.id), [acmeProjectId]);
  await world.auth.api.removeMember({ body: { memberIdOrEmail: erin.email, organizationId: acme }, headers: alice.headers });
  const sessionAfter = await world.auth.api.getSession({ headers: erin.headers });
  assert.ok(sessionAfter !== null, "erin's account and session survive her removal from acme");
  assert.deepEqual(
    await requireMember(deps, erin.headers, acme),
    { ok: false, reason: "not-a-member" },
    "but her next request into acme is refused, with no wait for a session to expire",
  );
  probes += 1;

  return `${String(probes)} cross-organization probes (guard, scoped reads, guessed IDs, composite FK, better-auth endpoints both ways, removal) refused or empty`;
};
