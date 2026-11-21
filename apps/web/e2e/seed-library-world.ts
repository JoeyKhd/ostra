// Milestone 8 (F-145, F-146, ticket 31): the library spec's own people, in the e2e database: an
// organization admin and a member who isn't one, each with the spec's password, and the
// organization's first agent profile to attach to. Run as `node e2e/seed-library-world.ts '<json>'`;
// prints one JSON line.

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), tag: z.string().regex(/^[a-z0-9-]{1,24}$/) }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const username = `library-${args.tag}`;
const admin = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "admin" });
if (!admin.ok) throw new Error(`seeding ${username} failed: ${admin.error}`);
const memberUsername = `${username}-m`;
const member = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: memberUsername, email: `${memberUsername}@example.com`, password: args.password, role: "member" });
if (!member.ok) throw new Error(`seeding ${memberUsername} failed: ${member.error}`);
const { organizationId } = await db.member.findUniqueOrThrow({ where: { id: admin.seeded.memberId }, select: { organizationId: true } });
const profile =
  (await db.agentProfile.findFirst({ where: { organizationId, archivedAt: null, builtInKind: null }, orderBy: { createdAt: "asc" } })) ??
  (await db.agentProfile.create({ data: { organizationId, name: `library-profile-${args.tag}`, adapter: "opencode" } }));

process.stdout.write(`${JSON.stringify({ username, memberUsername, profileId: profile.id, profileName: profile.name })}\n`);
await db.$disconnect();
