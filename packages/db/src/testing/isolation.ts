import { randomUUID } from "node:crypto";

import type { Db } from "../client.ts";
import { mapMember, mapOrganization, mapProject } from "../mappers.ts";

// The isolation fixture (ticket 06, ADR 0026): two organizations, and in the first an open and a
// restricted project. Every later test that reads data seeds this and checks that the other
// organization's rows, and the restricted project's rows for a non-member, stay invisible.
// Modeled on spikes/auth-foundation's isolation test.

export type SeededMember = ReturnType<typeof mapMember>;
export type SeededOrganization = ReturnType<typeof mapOrganization>;
export type SeededProject = ReturnType<typeof mapProject>;

export type IsolationFixture = {
  /** The organization under test. */
  readonly a: {
    readonly organization: SeededOrganization;
    readonly admin: SeededMember;
    /** A member who is not on the restricted project. */
    readonly member: SeededMember;
    /** A member listed on the restricted project. */
    readonly insider: SeededMember;
    readonly openProject: SeededProject;
    readonly restrictedProject: SeededProject;
  };
  /** Another organization, whose rows organization A must never see. */
  readonly b: {
    readonly organization: SeededOrganization;
    readonly admin: SeededMember;
    readonly project: SeededProject;
  };
};

const seedAccount = async (db: Db, label: string) => {
  const suffix = randomUUID().slice(0, 8);
  return db.user.create({
    data: {
      id: randomUUID(),
      name: label,
      email: `${label}-${suffix}@example.com`,
      username: `${label}-${suffix}`,
    },
  });
};

const seedOrganization = async (db: Db, label: string) => {
  const organization = await db.organization.create({
    data: { id: randomUUID(), name: label, slug: `${label}-${randomUUID().slice(0, 8)}`, createdAt: new Date() },
  });
  return mapOrganization(organization);
};

const seedMember = async (db: Db, organizationId: string, label: string, role: "admin" | "member") => {
  const user = await seedAccount(db, label);
  const member = await db.member.create({
    data: { id: randomUUID(), organizationId, userId: user.id, role, createdAt: new Date() },
  });
  return mapMember(member);
};

const seedProject = async (db: Db, organizationId: string, name: string, access: "open" | "restricted") =>
  mapProject(
    await db.project.create({
      data: { organizationId, name, slug: `${name}-${randomUUID().slice(0, 8)}`, access },
    }),
  );

export const seedIsolationFixture = async (db: Db): Promise<IsolationFixture> => {
  const organizationA = await seedOrganization(db, "org-a");
  const organizationB = await seedOrganization(db, "org-b");
  const adminA = await seedMember(db, organizationA.id, "admin-a", "admin");
  const memberA = await seedMember(db, organizationA.id, "member-a", "member");
  const insiderA = await seedMember(db, organizationA.id, "insider-a", "member");
  const adminB = await seedMember(db, organizationB.id, "admin-b", "admin");
  const openProject = await seedProject(db, organizationA.id, "open", "open");
  const restrictedProject = await seedProject(db, organizationA.id, "restricted", "restricted");
  const projectB = await seedProject(db, organizationB.id, "other", "open");
  await db.projectMember.create({
    data: {
      organizationId: organizationA.id,
      projectId: restrictedProject.id,
      memberId: insiderA.id,
      role: "member",
    },
  });
  return {
    a: {
      organization: organizationA,
      admin: adminA,
      member: memberA,
      insider: insiderA,
      openProject,
      restrictedProject,
    },
    b: { organization: organizationB, admin: adminB, project: projectB },
  };
};
