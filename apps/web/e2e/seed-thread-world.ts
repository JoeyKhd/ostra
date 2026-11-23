// Milestone 10's seeded world (F-151, spec section 9, ticket 09): the targets' recorded scenes
// (`@ostra/task-view/testing`) written into the throwaway e2e database as core's ingest stores
// them, a task for each scene, for every web ticket's spec (`27-thread-*.spec.ts`). Each scene's
// events keep their order, times, sessions and numbers; the IDs they name (the members, the repo,
// the runner, the model's key, the files and pictures) are the world's own rows. Each turn's row
// holds its figures as the key proxy's usage made them (its tokens, its reasoning, its spend as
// `tasks.get` prices it), each picture and each of Sam's files is a blob of its task in the
// built-in store, read back through core. Run as `node e2e/seed-thread-world.ts '<json>'`; prints
// one JSON line.
//
// - S1-working, S1 and S2 are `CALC-192` (a prompt task, its key the target's), at three moments:
//   running its first turn's second test run; waiting on OpenCode's question; three turns later,
//   its PR #483 open and CI running on GitHub (2 of 4 jobs done), its box idle.
// - S3 is the AI review of PR #483 (a review task of S2's), S5-plan and S5-approved `CALC-196`.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { hashPassword } from "better-auth/crypto";

import { createDb, effortLevelToDb, notifyChannels } from "@ostra/db";
import { postgresChangeNotices, seedMember } from "@ostra/domain";
import { APP_SCREENSHOT_CONTENT_TYPE, organizationIdSchema, projectIdSchema, storedEventSchema, taskIdSchema } from "@ostra/protocol";
import type { StoredEvent } from "@ostra/protocol";
import { eventFixtures } from "@ostra/protocol/testing";
import { calc192, calc192Spend, review483Spend, s1, s1Working, s2, s3, s5Approved, s5Plan, sceneMembers, sceneWorld } from "@ostra/task-view/testing";
import type { Scene } from "@ostra/task-view/testing";
import { z } from "zod";

const args = z
  .strictObject({
    databaseUrl: z.string(),
    password: z.string(),
    tag: z.string().regex(/^[a-z0-9-]{1,24}$/),
    /** The pictures the spec took of the demo app (Dana's mock, the 1280 and 390 captures) and the spec's docx. */
    files: z.strictObject({ mock: z.string(), desktop: z.string(), phone: z.string(), docx: z.string() }),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);
const FOREVER = new Date("2099-01-01T00:00:00Z");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const read = async (file: string): Promise<Uint8Array> => new Uint8Array(await readFile(file));

// ---- the people, the project, its repo, its runner and its model --------------------------------

const memberOf = async (username: string, name: string, role: "admin" | "member"): Promise<string> => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role });
  if (!seeded.ok) throw new Error(`seeding ${username} failed: ${seeded.error}`);
  await db.user.update({ where: { id: seeded.seeded.userId }, data: { name } });
  return seeded.seeded.memberId;
};
const username = `thread-${args.tag}`;
const sam = await memberOf(username, sceneMembers.sam.name, "admin");
const alex = await memberOf(`${username}-alex`, sceneMembers.alex.name, "member");
const priya = await memberOf(`${username}-priya`, sceneMembers.priya.name, "member");
const organizationId = (await db.member.findUniqueOrThrow({ where: { id: sam } })).organizationId;

const provider = await db.modelProvider.create({
  data: { organizationId, name: `thread-key-${args.tag}`, baseUrl: "https://thread-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: `builtin:thread-${args.tag}`, allowOnPersonalRunners: true },
});
const model = await db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-5-5", catalogId: "anthropic/claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", adminImageInput: true, inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" } });
const profile = await db.agentProfile.create({ data: { organizationId, name: `Default ${args.tag}`, adapter: "opencode", modelId: model.id, modelCatalogId: "anthropic/claude-sonnet-5-5", providerId: provider.id } });
const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `calculator-${args.tag}`, access: "open", defaultCodeProfileId: profile.id } });
await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
const place = { organizationId, projectId: project.id };

const github =
  (await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } })) ??
  (await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-thread-${args.tag}`, slug: `e2e-thread-${args.tag}`, state: "active" } }));
const installation =
  (await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id }, orderBy: { createdAt: "asc" } })) ??
  (await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: `inst-thread-${args.tag}`, accountLogin: "acme", accountKind: "organization" } }));
const repo = await db.repo.create({
  data: { ...place, connectionId: github.id, installationId: installation.installationId, hostRepoId: `e2e-thread-${args.tag}`, fullName: sceneWorld.repo, defaultBranch: "main", checkoutDir: "calculator-web" },
});

const runner = await db.runner.create({
  data: { organizationId, kind: "personal", ownerMemberId: sam, name: "build-fleet-03", publicKey: `e2e-thread-${randomUUID()}`, executor: "docker", capacity: 8, slots: 8, version: "0.10.0", minor: 9, state: "online", lastSeenAt: FOREVER },
});
await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-thread", connectionEpoch: 1, carrier: "websocket", minor: 9, connectedAt: new Date(), lastSeenAt: FOREVER } });

/** A blob of a task in the built-in store, its bytes in 1 MiB chunks, as core keeps one. */
const storeBlob = async (taskId: string, purpose: string, contentType: string, bytes: Uint8Array): Promise<string> => {
  const id = randomUUID();
  await db.blob.create({ data: { id, ...place, taskId, store: "postgres", key: `postgres:${id}`, purpose, contentType, size: bytes.length, sha256: sha256(bytes) } });
  for (let at = 0, ordinal = 0; at < bytes.length; at += 1024 * 1024, ordinal += 1) {
    await db.blobChunk.create({ data: { organizationId, blobId: id, ordinal, offset: at, bytes: Buffer.from(bytes.subarray(at, at + 1024 * 1024)) } });
  }
  return id;
};

const pictures = { mock: await read(args.files.mock), desktop: await read(args.files.desktop), phone: await read(args.files.phone) };
const docx = await read(args.files.docx);

// ---- a scene as a task ----------------------------------------------------------------------

type TaskShape = {
  readonly title: string;
  /** The task's branch: one per task in the project, so each scene's task has its own (the push's words are the events'). */
  readonly branch: string;
  readonly key: string | null;
  readonly kind: Scene["kind"];
  readonly state: "running" | "needs_you" | "in_review" | "done";
  readonly needsYouReason?: "question" | "plan";
  readonly subState?: "ci_running";
  readonly reviewOf?: string;
  /** Each turn's spend, as core priced it. */
  readonly spend: ReadonlyMap<string, { readonly microUsd: number; readonly estimated: boolean }>;
  /** The scene's last session: `running` mid-turn, `waiting` on a person, `idle` between turns, `ended`. */
  readonly session: "running" | "waiting" | "idle" | "ended";
  readonly pr?: { readonly number: number; readonly url: string; readonly title: string; readonly headSha: string; readonly jobs: readonly { readonly name: string; readonly conclusion: string }[] };
};

/** The IDs a scene's events name that are the world's rows here: the members, the repo, the runners, the model's key. */
const worldIds = (): Map<string, string> =>
  new Map<string, string>([
    [sceneMembers.sam.id, sam],
    [sceneMembers.alex.id, alex],
    [sceneMembers.priya.id, priya],
    [sceneWorld.repoId, repo.id],
    [sceneWorld.runners.buildFleet03, runner.id],
    [sceneWorld.runners.buildFleet07, runner.id],
    [eventFixtures["usage.recorded"].providerId, provider.id],
    [eventFixtures["usage.recorded"].modelId, model.id],
  ]);

/** A stored event with the scene's IDs swapped for the world's, parsed as the server stores it. */
const remap = (stored: StoredEvent, ids: ReadonlyMap<string, string>): StoredEvent => {
  let text = JSON.stringify(stored);
  for (const [from, to] of ids) text = text.replaceAll(from, to);
  return storedEventSchema.parse(JSON.parse(text));
};

/** A turn's figures from its events: the key proxy's tokens, its start, its end. */
type TurnFigures = { start: number; end: number | null; stop: string | null; input: number; output: number; read: number; write: number; reasoning: number; estimated: boolean };

const seedScene = async (scene: Scene, shape: TaskShape): Promise<string> => {
  const at0 = scene.events[0]?.at ?? scene.now;
  const task = await db.task.create({
    data: {
      ...place,
      kind: shape.kind,
      source: "prompt",
      title: shape.title,
      prompt: shape.title,
      ...(shape.key === null ? {} : { ticketKey: shape.key }),
      branchName: shape.branch,
      state: shape.state,
      ...(shape.needsYouReason === undefined ? {} : { needsYouReason: shape.needsYouReason }),
      ...(shape.subState === undefined ? {} : { subState: shape.subState }),
      ...(shape.reviewOf === undefined ? {} : { reviewOfTaskId: shape.reviewOf }),
      agentProfileId: profile.id,
      driverMemberId: sam,
      creatorMemberId: sam,
      runnerId: runner.id,
      leaseEpoch: 1,
      createdAt: new Date(at0),
    },
  });
  const ids = worldIds();
  ids.set(scene.taskId, task.id);

  // The task's repo, and its PR with CI running on its head.
  const taskRepo = await db.taskRepo.create({
    data: {
      ...place,
      taskId: task.id,
      repoId: repo.id,
      branchName: shape.branch,
      baseBranch: "main",
      state: shape.pr === undefined ? "no_branch" : "pr_open",
      ...(shape.pr === undefined ? {} : { headSha: shape.pr.headSha, ahead: true, prNumber: shape.pr.number, prUrl: shape.pr.url, prTitle: shape.pr.title }),
    },
  });
  if (shape.pr !== undefined) {
    await db.taskPullRequest.create({ data: { ...place, taskRepoId: taskRepo.id, number: shape.pr.number, url: shape.pr.url, branchName: shape.branch } });
    await db.ciRun.create({ data: { ...place, taskRepoId: taskRepo.id, headSha: shape.pr.headSha, state: "pending", checks: shape.pr.jobs.map((job, i) => ({ name: job.name, conclusion: job.conclusion, externalId: String(1000 + i) })) } });
  }

  // Every blob a scene's event names: Sam's files and the agent's pictures, each the world's own.
  for (const { event } of scene.events) {
    if (event.kind === "attachment.added") {
      const bytes = event.width >= 1000 ? pictures.desktop : pictures.phone;
      ids.set(event.blobId, await storeBlob(task.id, "app-screenshot", APP_SCREENSHOT_CONTENT_TYPE, bytes));
    }
  }

  // The scene's sessions, in order, each in its box; the last one as the scene leaves it.
  const sceneSessions = [...new Set(scene.events.map((stored) => stored.sessionId))];
  const last = sceneSessions.at(-1);
  const sessionOf = new Map<string, string>();
  for (const [index, sceneSession] of sceneSessions.entries()) {
    const latest = sceneSession === last;
    const state = latest ? shape.session : "ended";
    const box = await db.box.create({
      data: {
        ...place,
        taskId: task.id,
        runnerId: runner.id,
        executor: "docker",
        state: !latest ? "released" : state === "ended" ? "stopped" : state === "idle" ? "idle" : "ready",
        readyAt: new Date(at0),
        ...(latest && state === "idle" ? { idleSince: new Date(scene.events.at(-1)?.at ?? scene.now) } : {}),
      },
    });
    const session = await db.session.create({
      data: {
        ...place,
        taskId: task.id,
        origin: index === 0 ? "new" : "restored",
        state,
        ...(state === "ended" ? { outcome: "without_changes", endedAt: new Date(scene.events.findLast((stored) => stored.sessionId === sceneSession)?.at ?? scene.now) } : {}),
        agentProfileId: profile.id,
        providerId: provider.id,
        modelId: model.id,
        boxId: box.id,
        startedAt: new Date(scene.events.find((stored) => stored.sessionId === sceneSession)?.at ?? at0),
      },
    });
    sessionOf.set(sceneSession, session.id);
    if (latest && state !== "ended") {
      await db.lease.create({ data: { ...place, taskId: task.id, epoch: 1, runnerId: runner.id, boxId: box.id, state: "active", acceptedAt: new Date(at0) } });
    }
  }

  // Sam's files on his first message: a row and a blob each, as the upload route stores them.
  for (const { seq, event } of scene.events) {
    if (event.kind !== "user.message") continue;
    for (const [position, file] of (event.files ?? []).entries()) {
      const bytes = file.kind === "image" ? pictures.mock : docx;
      const blobId = await storeBlob(task.id, "message-file", file.contentType, bytes);
      const row = await db.messageFile.create({
        data: {
          ...place,
          taskId: task.id,
          memberId: sam,
          origin: "member",
          state: "sent",
          sessionId: sessionOf.get(sceneSessions[0] ?? "") ?? null,
          eventSeq: seq,
          position,
          name: file.name,
          kind: file.kind,
          contentType: file.contentType,
          size: bytes.length,
          sha256: sha256(bytes),
          blobId,
          boxPath: `attachments/${String(seq)}/${file.name}`,
          asImage: file.asImage,
          textState: file.text === "ready" ? "ready" : "none",
          ...(file.text === "ready" ? { textWords: 2140 } : {}),
          sentAt: new Date(at0),
        },
      });
      ids.set(file.fileId, row.id);
    }
  }

  // The events, as ingest stores them: numbered per task, each runner event with its session's number.
  // The scene's own sessions stay its keys here (`sessionOf`): only the event's payload is the world's.
  const events = scene.events.map((stored) => ({ ...remap(stored, ids), sessionId: stored.sessionId }));
  const sessionFor = (sceneSession: string): string => {
    const id = sessionOf.get(sceneSession);
    if (id === undefined) throw new Error("a scene's event names no session of the scene");
    return id;
  };
  const turnRows = new Map<string, string>();
  const figures = new Map<string, TurnFigures>();
  let open: string | null = null;
  const perSession = new Map<string, number>();
  for (const stored of events) {
    const sessionId = sessionFor(stored.sessionId);
    const { event } = stored;
    await db.event.create({ data: { ...place, taskId: task.id, seq: stored.seq, sessionId, sessionSeq: stored.sessionSeq, leaseEpoch: null, kind: event.kind, payload: event, occurredAt: new Date(stored.at) } });
    if (event.kind === "turn.started") {
      open = event.turnId;
      figures.set(event.turnId, { start: stored.at, end: null, stop: null, input: 0, output: 0, read: 0, write: 0, reasoning: 0, estimated: false });
      const ordinal = (perSession.get(stored.sessionId) ?? 0) + 1;
      perSession.set(stored.sessionId, ordinal);
      const row = await db.turn.create({
        data: { ...place, taskId: task.id, sessionId, ordinal, startSeq: stored.seq, startedAt: new Date(stored.at), ...(event.effort === undefined ? {} : { effort: effortLevelToDb[event.effort] }) },
      });
      turnRows.set(event.turnId, row.id);
    } else if ((event.kind === "turn.ended" || event.kind === "turn.failed") && figures.has(event.turnId)) {
      const turn = figures.get(event.turnId);
      if (turn !== undefined) {
        turn.end = stored.at;
        turn.stop = event.kind === "turn.ended" ? event.stopReason : "failed";
      }
      open = null;
    } else if (event.kind === "usage.recorded" && open !== null) {
      const turn = figures.get(open);
      if (turn !== undefined) {
        turn.input += event.inputTokens;
        turn.output += event.outputTokens;
        turn.read += event.cacheReadTokens;
        turn.write += event.cacheWriteTokens;
        turn.reasoning += event.reasoningTokens ?? 0;
        turn.estimated ||= event.estimated;
      }
    }
  }
  // Each turn's figures, as the key proxy's usage left them; the session's and the task's totals.
  let spent = 0;
  for (const [turnId, turn] of figures) {
    const spend = shape.spend.get(turnId);
    spent += spend?.microUsd ?? 0;
    await db.turn.update({
      where: { id: turnRows.get(turnId) ?? "" },
      data: {
        inputTokens: turn.input,
        outputTokens: turn.output,
        cacheReadTokens: turn.read,
        cacheWriteTokens: turn.write,
        reasoningTokens: turn.reasoning,
        spentMicroUsd: spend?.microUsd ?? 0,
        estimated: spend?.estimated ?? turn.estimated,
        ...(turn.end === null ? {} : { endedAt: new Date(turn.end), stopReason: turn.stop, agentMs: turn.end - turn.start }),
      },
    });
  }
  for (const [sceneSession, sessionId] of sessionOf) {
    const own = [...figures.entries()].filter(([turnId]) => events.some((stored) => stored.sessionId === sceneSession && stored.event.kind === "turn.started" && stored.event.turnId === turnId)).map(([, turn]) => turn);
    const sessionSeqs = events.filter((stored) => stored.sessionId === sceneSession && stored.sessionSeq !== null).map((stored) => stored.sessionSeq ?? 0);
    await db.session.update({
      where: { id: sessionId },
      data: {
        ingestedSeq: Math.max(0, ...sessionSeqs),
        inputTokens: own.reduce((sum, turn) => sum + turn.input, 0),
        outputTokens: own.reduce((sum, turn) => sum + turn.output, 0),
        reasoningTokens: own.reduce((sum, turn) => sum + turn.reasoning, 0),
      },
    });
  }
  // The pictures core stored, each by its turn.
  for (const { event } of events) {
    if (event.kind !== "attachment.added") continue;
    const turnId = [...figures.entries()].findLast(([, turn]) => turn.start <= (events.find((stored) => stored.event === event)?.at ?? 0))?.[0];
    await db.taskAttachment.create({
      data: {
        ...place,
        taskId: task.id,
        attachmentId: event.attachmentId,
        kind: event.attachmentKind,
        blobId: event.blobId,
        source: event.source === "after-turn" ? "after_turn" : event.source === "member" ? "member" : "agent",
        targetKind: "process",
        targetName: "web",
        path: event.path,
        width: event.width,
        height: event.height,
        durationMs: event.durationMs,
        frameCount: event.frameCount,
        caption: event.caption,
        browserName: event.browser.name,
        browserVersion: event.browser.version,
        turnId: turnId === undefined ? null : (turnRows.get(turnId) ?? null),
        createdAt: new Date(events.find((stored) => stored.event === event)?.at ?? scene.now),
      },
    });
  }
  // What waits on Sam: the open question, or the plan.
  const asked = events.findLast((stored) => stored.event.kind === "question.asked")?.event;
  if (shape.needsYouReason === "question" && asked?.kind === "question.asked") {
    await db.needsYouItem.create({ data: { ...place, taskId: task.id, reason: "question", audience: "driver", questionId: asked.questionId } });
  }
  const proposed = events.findLast((stored) => stored.event.kind === "plan.proposed")?.event;
  if (shape.needsYouReason === "plan" && proposed?.kind === "plan.proposed") {
    await db.needsYouItem.create({ data: { ...place, taskId: task.id, reason: "plan", audience: "driver", planTurnId: proposed.turnId } });
  }

  const head = events.at(-1)?.seq ?? 0;
  await db.task.update({ where: { id: task.id }, data: { eventSeq: head, spentMicroUsd: spent } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: head })})`;
  await db.$transaction((tx) => postgresChangeNotices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId: projectIdSchema.parse(project.id), entity: "task", entityId: taskIdSchema.parse(task.id) }));
  return task.id;
};

const byTurn = (spend: ReadonlyMap<string, { readonly microUsd: number; readonly estimated: boolean }>) => spend;
const jobs = [
  { name: "build", conclusion: "success" },
  { name: "lint", conclusion: "success" },
  { name: "test", conclusion: "in_progress" },
  { name: "e2e", conclusion: "queued" },
] as const;

const s1WorkingTask = await seedScene(s1Working, { title: "Add a history panel", branch: `${sceneWorld.branch}-1`, key: "CALC-192", kind: "code", state: "running", spend: byTurn(calc192Spend.working), session: "running" });
const s1Task = await seedScene(s1, { title: "Add a history panel", branch: `${sceneWorld.branch}-2`, key: "CALC-192", kind: "code", state: "needs_you", needsYouReason: "question", spend: byTurn(calc192Spend.question), session: "waiting" });
const s2Task = await seedScene(s2, {
  title: "Add a history panel",
  branch: sceneWorld.branch,
  key: "CALC-192",
  kind: "code",
  state: "in_review",
  subState: "ci_running",
  spend: byTurn(calc192Spend.pr),
  session: "idle",
  pr: { number: calc192.pr.number, url: calc192.pr.url, title: calc192.pr.title, headSha: calc192.pushSha, jobs },
});
const s3Task = await seedScene(s3, { title: "Review of PR #483", branch: "pending", key: null, kind: "review", state: "done", reviewOf: s2Task, spend: byTurn(review483Spend), session: "ended" });
const s5PlanTask = await seedScene(s5Plan, { title: "Keyboard shortcuts for the keypad", branch: "ostra/calc-196-keypad-shortcuts-1", key: "CALC-196", kind: "code", state: "needs_you", needsYouReason: "plan", spend: new Map(), session: "waiting" });
const s5ApprovedTask = await seedScene(s5Approved, { title: "Keyboard shortcuts for the keypad", branch: "ostra/calc-196-keypad-shortcuts-2", key: "CALC-196", kind: "code", state: "running", spend: new Map(), session: "running" });

console.log(
  JSON.stringify({
    username,
    projectId: project.id,
    tasks: { "s1-working": s1WorkingTask, s1: s1Task, s2: s2Task, s3: s3Task, "s5-plan": s5PlanTask, "s5-approved": s5ApprovedTask },
    now: { "s1-working": s1Working.now, s1: s1.now, s2: s2.now, s3: s3.now, "s5-plan": s5Plan.now, "s5-approved": s5Approved.now },
  }),
);
await db.$disconnect();
