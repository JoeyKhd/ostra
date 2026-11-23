// What the Changes tab spec needs (milestone 3's ticket 46; F-027, F-072, F-070), in a project the
// spec made through New project on the fake GitHub's `test1`: a code task the admin drives whose
// session ended with its branch pushed at the first of the fake's scripted heads
// (`e2eChangesHeads`), two commits behind `main` by the reconcile. The diff itself is fetched by
// core's `diff.fetch` from the fake GitHub's compare, as on any install. The throwaway e2e database
// only. Run as `node e2e/seed-changes.ts '<json>'`; prints one JSON line.
//
// Actions:
// - `seed`: the task (`projectId` given), at the scripted head `head` (`first` by default, or `long`).
// - `new-head`: the agent pushed again: the task repo's head moves to the second scripted head (`taskId`).
// - `messages`: the intents of the task's member messages, oldest first, and no text (`taskId`).

import { randomUUID } from "node:crypto";

import { createDb } from "@ostra/db";
import { taskEventSchema } from "@ostra/protocol";
import { z } from "zod";

import { e2eChangesHeads } from "./settings.ts";

const args = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("seed"), databaseUrl: z.string(), projectId: z.string(), head: z.enum(["first", "long"]).default("first") }),
    z.strictObject({ action: z.literal("new-head"), databaseUrl: z.string(), taskId: z.string() }),
    z.strictObject({ action: z.literal("messages"), databaseUrl: z.string(), taskId: z.string() }),
  ])
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

switch (args.action) {
  case "seed": {
    const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, include: { repos: { orderBy: { position: "asc" } } } });
    const repo = project.repos[0];
    if (repo === undefined) throw new Error("the project has no repo");
    const admin = await db.member.findFirstOrThrow({ where: { organizationId: project.organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });
    const title = "Rename the calculator module";
    const task = await db.task.create({
      data: {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: "code",
        source: "prompt",
        title,
        prompt: title,
        branchName: `ostra/${randomUUID().slice(0, 8)}-rename-calc`,
        state: "in_review",
        subState: "waiting_for_reviewer",
        driverMemberId: admin.id,
        creatorMemberId: admin.id,
      },
    });
    const session = await db.session.create({
      data: { organizationId: project.organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date() },
    });
    const taskRepo = await db.taskRepo.create({
      data: {
        organizationId: project.organizationId,
        projectId: project.id,
        taskId: task.id,
        repoId: repo.id,
        branchName: task.branchName,
        baseBranch: "main",
        state: "branch_pushed",
        headSha: e2eChangesHeads[args.head],
        ahead: true,
        behindBy: 2,
        behindCheckedAt: new Date(),
      },
    });
    const turnId = randomUUID();
    const events = [
      { kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: title, delivery: "immediate" },
      { kind: "turn.started", turnId },
      { kind: "agent.message", turnId, segmentId: "seg-rename", text: "Renamed the module and described it in the README." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: repo.id, ahead: true }] },
    ].map((event) => taskEventSchema.parse(event));
    await db.event.createMany({
      data: events.map((event, i) => ({
        organizationId: project.organizationId,
        projectId: project.id,
        taskId: task.id,
        seq: i + 1,
        sessionId: session.id,
        sessionSeq: i + 1,
        leaseEpoch: null,
        kind: event.kind,
        payload: event,
        occurredAt: new Date(Date.now() - (events.length - i) * 50),
      })),
    });
    await db.turn.create({ data: { id: turnId, organizationId: project.organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, startSeq: 2, ordinal: 1, stopReason: "end_turn", endedAt: new Date() } });
    await db.task.update({ where: { id: task.id }, data: { eventSeq: events.length } });
    await db.session.update({ where: { id: session.id }, data: { ingestedSeq: events.length } });
    process.stdout.write(`${JSON.stringify({ taskId: task.id, taskRepoId: taskRepo.id, repo: repo.fullName })}\n`);
    break;
  }
  case "new-head": {
    // The page reads the new head on its next load, and core's `diff.fetch` compares it then.
    await db.taskRepo.updateMany({ where: { taskId: args.taskId }, data: { headSha: e2eChangesHeads.second } });
    process.stdout.write(`${JSON.stringify({ taskId: args.taskId })}\n`);
    break;
  }
  case "messages": {
    const rows = await db.event.findMany({ where: { taskId: args.taskId, kind: "user.message" }, orderBy: { seq: "asc" }, select: { payload: true } });
    const intents = rows.map((row) => z.looseObject({ intent: z.string().optional() }).parse(row.payload).intent ?? "message");
    process.stdout.write(`${JSON.stringify({ intents })}\n`);
    break;
  }
  default:
    args satisfies never;
}
await db.$disconnect();
