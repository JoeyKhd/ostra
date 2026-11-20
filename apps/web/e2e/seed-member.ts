// One member of the install's first organization, who isn't an admin, with the given password (ticket
// 45: the notification choices are a member's own). The throwaway e2e database only. Run as
// `node e2e/seed-member.ts '<json>'`; prints one JSON line. Seeding a username twice keeps the first.

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), username: z.string().regex(/^[a-z0-9-]{1,40}$/), password: z.string().min(1) }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);
const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: args.username, email: `${args.username}@example.com`, password: args.password, role: "member" });
if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${args.username} failed: ${seeded.error}`);
process.stdout.write(`${JSON.stringify({ username: args.username })}\n`);
await db.$disconnect();
