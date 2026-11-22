// What milestone 9's web spec needs (tickets 15 and 16, F-148, F-149, F-150,
// `26-attachments.spec.ts`), in the throwaway e2e database only. Run as
// `node e2e/seed-files-world.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `world`: an admin (Sam Rivera) and a project `calculator` on a runner at protocol minor 8, with
//   two models (one that reads images, one an admin set to text only) and their profiles; a task
//   that waits on Sam's reply (the composer); a running task whose earlier message carried two
//   pictures and three files, a docx's and a PDF's text read (the thread, the viewer); a task on
//   the text-only model; a task whose runner is at minor 7; and four tasks from a Linear ticket
//   whose first read gave the agent its description, files, links and comments: all of them, some
//   left out by the ticket's limits, two that didn't load, and a tracker that fetches no files.
//   Each file is a blob of its project in the built-in store, read back through core.
// - `round`: the answer to a press of the driver's, as core's `ticket.read-changes` job writes it:
//   the next read of the ticket, with nothing new, or with the failed files fetched again.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { postgresChangeNotices, seedMember } from "@ostra/domain";
import { organizationIdSchema, projectIdSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({
    scenario: z.literal("world"),
    databaseUrl: z.string(),
    password: z.string(),
    tag: z.string().regex(/^[a-z0-9-]{1,24}$/),
    /** The pictures (PNGs the spec took of a demo app) and the documents (the m9 fixtures). */
    files: z.strictObject({ mock: z.string(), pasted: z.string(), wrong: z.string(), right: z.string(), phone: z.string(), docx: z.string(), pdf: z.string() }),
  }),
  z.strictObject({ scenario: z.literal("round"), databaseUrl: z.string(), taskId: z.string(), answer: z.enum(["nothing-new", "retry-loaded"]), picture: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);
const FOREVER = new Date("2099-01-01T00:00:00Z");
const MiB = 1024 * 1024;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

type Place = { readonly organizationId: string; readonly projectId: string };
type Timed = { readonly at: number; readonly event: TaskEvent };

/** A blob of the project's in the built-in store, its bytes in 1 MiB chunks, as core keeps an upload. */
const storeBlob = async (place: Place, taskId: string, purpose: string, contentType: string, bytes: Uint8Array): Promise<string> => {
  const id = randomUUID();
  await db.blob.create({ data: { id, ...place, taskId, store: "postgres", key: `postgres:${id}`, purpose, contentType, size: bytes.length, sha256: sha256(bytes) } });
  for (let at = 0, ordinal = 0; at < bytes.length; at += MiB, ordinal += 1) {
    await db.blobChunk.create({ data: { organizationId: place.organizationId, blobId: id, ordinal, offset: at, bytes: Buffer.from(bytes.subarray(at, at + MiB)) } });
  }
  return id;
};

/** Appends events after what the task holds, each turn's row as core's ingest makes it; returns the first new number. */
const storeEvents = async (place: Place, taskId: string, sessionId: string, events: readonly Timed[]): Promise<number> => {
  const start = (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { eventSeq: true } })).eventSeq + 1;
  let seq = start - 1;
  let turns = await db.turn.count({ where: { taskId } });
  for (const { at, event } of events) {
    seq += 1;
    await db.event.create({ data: { ...place, taskId, seq, sessionId, sessionSeq: event.kind === "user.message" || event.kind === "ticket.context_read" ? null : seq, leaseEpoch: null, kind: event.kind, payload: event, occurredAt: new Date(at) } });
    if (event.kind === "turn.started") {
      turns += 1;
      await db.turn.create({ data: { ...place, taskId, sessionId, ordinal: turns, startSeq: seq, startedAt: new Date(at) } });
    }
  }
  await db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
  await db.session.update({ where: { id: sessionId }, data: { ingestedSeq: seq } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq })})`;
  await db.$transaction((tx) => postgresChangeNotices.emitInTx(tx, { organizationId: organizationIdSchema.parse(place.organizationId), projectId: projectIdSchema.parse(place.projectId), entity: "task", entityId: taskIdSchema.parse(taskId) }));
  return start;
};

/** A file as the box wrote it and the thread records it: its row and its `user.message` entry. */
type SeedFile = {
  readonly name: string;
  readonly kind: "image" | "document" | "text" | "file";
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** A document's text, as core's reader made it. */
  readonly words?: number;
  readonly asImage?: boolean;
  readonly where?: "description" | "comment" | "attachment";
  readonly url?: string;
};

const fileRow = async (place: Place, taskId: string, file: SeedFile, input: { readonly origin: "member" | "ticket"; readonly memberId: string | null; readonly seq: number; readonly position: number; readonly sessionId: string }) => {
  const blobId = await storeBlob(place, taskId, input.origin === "member" ? "message-file" : "ticket-file", file.contentType, file.bytes);
  const textBlobId = file.words === undefined ? null : await storeBlob(place, taskId, "message-file-text", "text/markdown; charset=utf-8", new TextEncoder().encode("# The spec\n\nRound half up, to the cent."));
  const row = await db.messageFile.create({
    data: {
      ...place,
      taskId,
      memberId: input.memberId,
      origin: input.origin,
      state: "sent",
      sessionId: input.sessionId,
      eventSeq: input.seq,
      position: input.position,
      name: file.name,
      kind: file.kind,
      contentType: file.contentType,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
      blobId,
      boxPath: input.origin === "member" ? `attachments/${String(input.seq)}/${file.name}` : `ticket/${file.name}`,
      asImage: file.asImage ?? false,
      textState: file.words === undefined ? "none" : "ready",
      ...(file.words === undefined ? {} : { textWords: file.words, textBlobId }),
      ...(file.where === undefined ? {} : { ticketWhere: file.where }),
      ...(file.url === undefined ? {} : { ticketSourceKey: sha256(file.url) }),
      sentAt: new Date(),
    },
  });
  return {
    id: row.id,
    entry: {
      fileId: row.id,
      name: file.name,
      kind: file.kind,
      contentType: file.contentType,
      size: file.bytes.length,
      origin: input.origin,
      asImage: file.asImage ?? false,
      text: file.words === undefined ? "none" : "ready",
      ...(file.words === undefined ? {} : { textWords: file.words }),
    },
  };
};

const round = async (taskId: string, answer: "nothing-new" | "retry-loaded", picturePath: string): Promise<Record<string, string>> => {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const place = { organizationId: task.organizationId, projectId: task.projectId };
  const session = await db.session.findFirstOrThrow({ where: { taskId }, orderBy: { startedAt: "desc" } });
  const last = await db.taskTicketRead.findFirstOrThrow({ where: { taskId }, orderBy: { round: "desc" } });
  const next = last.round + 1;
  const seq = (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { eventSeq: true } })).eventSeq + 1;
  const fetched: string[] = [];
  if (answer === "retry-loaded") {
    const failed = await db.messageFile.findMany({ where: { taskId, origin: "ticket", state: "failed" }, orderBy: { position: "asc" } });
    for (const [index, row] of failed.entries()) {
      const bytes = new TextEncoder().encode(`fetched again: ${row.name}`);
      const picture = row.name.endsWith(".png");
      const content = picture ? new Uint8Array(await readFile(picturePath)) : bytes;
      const made = await fileRow(place, taskId, { name: row.name, kind: picture ? "image" : "document", contentType: picture ? "image/png" : "application/pdf", bytes: content, ...(picture ? { asImage: true } : { words: 640 }), where: "attachment" }, { origin: "ticket", memberId: null, seq, position: index, sessionId: session.id });
      await db.messageFile.update({ where: { id: made.id }, data: { retryOfId: row.id } });
      fetched.push(made.id);
    }
  }
  await storeEvents(place, taskId, session.id, [
    {
      at: Date.now(),
      event: taskEventSchema.parse({ kind: "ticket.context_read", round: next, reason: answer === "retry-loaded" ? "retry" : "member", description: null, comments: [], links: [], files: fetched, leftOut: [], failed: [] }),
    },
  ]);
  await db.taskTicketRead.create({ data: { ...place, taskId, round: next, reason: answer === "retry-loaded" ? "retry" : "member", descriptionSha256: last.descriptionSha256, comments: last.comments ?? [], fileKeys: [], eventSeq: null } });
  return { round: String(next) };
};

const world = async (input: Extract<z.infer<typeof argsSchema>, { readonly scenario: "world" }>): Promise<Record<string, string>> => {
  const username = `files-${input.tag}`;
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: input.password, role: "admin" });
  if (!seeded.ok) throw new Error(`seeding ${username} failed: ${seeded.error}`);
  await db.user.update({ where: { id: seeded.seeded.userId }, data: { name: "Sam Rivera" } });
  const admin = await db.member.findUniqueOrThrow({ where: { id: seeded.seeded.memberId } });
  const organizationId = admin.organizationId;

  // Two models on one key: Claude reads images (its admin said so), DeepSeek is text only.
  const provider = await db.modelProvider.create({
    data: { organizationId, name: `files-key-${input.tag}`, baseUrl: "https://files-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: `builtin:files-${input.tag}`, allowOnPersonalRunners: true },
  });
  const claude = await db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-5-5", catalogId: "anthropic/claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", adminImageInput: true, inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" } });
  const deepseek = await db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "deepseek-v4-1-flash", catalogId: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", adminImageInput: false, inputPricePerMTok: 0.3, outputPricePerMTok: 1.2, priceSource: "catalog" } });
  const sonnet = await db.agentProfile.create({ data: { organizationId, name: `Default ${input.tag}`, adapter: "opencode", modelId: claude.id, modelCatalogId: "anthropic/claude-sonnet-5-5", providerId: provider.id } });
  const fast = await db.agentProfile.create({ data: { organizationId, name: `Fast fixes ${input.tag}`, adapter: "opencode", modelId: deepseek.id, modelCatalogId: "deepseek/deepseek-v4.1-flash", providerId: provider.id } });

  const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `calculator-${input.tag}`, access: "open", ownProviders: true, defaultCodeProfileId: fast.id } });
  await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
  const place = { organizationId, projectId: project.id };
  // The repo's GitHub, as rows: the spec reads nothing from it.
  const github =
    (await db.connection.findFirst({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } })) ??
    (await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-files-${input.tag}`, slug: `e2e-files-${input.tag}`, state: "active" } }));
  const installation =
    (await db.codeHostInstallation.findFirst({ where: { organizationId, connectionId: github.id }, orderBy: { createdAt: "asc" } })) ??
    (await db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: `inst-files-${input.tag}`, accountLogin: "acme", accountKind: "organization" } }));
  await db.repo.create({
    data: { ...place, connectionId: github.id, installationId: installation.installationId, hostRepoId: `e2e-files-${input.tag}`, fullName: "acme/calculator-web", defaultBranch: "main", checkoutDir: "calculator-web" },
  });

  // The runners: build-fleet-03 at minor 8, which takes files, and alex-laptop at minor 7, which doesn't.
  // alex-laptop is Alex's: the new-task box offers Sam his own runners only.
  const alexName = `${username}-alex`;
  const alex = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: alexName, email: `${alexName}@example.com`, password: input.password, role: "member" });
  if (!alex.ok) throw new Error(`seeding ${alexName} failed: ${alex.error}`);
  const runnerOf = async (name: string, minor: number, ownerMemberId: string) => {
    const runner = await db.runner.create({
      data: { organizationId, kind: "personal", ownerMemberId, name, publicKey: `e2e-files-${randomUUID()}`, executor: "host", capacity: 4, slots: 4, version: "0.9.0", minor, state: "online", lastSeenAt: FOREVER },
    });
    await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-files", connectionEpoch: 1, carrier: "websocket", minor, connectedAt: new Date(), lastSeenAt: FOREVER } });
    return runner;
  };
  const fleet = await runnerOf(`build-fleet-03-${input.tag}`, 8, admin.id);
  const old = await runnerOf(`alex-laptop-${input.tag}`, 7, alex.seeded.memberId);

  const read = async (path: string) => new Uint8Array(await readFile(path));
  const pictures = { mock: await read(input.files.mock), pasted: await read(input.files.pasted), wrong: await read(input.files.wrong), right: await read(input.files.right), phone: await read(input.files.phone) };
  const docx = await read(input.files.docx);
  const pdf = await read(input.files.pdf);
  const csv = new TextEncoder().encode("expression,expected\n12.5% of 845,105.63\n");

  /** A task Sam drives, in a ready box on a runner, its session going (`idle` while it waits on him). */
  const taskOf = async (title: string, options: { readonly state: "running" | "needs_you"; readonly profile: typeof sonnet; readonly runner: typeof fleet; readonly ticket?: { readonly id: string; readonly key: string; readonly prompt: string; readonly boardId: string } }) => {
    const task = await db.task.create({
      data: {
        ...place,
        kind: "code",
        source: options.ticket === undefined ? "prompt" : "ticket",
        title,
        prompt: options.ticket?.prompt ?? title,
        branchName: `ostra/${randomUUID().slice(0, 8)}-files`,
        state: options.state,
        ...(options.state === "needs_you" ? { needsYouReason: "question" as const } : {}),
        agentProfileId: options.profile.id,
        driverMemberId: admin.id,
        creatorMemberId: admin.id,
        runnerId: options.runner.id,
        leaseEpoch: 1,
        ...(options.ticket === undefined ? {} : { ticketId: options.ticket.id, ticketKey: options.ticket.key, boardId: options.ticket.boardId }),
      },
    });
    const box = await db.box.create({ data: { ...place, taskId: task.id, runnerId: options.runner.id, executor: "host", state: options.state === "running" ? "ready" : "idle", readyAt: new Date(Date.now() - 30 * 60_000), ...(options.state === "running" ? {} : { idleSince: new Date(Date.now() - 2 * 60_000) }) } });
    const session = await db.session.create({
      data: { ...place, taskId: task.id, origin: "new", state: options.state === "running" ? "running" : "idle", agentProfileId: options.profile.id, providerId: provider.id, modelId: options.profile.modelId ?? claude.id, boxId: box.id },
    });
    // The runner holds it: a send goes to its session (no runner answers here; the message is the task's either way).
    await db.lease.create({ data: { ...place, taskId: task.id, epoch: 1, runnerId: options.runner.id, boxId: box.id, state: "active", acceptedAt: new Date(Date.now() - 30 * 60_000) } });
    return { taskId: task.id, sessionId: session.id };
  };

  const now = Date.now();
  const ago = (minutes: number) => now - minutes * 60_000;
  const message = (text: string, at: number, extra: Record<string, unknown> = {}): Timed => ({
    at,
    event: taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text, delivery: "immediate", ...extra }),
  });
  const turn = (text: string, at: number): Timed[] => {
    const turnId = randomUUID();
    return [
      { at, event: taskEventSchema.parse({ kind: "turn.started", turnId }) },
      { at: at + 1_000, event: taskEventSchema.parse({ kind: "agent.message", turnId, segmentId: `seg-${turnId.slice(0, 8)}`, text }) },
      { at: at + 2_000, event: taskEventSchema.parse({ kind: "turn.ended", turnId, stopReason: "end_turn" }) },
    ];
  };

  // 1. The composer: OpenCode asked for a design, and the task waits on Sam's reply.
  const composer = await taskOf("Add a history panel", { state: "needs_you", profile: sonnet, runner: fleet });
  await storeEvents(place, composer.taskId, composer.sessionId, [
    message("Add a history panel beside the calculator: the last 50 results, newest first. Clicking one puts it back in the display.", ago(34)),
    ...turn("The store keeps the last 50 results, newest first, and the panel reads from it. Before I style the panel: is there a design for it? I can match a mock, or follow the keypad's spacing.", ago(33)),
  ]);

  // 2. The thread: Sam's reply with Dana's mock, a pasted screenshot and three files, then OpenCode reads them.
  const thread = await taskOf("Add a history panel", { state: "running", profile: sonnet, runner: fleet });
  await storeEvents(place, thread.taskId, thread.sessionId, [message("Add a history panel beside the calculator: the last 50 results, newest first.", ago(40)), ...turn("The store keeps the last 50 results, newest first, and the panel reads from it. Before I style the panel: is there a design for it?", ago(39))]);
  const replySeq = (await db.task.findUniqueOrThrow({ where: { id: thread.taskId }, select: { eventSeq: true } })).eventSeq + 1;
  const memberFiles: SeedFile[] = [
    { name: "history-panel-mock.png", kind: "image", contentType: "image/png", bytes: pictures.mock, asImage: true },
    { name: "Pasted image 14.51.08.png", kind: "image", contentType: "image/png", bytes: pictures.pasted, asImage: true },
    { name: "history-panel-spec.docx", kind: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx, words: 2140 },
    { name: "brand-guide.pdf", kind: "document", contentType: "application/pdf", bytes: pdf, words: 6210 },
    { name: "results-sample.csv", kind: "text", contentType: "text/plain", bytes: csv },
  ];
  const sent = [];
  for (const [position, file] of memberFiles.entries()) sent.push(await fileRow(place, thread.taskId, file, { origin: "member", memberId: admin.id, seq: replySeq, position, sessionId: thread.sessionId }));
  await storeEvents(place, thread.taskId, thread.sessionId, [
    message("Here's Dana's mock and the spec. Keep \"Use\" on the right of each row, and use the sample for the tests.", ago(8), { files: sent.map((one) => one.entry), imagesNotSent: null }),
    ...turn("Matching Dana's mock: \"Use\" on the right, the expression over the value, and the spec's empty state.", ago(7)),
  ]);

  // 3. A task on the text-only model, and one on a runner too old for files.
  const textOnly = await taskOf("Fix rounding in percent mode", { state: "needs_you", profile: fast, runner: fleet });
  await storeEvents(place, textOnly.taskId, textOnly.sessionId, [message("Percent mode rounds half-cents down. Make it round half up, to the cent.", ago(20)), ...turn("I can't reproduce it: 12.5% of 845 gives 105.63 in the tests. Which screen shows 105.62? A screenshot would help.", ago(19))]);
  const oldTask = await taskOf("Keep the last 50 results", { state: "needs_you", profile: sonnet, runner: old });
  await storeEvents(place, oldTask.taskId, oldTask.sessionId, [message("Keep the last 50 results.", ago(15)), ...turn("Which order should the results keep?", ago(14))]);

  // 4. Tasks from a Linear ticket: what the agent got, in four ways.
  const linear =
    (await db.connection.findFirst({ where: { organizationId, kind: "linear" } })) ??
    (await db.connection.create({ data: { organizationId, kind: "linear", appId: `e2e-files-linear-${input.tag}`, state: "active", credentialKind: "api_key", externalWorkspaceKey: "ostra-test" } }));
  const board = await db.board.create({
    data: { ...place, connectionId: linear.id, externalId: `files-team-${input.tag}`, name: "Calculator", key: "CALC", statusMap: { open: ["s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" } },
  });
  const description =
    "Percent mode rounds half-cents down. 12.5% of 845 shows `105.62`; finance expects `105.63`: half up, to the cent, on the final value only. The tax line in Billing has the same bug, but that's BIL-91. Steps: open Tally, switch to percent mode, enter 845, then 12.5, then =.\n\n![wrong-total.png](https://uploads.linear.app/files/wrong-total.png)\n\nThe phone build shows the same, and the desktop build since 2.14.";
  const comments = [
    { id: "c-1", author: "Dana Ortiz", at: now - 2 * 86_400_000, body: "Design says the display should keep two decimals.", edited: false },
    { id: "c-2", author: "Marcus Lee", at: now - 86_400_000, body: "Finance confirmed: half up, to the cent. Their rules are in the docx.", edited: false },
    { id: "c-3", author: "Priya Shah", at: now - 20 * 3_600_000, body: "Repro on 2.14 and on main. Screenshots attached, the phone build too.", edited: false },
  ];
  const ticketTask = async (key: string, variant: "all" | "skipped" | "failed" | "none") => {
    const ticket = await db.ticket.create({
      data: {
        ...place,
        boardId: board.id,
        connectionId: linear.id,
        externalId: `files-${key}-${input.tag}`,
        key,
        title: "Fix rounding in percent mode",
        description,
        statusId: "s-progress",
        statusName: "In Progress",
        statusCategory: "started",
        priority: 2,
        labels: ["bug", "billing"],
        url: `https://linear.app/ostra-test/issue/${key}`,
        open: true,
        trackerUpdatedAt: new Date(),
      },
    });
    const prompt = `You're working on ${key}: Fix rounding in percent mode.\n\n<ticket>\n${description}\n</ticket>\n\nThe ticket's files are in .ostra/ticket/.`;
    const ids = await taskOf("Fix rounding in percent mode", { state: "running", profile: sonnet, runner: fleet, ticket: { id: ticket.id, key, prompt, boardId: board.id } });
    const startSeq = 1;
    const given: SeedFile[] =
      variant === "none"
        ? []
        : [
            ...(variant === "failed" ? [] : [{ name: "wrong-total.png", kind: "image" as const, contentType: "image/png", bytes: pictures.wrong, asImage: true, where: "description" as const, url: "https://uploads.linear.app/files/wrong-total.png" }]),
            { name: "right-total.png", kind: "image", contentType: "image/png", bytes: pictures.right, asImage: true, where: "comment" },
            { name: "phone-total.png", kind: "image", contentType: "image/png", bytes: pictures.phone, asImage: true, where: "comment" },
            ...(variant === "skipped" ? Array.from({ length: 13 }, (_, i): SeedFile => ({ name: `checkout-flow-${String(i + 1)}.png`, kind: "image", contentType: "image/png", bytes: pictures.pasted, asImage: true, where: "attachment" })) : []),
            { name: "rounding-rules.docx", kind: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx, words: 1830, where: "attachment" },
            ...(variant === "failed" ? [] : [{ name: "IEEE-754-note.pdf", kind: "document" as const, contentType: "application/pdf", bytes: pdf, words: 3400, where: "attachment" as const }]),
            { name: "percent-cases.csv", kind: "text", contentType: "text/plain", bytes: csv, where: "attachment" },
          ];
    const rows = [];
    for (const [position, file] of given.entries()) rows.push(await fileRow(place, ids.taskId, file, { origin: "ticket", memberId: null, seq: startSeq, position: variant === "failed" && position > 0 ? position + 1 : position, sessionId: ids.sessionId }));
    // What didn't make it: left out by the ticket's limits, or failed to load; each keeps its place.
    const notes: { readonly name: string; readonly state: "left_out" | "failed"; readonly reason: string; readonly size: number; readonly position: number }[] =
      variant === "skipped"
        ? [
            { name: "support-call.mp4", state: "left_out", reason: "too-big", size: 84 * MiB, position: 100 },
            { name: "logs-november.zip", state: "left_out", reason: "too-big", size: 31 * MiB, position: 101 },
            { name: "checkout-flow-14.png", state: "left_out", reason: "too-many", size: 0, position: 102 },
          ]
        : variant === "failed"
          ? [
              { name: "wrong-total.png", state: "failed", reason: "download-failed", size: 0, position: 0 },
              { name: "IEEE-754-note.pdf", state: "failed", reason: "download-failed", size: 0, position: 4 },
            ]
          : [];
    for (const note of notes) {
      await db.messageFile.create({
        data: { ...place, taskId: ids.taskId, origin: "ticket", state: note.state, reason: note.reason, sessionId: ids.sessionId, eventSeq: startSeq, position: note.position, name: note.name, kind: "file", contentType: "application/octet-stream", size: note.size, ticketWhere: "attachment", createdAt: new Date(ago(1)) },
      });
    }
    await storeEvents(place, ids.taskId, ids.sessionId, [
      message(prompt, ago(2), { files: rows.map((one) => one.entry), imagesNotSent: null }),
      {
        at: ago(2),
        event: taskEventSchema.parse({
          kind: "ticket.context_read",
          round: 1,
          reason: "start",
          description,
          comments: comments.map((comment) => ({ author: comment.author, at: comment.at, body: comment.body, edited: comment.edited })),
          links: variant === "skipped" ? [] : [{ title: "Sentry · ACME-WEB-4F2", url: "https://sentry.io/acme/web/issues/4f2" }],
          files: rows.map((one) => one.id),
          leftOut: notes.filter((note) => note.state === "left_out").map((note) => ({ name: note.name, reason: note.reason })),
          failed: notes.filter((note) => note.state === "failed").map((note) => ({ name: note.name, reason: note.reason })),
          ...(variant === "none" ? { filesNotFetched: true } : {}),
        }),
      },
      ...turn("Reading the rounding rules first: .ostra/ticket/rounding-rules.docx.md.", ago(1)),
    ]);
    await db.taskTicketRead.create({
      data: { ...place, taskId: ids.taskId, round: 1, reason: "start", descriptionSha256: sha256(description), comments: comments.map((comment) => ({ id: comment.id, updatedAt: new Date(comment.at).toISOString() })), fileKeys: [], eventSeq: startSeq },
    });
    return ids.taskId;
  };

  return {
    username,
    projectId: project.id,
    composerTaskId: composer.taskId,
    threadTaskId: thread.taskId,
    textOnlyTaskId: textOnly.taskId,
    oldRunnerTaskId: oldTask.taskId,
    ticketTaskId: await ticketTask("CALC-170", "all"),
    skippedTaskId: await ticketTask("CALC-171", "skipped"),
    failedTaskId: await ticketTask("CALC-172", "failed"),
    noneTaskId: await ticketTask("CALC-173", "none"),
    claudeModelId: claude.id,
    deepseekModelId: deepseek.id,
    providerId: provider.id,
  };
};

const output = args.scenario === "world" ? await world(args) : await round(args.taskId, args.answer, args.picture);
process.stdout.write(`${JSON.stringify(output)}\n`);
await db.$disconnect();
