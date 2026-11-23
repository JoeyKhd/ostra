// What the every-route checks need (ticket 19, the phone sweep; ticket 20, the pseudo-locale pass):
// one row behind every route with an ID in it, and the three "needs you" moments a member answers
// by touch, an approval, a question and a reopen, each with its notification. The throwaway e2e
// database only, and nothing of it needs GitHub or a model: the pseudo-locale stack has neither.
// Run as `node e2e/seed-routes-world.ts '<json>'`; prints one JSON line: the IDs the routes open,
// and `userData`, the words the seed wrote as a member's own (titles, names, a note's text), which
// the pseudo-locale pass leaves out of its check: they're data, not the panel's words.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { newPreviewLinkToken, seedMember } from "@ostra/domain";
import type { TaskEvent } from "@ostra/protocol";
import { taskEventSchema } from "@ostra/protocol";
import { z } from "zod";

import { libraryWords, seedLibrary } from "./seed-library.ts";

const args = z.strictObject({ databaseUrl: z.string(), password: z.string(), tag: z.string().regex(/^[a-z0-9-]{1,24}$/) }).parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

/** Every word below that a member would have typed: the pass leaves these out (user data). */
const userData = new Set<string>();
const data = <T extends string>(text: T): T => {
  userData.add(text);
  return text;
};

// The member who opens every route: an organization admin and the instance admin, seeded with its
// own password, so the checks never depend on the install's first admin (whose password the
// desktop specs change) and run on their own.
const username = `routes-${args.tag}`;
const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "admin" });
if (!seeded.ok) throw new Error(`seeding ${username} failed: ${seeded.error}`);
await db.user.update({ where: { id: seeded.seeded.userId }, data: { role: "admin" } });
// And a member who isn't an admin, for the pages that refuse them (ticket 20's role refusal).
const memberUsername = `${username}-m`;
const plain = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: memberUsername, email: `${memberUsername}@example.com`, password: args.password, role: "member" });
if (!plain.ok) throw new Error(`seeding ${memberUsername} failed: ${plain.error}`);
const admin = await db.member.findUniqueOrThrow({ where: { id: seeded.seeded.memberId }, include: { user: true, organization: true } });
const organizationId = admin.organizationId;
// The members and the organization are the install's own data, never the panel's words.
for (const user of await db.user.findMany({ select: { name: true, username: true, email: true } })) {
  data(user.name);
  data(user.username);
  data(user.email);
}
data(admin.organization.name);

const slug = username;
const project =
  (await db.project.findFirst({ where: { organizationId, slug } })) ??
  (await db.project.create({ data: { organizationId, name: data(slug), slug, access: "open" } }));
data(slug);

const OPTIONS = [
  { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: "o-task", label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
] as const;

const appendEvents = async (taskId: string, sessionId: string, events: readonly TaskEvent[]): Promise<void> => {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
  let seq = task.eventSeq;
  const rows = events.map((event, i) => {
    seq += 1;
    return {
      organizationId,
      projectId: project.id,
      taskId,
      seq,
      sessionId,
      sessionSeq: session.ingestedSeq + i + 1,
      leaseEpoch: null,
      kind: event.kind,
      payload: event,
      occurredAt: new Date(Date.now() - (events.length - i) * 1000),
    };
  });
  await db.event.createMany({ data: rows });
  const turns = rows.flatMap((row) => (row.kind === "turn.started" ? [{ organizationId, projectId: project.id, taskId, sessionId, startSeq: row.seq }] : []));
  const before = await db.turn.count({ where: { sessionId } });
  if (turns.length > 0) await db.turn.createMany({ data: turns.map((turn, i) => ({ ...turn, ordinal: before + i + 1 })) });
  await db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
  await db.session.update({ where: { id: sessionId }, data: { ingestedSeq: session.ingestedSeq + events.length } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq })})`;
};

const parse = (events: readonly unknown[]): TaskEvent[] => events.map((event) => taskEventSchema.parse(event));

/** A task the admin drives, its session, and its prompt as the first message. */
const createTask = async (title: string, state: "needs_you" | "running", reason: "approval" | "question" | "no_changes" | "spend_cap" | null, sessionState: "waiting" | "ended" | "running") => {
  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title: data(title),
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-routes`,
      state,
      ...(reason === null ? {} : { needsYouReason: reason }),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  const session = await db.session.create({
    data: {
      organizationId,
      projectId: project.id,
      taskId: task.id,
      origin: "new",
      state: sessionState,
      ...(sessionState === "ended" ? { outcome: "without_changes" as const, endedAt: new Date() } : {}),
    },
  });
  await appendEvents(task.id, session.id, parse([{ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: title, delivery: "immediate" }]));
  // A prompt task's key is its ID's last eight hex digits (the API's `keyOf`): data, not a word.
  data(task.id.replaceAll("-", "").slice(-8));
  return { taskId: task.id, sessionId: session.id };
};

/** The item and the admin's notification for it, as fan-out writes them. */
const needsYou = async (taskId: string, reason: "approval" | "question" | "no_changes", extra: { readonly approvalId?: string; readonly questionId?: string; readonly summary?: string }) => {
  const item = await db.needsYouItem.create({
    data: { organizationId, projectId: project.id, taskId, reason, audience: "driver", notifiedAt: new Date(), ...extra },
  });
  await db.notification.create({ data: { organizationId, memberId: admin.id, projectId: project.id, taskId, needsYouItemId: item.id, kind: reason } });
  return item.id;
};

// 1. An approval: the agent wants to run a command.
const approval = await (async () => {
  const made = await createTask("Add left-pad to the build", "needs_you", "approval", "waiting");
  const row = await db.approval.create({
    data: { organizationId, projectId: project.id, taskId: made.taskId, sessionId: made.sessionId, toolCallId: `tool-${randomUUID()}`, options: [...OPTIONS], subjectKind: "command", subjectValue: data("pnpm add left-pad") },
  });
  const turnId = randomUUID();
  await appendEvents(
    made.taskId,
    made.sessionId,
    parse([
      { kind: "turn.started", turnId },
      { kind: "tool.called", turnId, toolCallId: row.toolCallId, toolKind: "execute", title: data("pnpm add left-pad"), input: { command: "pnpm add left-pad" } },
      { kind: "approval.requested", turnId, approvalId: row.id, toolCallId: row.toolCallId, options: OPTIONS, subject: { kind: "command", value: "pnpm add left-pad" } },
    ]),
  );
  await needsYou(made.taskId, "approval", { approvalId: row.id });
  return { taskId: made.taskId, approvalId: row.id };
})();

// 2. A question: the agent asks which file to change.
const question = await (async () => {
  const made = await createTask("Pick the config file to change", "needs_you", "question", "waiting");
  const questionId = randomUUID();
  const turnId = randomUUID();
  await appendEvents(
    made.taskId,
    made.sessionId,
    parse([
      { kind: "turn.started", turnId },
      { kind: "question.asked", turnId, questionId, message: data("Which config file should change?"), fields: [{ id: "answer", label: data("Which config file should change?"), type: "text" }] },
    ]),
  );
  await needsYou(made.taskId, "question", { questionId });
  return { taskId: made.taskId, questionId };
})();

// 3. A reopen: the session ended with no changes, and the agent said why.
const reopen = await (async () => {
  const made = await createTask("Explain how the tests are organised", "needs_you", "no_changes", "ended");
  const turnId = randomUUID();
  await appendEvents(
    made.taskId,
    made.sessionId,
    parse([
      { kind: "turn.started", turnId },
      { kind: "agent.message", turnId, segmentId: "seg-routes", text: data("The tests live in test/, one file per module.") },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.ended", outcome: "without-changes", repos: [] },
    ]),
  );
  await needsYou(made.taskId, "no_changes", { summary: data("No changes: the tests live in test/, one file per module.") });
  return { taskId: made.taskId };
})();

// 4. A task stopped at its spend cap, which a reopen refuses until the cap is raised (a budget stop).
const capped = await (async () => {
  const made = await createTask("Rewrite the parser", "needs_you", "spend_cap", "ended");
  await db.task.update({ where: { id: made.taskId }, data: { spentMicroUsd: 2_000_000_000 } });
  // Its session ended at the cap, so the page shows the limit block (ticket 20's budget stop).
  await db.session.update({ where: { id: made.sessionId }, data: { limitReached: "spend_cap" } });
  return { taskId: made.taskId };
})();

// 5. A running task: the agent runs a command now, so the project's Live list holds a running row
// (its green mark and what the agent does), beside the needs-you ones.
const running = await (async () => {
  const made = await createTask("Speed up the test suite", "running", null, "running");
  const turnId = randomUUID();
  await appendEvents(
    made.taskId,
    made.sessionId,
    parse([
      { kind: "turn.started", turnId },
      { kind: "tool.called", turnId, toolCallId: `tool-${randomUUID()}`, toolKind: "execute", title: data("pnpm test --shard 1/4"), input: { command: "pnpm test --shard 1/4" } },
    ]),
  );
  return { taskId: made.taskId };
})();

// A memory note in the organization and one in the project.
const note = async (scope: "organization" | "project", title: string, body: string) => {
  const row = await db.memoryNote.create({
    data: { organizationId, ...(scope === "project" ? { projectId: project.id } : {}), scope, title: data(title), body: data(body), kind: "convention", sourceKind: "member", authorMemberId: admin.id },
  });
  await db.memoryNoteVersion.create({ data: { organizationId, noteId: row.id, version: 1, title: row.title, body: row.body, kind: row.kind, always: false, editedByMemberId: admin.id } });
  return row.id;
};
const orgNoteId = await note("organization", `Commit messages use gitmoji ${args.tag}`, "Start every commit message with its gitmoji.");
const projectNoteId = await note("project", `Settings keys use camelCase ${args.tag}`, "New keys in config/settings.json are camelCase.");

// A pool with one runner, and a join token.
const poolName = data(`routes-pool-${args.tag}`);
const pool = (await db.runnerPool.findFirst({ where: { organizationId, name: poolName } })) ?? (await db.runnerPool.create({ data: { organizationId, name: poolName } }));
const token = await db.joinToken.create({ data: { organizationId, poolId: pool.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), label: data(`routes-token-${args.tag}`), createdByMemberId: admin.id } });
const runner = await db.runner.create({
  data: {
    organizationId,
    kind: "pool",
    poolId: pool.id,
    name: data(`routes-runner-${args.tag}`),
    publicKey: randomBytes(32).toString("base64url"),
    executor: "docker",
    processContainment: "container",
    capacity: 2,
    slots: 2,
    version: data("0.5.0"),
    minor: 4,
    install: "npm",
    os: { platform: "linux", arch: "x64", release: "6.8.0" },
    state: "online",
    joinTokenId: token.id,
    lastSeenAt: new Date(Date.now() - 60_000),
    approvedAt: new Date(Date.now() - 86_400_000),
    approvedByMemberId: admin.id,
  },
});
data("linux");
data("x64");
data("6.8.0");

// An agent profile: the organization's first.
const profile =
  (await db.agentProfile.findFirst({ where: { organizationId, archivedAt: null, builtInKind: null }, orderBy: { createdAt: "asc" } })) ??
  (await db.agentProfile.create({ data: { organizationId, name: `routes-profile-${args.tag}`, adapter: "opencode" } }));
// Every profile's name is a member's own words, the built-in ones' included (they can be renamed).
for (const row of await db.agentProfile.findMany({ where: { organizationId }, select: { name: true } })) data(row.name);
// So are the install's own rows an admin names or sees as stored: every pool (the default one's
// "default" included) and every box size (small, medium, large).
for (const row of await db.runnerPool.findMany({ where: { organizationId }, select: { name: true } })) data(row.name);
for (const row of await db.boxSize.findMany({ where: { organizationId }, select: { name: true } })) data(row.name);
// And every join token's label, core's bootstrap token's `bootstrap` included (the audit log names
// it), which core may make after this seed runs: a token's name, as the default pool's is.
for (const row of await db.joinToken.findMany({ where: { organizationId }, select: { label: true } })) if (row.label !== null) data(row.label);
data("bootstrap");

// Milestone 6 (ticket 31): a prompt schedule, for the automation editor and its history.
const automation =
  (await db.automation.findFirst({ where: { organizationId, projectId: project.id, name: data("Weekly dependency update") } })) ??
  (await db.automation.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "schedule",
      name: data("Weekly dependency update"),
      taskKind: "code",
      poolLabels: [],
      schedule: "0 9 * * 1",
      timeZone: "Europe/Amsterdam",
      title: data("Update the dependencies"),
      prompt: data("Update every dependency to its latest minor version."),
      nextOccurrenceAt: new Date(Date.now() + 3 * 86_400_000),
      createdByMemberId: admin.id,
    },
  }));

// Milestone 6 (ticket 32): a parent ticket with one sub-issue on a board of the project, for its page.
const linear =
  (await db.connection.findFirst({ where: { organizationId, kind: "linear" } })) ??
  (await db.connection.create({ data: { organizationId, kind: "linear", appId: "e2e-routes-linear", state: "active", credentialKind: "api_key", externalWorkspaceKey: "ostra-test" } }));
const board =
  (await db.board.findFirst({ where: { organizationId, projectId: project.id } })) ??
  (await db.board.create({
    data: {
      organizationId,
      projectId: project.id,
      connectionId: linear.id,
      externalId: `routes-team-${args.tag}`,
      name: data("Routes board"),
      key: "RTE",
      statusMap: { open: ["s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" },
    },
  }));
// The board's key and its statuses (their ids, and the name `Todo` its tickets carry) are Linear's:
// data, never the panel's words.
for (const word of ["RTE", "s-todo", "s-progress", "s-review", "s-done", "Todo"]) data(word);
const cachedTicket = async (key: string, title: string, parentExternalId: string | null) =>
  (await db.ticket.findFirst({ where: { organizationId, boardId: board.id, key } })) ??
  (await db.ticket.create({
    data: {
      organizationId,
      projectId: project.id,
      boardId: board.id,
      connectionId: linear.id,
      externalId: `routes-${key}-${args.tag}`,
      key,
      title: data(title),
      statusId: "s-todo",
      statusName: "Todo",
      statusCategory: "open",
      labels: [],
      url: `https://linear.app/ostra-test/issue/${key}`,
      open: true,
      trackerUpdatedAt: new Date(),
      parentExternalId,
    },
  }));
// A ticket's key is the tracker's: data.
const parentTicket = await cachedTicket(data("RTE-1"), "Show the app's version", null);
await cachedTicket(data("RTE-2"), "Add a version endpoint", parentTicket.externalId);

// Milestone 8 (F-145, ticket 31): the library in its fullest state, for its four pages.
const library = await seedLibrary(db, { organizationId, adminMemberId: admin.id, memberId: plain.seeded.memberId, profileId: profile.id });
for (const word of libraryWords()) data(word);

// Milestone 8 (ticket 21): a task whose box went to sleep, with the environment's `web` as its
// preview, for the task page with the preview pane open (its asleep card, the switcher and the share
// menu); and a watch-only link to it, for the viewer page a signed-out visitor opens (the app isn't
// running, so it says so). The repo's GitHub App is a row only: nothing calls GitHub.
const preview = await (async () => {
  const github =
    (await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } })) ??
    (await db.connection.create({ data: { organizationId, kind: "github", appId: "e2e-routes-github", slug: "e2e-routes" } }));
  const installation =
    (await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id }, orderBy: { createdAt: "asc" } })) ??
    (await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: `routes-${args.tag}`, accountLogin: "ostra-test" } }));
  const repo = await db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: github.id, installationId: installation.installationId, hostRepoId: `routes-${args.tag}`, fullName: data(`ostra-test/routes-${args.tag}`), defaultBranch: "main", checkoutDir: data(`routes-${args.tag}`) },
  });
  const environment = (await db.environment.findUnique({ where: { projectId: project.id } })) ?? (await db.environment.create({ data: { organizationId, projectId: project.id } }));
  await db.appProcess.create({ data: { organizationId, projectId: project.id, environmentId: environment.id, repoId: repo.id, name: "web", command: "pnpm dev", port: 5173, readyKind: "port", label: data("web"), primary: true } });
  const made = await createTask("Add a history panel", "running", null, "waiting");
  // Its branch is pushed, so the top bar offers Take it local and the walks open its popover.
  await db.taskRepo.create({
    data: { organizationId, projectId: project.id, taskId: made.taskId, repoId: repo.id, branchName: data(`ostra/routes-${args.tag}`), baseBranch: "main", state: "branch_pushed", headSha: "4f2c1a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a" },
  });
  const box = await db.box.create({ data: { organizationId, projectId: project.id, taskId: made.taskId, executor: "host", state: "released", releasedAt: new Date(), stoppedAt: new Date() } });
  await db.lease.create({ data: { organizationId, projectId: project.id, taskId: made.taskId, epoch: 1, runnerId: runner.id, boxId: box.id, state: "ended", acceptedAt: new Date(Date.now() - 20 * 60_000), endedAt: new Date() } });
  const { token, tokenHash } = newPreviewLinkToken();
  await db.previewLink.create({
    data: { organizationId, projectId: project.id, taskId: made.taskId, key: "app-web", kind: "expiring", tokenHash, allowInput: false, expiresAt: new Date(Date.now() + 23 * 3_600_000), createdByMemberId: admin.id },
  });
  // F-142: the preview's level, naming the plain member, for the preview's own page (`/previews/<id>`).
  // The share menu still shows the link, the widest of the two.
  const access = await db.previewAccess.create({ data: { organizationId, projectId: project.id, taskId: made.taskId, key: "app-web", level: "named", setByMemberId: admin.id } });
  await db.previewAccessMember.create({ data: { organizationId, projectId: project.id, previewAccessId: access.id, memberId: plain.seeded.memberId } });
  return { taskId: made.taskId, token, previewId: access.id };
})();

// A pending invitation, for the invitation page a new member opens.
const invitation = await db.invitation.create({
  data: { id: randomUUID(), organizationId, email: data(`routes-${args.tag}@example.com`), role: "member", expiresAt: new Date(Date.now() + 7 * 86_400_000), inviterId: admin.userId },
});

process.stdout.write(
  `${JSON.stringify({
    projectId: project.id,
    approval,
    question,
    reopen,
    capped,
    preview,
    running,
    orgNoteId,
    projectNoteId,
    trackerConnectionId: linear.id,
    poolId: pool.id,
    runnerId: runner.id,
    profileId: profile.id,
    libraryItemId: library.itemId,
    invitationId: invitation.id,
    automationId: automation.id,
    parentTicketId: parentTicket.id,
    username,
    memberUsername,
    userData: [...userData],
  })}\n`,
);
await db.$disconnect();
