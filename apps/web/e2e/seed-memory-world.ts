// What the Memory spec needs (F-109, F-111, ticket 38): a project, a second member (Sam, who saves
// first in the stale-save case), a task, a note written by the admin, and an agent's proposal from
// the task that says it contradicts that note. The throwaway e2e database only.
// Run as `node e2e/seed-memory-world.ts '<json>'` to seed, or with `"bump": "<noteId>"` to save the
// note's next version as Sam, as `saveNote` would. Prints one JSON line.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), bump: z.string().optional() }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const PROJECT = "memory-calc";

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: "mem-sam", email: "mem-sam@example.com", password: args.password, role: "member" });
const samId = seeded.ok ? seeded.seeded.memberId : ((await db.user.findFirstOrThrow({ where: { username: "mem-sam" }, select: { members: { select: { id: true } } } })).members[0]?.id ?? "");

if (args.bump !== undefined) {
  // Sam saves the note's next version while the admin is editing it.
  const note = await db.memoryNote.findUniqueOrThrow({ where: { id: args.bump } });
  const version = note.version + 1;
  await db.$transaction([
    db.memoryNote.update({ where: { id: note.id }, data: { version, body: `${note.body}\nSam's line.` } }),
    db.memoryNoteVersion.create({ data: { organizationId, noteId: note.id, version, title: note.title, body: `${note.body}\nSam's line.`, kind: note.kind, always: note.always, editedByMemberId: samId } }),
  ]);
  process.stdout.write(`${JSON.stringify({ version })}\n`);
} else {
  const old = await db.project.findFirst({ where: { organizationId, slug: PROJECT } });
  if (old !== null) {
    await db.memoryProposal.deleteMany({ where: { organizationId, projectId: old.id } });
    await db.memoryNote.deleteMany({ where: { organizationId, projectId: old.id } });
    await db.project.delete({ where: { id: old.id } });
  }
  const project = await db.project.create({ data: { organizationId, name: PROJECT, slug: PROJECT, access: "open" } });
  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title: "Rename the releaseName key",
      prompt: "Rename the releaseName key",
      branchName: `ostra/${randomUUID().slice(0, 8)}-rename`,
      state: "needs_you",
      needsYouReason: "no_changes",
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  const note = await db.memoryNote.create({
    data: { organizationId, projectId: project.id, scope: "project", title: "Settings keys use camelCase", body: "New keys in `config/settings.json` are camelCase, like releaseName.", kind: "convention", sourceKind: "member", authorMemberId: admin.id },
  });
  await db.memoryNoteVersion.create({ data: { organizationId, noteId: note.id, version: 1, title: note.title, body: note.body, kind: note.kind, always: false, editedByMemberId: admin.id } });
  const proposal = await db.memoryProposal.create({
    data: {
      organizationId,
      projectId: project.id,
      scope: "project",
      title: "Settings keys are single lowercase words",
      body: "Keys in `config/settings.json` are single lowercase words: release, not releaseName.",
      kind: "convention",
      sourceKind: "agent",
      taskId: task.id,
      relatesToNoteId: note.id,
      relation: "contradicts",
    },
  });
  process.stdout.write(`${JSON.stringify({ projectId: project.id, taskId: task.id, noteId: note.id, proposalId: proposal.id })}\n`);
}
await db.$disconnect();
