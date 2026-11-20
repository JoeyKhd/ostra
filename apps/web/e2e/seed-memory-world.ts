// What the Memory spec needs (F-109, F-111, ticket 38): a project, a second member (Sam, who saves
// first in the stale-save case), a task, a note written by the admin, and an agent's proposal from
// the task that says it contradicts that note; the task's session read the note, its thread holds an
// accepted `@ostra` comment, and its pushed head has a diff with a sent comment. The throwaway e2e
// database only. Run as `node e2e/seed-memory-world.ts '<json>'` to seed, with `"bump": "<noteId>"`
// to save the note's next version as Sam, as `saveNote` would, or with `"proposal": "<noteId>"` for
// a second agent proposal that refines the note. Prints one JSON line.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { taskEventSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), bump: z.string().optional(), proposal: z.string().optional() }).parse(JSON.parse(process.argv[2] ?? "{}"));
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
} else if (args.proposal !== undefined) {
  // An agent's proposal that refines the note, for the merge (its own, so the approval case's count stays 1).
  const note = await db.memoryNote.findUniqueOrThrow({ where: { id: args.proposal } });
  const task = await db.task.findFirstOrThrow({ where: { organizationId, projectId: note.projectId ?? "" } });
  const proposal = await db.memoryProposal.create({
    data: { organizationId, projectId: note.projectId, scope: "project", title: "Settings keys say what they hold", body: "Keys in `config/settings.json` name what they hold: releaseName, not name.", kind: "convention", sourceKind: "agent", taskId: task.id, relatesToNoteId: note.id, relation: "refines" },
  });
  process.stdout.write(`${JSON.stringify({ proposalId: proposal.id })}
`);
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

  // The task's session read the note (the task panel's Memory group), and its thread holds an
  // accepted `@ostra` PR comment: the member message, then `pr.comment_received`, as core writes them.
  const session = await db.session.create({ data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "ended", outcome: "without_changes", endedAt: new Date() } });
  await db.memoryUse.createMany({
    data: [
      { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, noteId: note.id, via: "index" },
      { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, noteId: note.id, via: "read" },
    ],
  });
  const prUrl = "https://github.com/fake-org/test1/pull/3";
  const events = [
    { kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: task.title, delivery: "immediate" },
    { kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: "mem-admin asked you something on the pull request. Do what it asks.", delivery: "queued", intent: "pr-comment" },
    { kind: "pr.comment_received", url: `${prUrl}#issuecomment-31`, login: "ostra-test-member", path: null, line: null },
  ].map((event) => taskEventSchema.parse(event));
  await db.event.createMany({
    data: events.map((event, i) => ({ organizationId, projectId: project.id, taskId: task.id, seq: i + 1, sessionId: session.id, sessionSeq: null, leaseEpoch: null, kind: event.kind, payload: event, occurredAt: new Date(Date.now() - (events.length - i) * 1000) })),
  });
  await db.task.update({ where: { id: task.id }, data: { eventSeq: events.length } });

  // F-111: a pushed head with its diff in the cache, as `diff.fetch` stores it, and Demo's sent
  // comment on a line of it, for "Remember this" on the Changes tab. A repo needs the
  // installation the setup spec linked; without one (the spec run alone) the case says so.
  let diffCommentId: string | null = null;
  const installation = await db.codeHostInstallation.findFirst({ where: { organizationId } });
  if (installation !== null) {
    const repo = await db.repo.create({
      data: { organizationId, projectId: project.id, connectionId: installation.connectionId, installationId: installation.installationId, hostRepoId: "4001", fullName: "fake-org/test1", defaultBranch: "main", checkoutDir: "test1" },
    });
    const headSha = "d".repeat(40);
    const taskRepo = await db.taskRepo.create({ data: { organizationId, projectId: project.id, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main", state: "pr_open", headSha, prNumber: 3, prUrl } });
    const patch = ["@@ -0,0 +1,2 @@", '+const settings = require("../config/settings.json");', "+process.stdout.write(settings.release);"].join("\n");
    await db.diffCache.create({
      data: {
        organizationId,
        projectId: project.id,
        repoId: repo.id,
        baseSha: "e".repeat(40),
        headSha,
        result: {
          version: 1,
          mergeBase: "e".repeat(40),
          headSha,
          aheadBy: 1,
          behindBy: 0,
          filesTruncated: false,
          hostUrl: `${prUrl}/files`,
          files: [{ path: "scripts/print-release.js", previousPath: null, status: "added", additions: 2, deletions: 0, patch, tooLarge: false }],
        },
      },
    });
    const comment = await db.diffComment.create({
      data: { organizationId, projectId: project.id, taskId: task.id, taskRepoId: taskRepo.id, memberId: admin.id, path: "scripts/print-release.js", side: "new", line: 2, headSha, body: "Print a newline at the end", state: "sent", sentInSeq: 2 },
    });
    diffCommentId = comment.id;
  }
  process.stdout.write(`${JSON.stringify({ projectId: project.id, taskId: task.id, noteId: note.id, proposalId: proposal.id, diffCommentId })}\n`);
}
await db.$disconnect();
