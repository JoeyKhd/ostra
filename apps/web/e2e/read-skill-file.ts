// Reads what the database holds for one profile's skill files, for the browser check that a file
// uploaded in the skill Sheet reached core's blob store (ticket 42): the throwaway e2e database only.
// Run as `node e2e/read-skill-file.ts '<json>'`; prints one JSON line of IDs, sizes and digests,
// never a file's bytes.

import { createDb } from "@ostra/db";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string(), profileName: z.string() });

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const profile = await db.agentProfile.findFirstOrThrow({ where: { name: args.profileName }, select: { id: true, skills: { select: { name: true, files: true } } } });
const fileSchema = z.array(z.object({ path: z.string(), blobId: z.string() }));
const skills = [];
for (const skill of profile.skills) {
  const files = [];
  for (const file of fileSchema.parse(skill.files)) {
    const blob = await db.blob.findUnique({ where: { id: file.blobId }, select: { purpose: true, size: true, sha256: true, store: true, taskId: true, projectId: true, organizationId: true } });
    files.push({ path: file.path, blob });
  }
  skills.push({ name: skill.name, files });
}
process.stdout.write(`${JSON.stringify({ skills })}\n`);
await db.$disconnect();
