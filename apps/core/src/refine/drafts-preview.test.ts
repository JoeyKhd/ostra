import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import type { TrackerAdapter } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createApiHarness, seedBoard, seedLinearConnection } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { postgresChangeNotices, saveDraft, systemClock } from "@ostra/domain";
import { draftIdSchema, externalTicketIdSchema, taskIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, RefineDraft, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { jobContext } from "../testing/turns.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";
import { ticketSyncHandler } from "../tracker/writer.ts";
import { draftApplyHandler } from "./apply.ts";

// Milestone 6's ticket 27 (F-099): the panel's preview of a refine draft is what "Update ticket"
// writes. The draft is read through the panel's `drafts.get`, sent with `drafts.updateTicket`, and
// written by core's `draft.apply` (the job the API enqueued) to the shipped Linear adapter on the
// fake Linear, and to the Jira fake, whose criteria are a field of their own. The ticket each
// tracker then holds is compared with the preview, character for character.

let harness: ApiHarness;
let fake: FakeLinear;
let site: JiraSite;
let jira: JiraFakeAdapter;
let linear: LinearAdapter;
let connectionId: ConnectionId;
let linearBoard: BoardId;
let jiraBoard: BoardId;
const blobBytes = new Map<string, Uint8Array>();

const draft = (): RefineDraft => ({
  description: "Make the footer fast. `rm -rf /` is not the fix.",
  acceptanceCriteria: ["The footer renders in under 1 s", "No layout shift"],
  edgeCases: ["An empty footer"],
  openQuestions: ["Keep the old footer behind a flag?"],
  subTickets: [],
});

/** Every ticket text `draft.apply` sent through the adapter's `updateTicket`, as it sent it. */
const written: { description?: string; acceptanceCriteria?: string }[] = [];

/** The adapter as the panel and core both get it, with its `updateTicket` calls recorded. */
const use = (adapter: TrackerAdapter): void => {
  harness.fakes.tracker.adapter = new Proxy(adapter, {
    get: (target, property, receiver): unknown => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      // The adapters keep private fields: their methods run on the adapter itself.
      if (property !== "updateTicket") return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      return (...args: Parameters<TrackerAdapter["updateTicket"]>) => {
        written.push({ ...args[2] });
        return target.updateTicket(...args);
      };
    },
  });
};

/** A refine task on a ticket made in the tracker, waiting on the agent's first version. */
const refineTaskOn = async (tracker: "linear" | "jira"): Promise<{ readonly taskId: TaskId; readonly externalId: string }> => {
  const { a } = harness.fixture;
  const made =
    tracker === "linear"
      ? await fake.createIssue({ title: "Speed up the footer", description: "It's slow." }).then((issue) => ({ externalId: issue.id, key: issue.identifier }))
      : site.createIssue(site.projects[0]?.id ?? "", { summary: "Speed up the footer", description: "It's slow." });
  const boardId = tracker === "linear" ? linearBoard : jiraBoard;
  const ticket = await harness.test.db.ticket.create({
    data: {
      organizationId: a.organization.id,
      projectId: a.openProject.id,
      boardId,
      connectionId,
      externalId: made.externalId,
      key: made.key,
      title: "Speed up the footer",
      description: "It's slow.",
      statusId: "st",
      statusName: "Todo",
      statusCategory: "open",
      open: true,
      labels: [],
      url: `https://tracker.example/${made.key}`,
      trackerUpdatedAt: new Date(),
    },
    select: { id: true },
  });
  const task = await harness.test.db.task.create({
    data: {
      organizationId: a.organization.id,
      projectId: a.openProject.id,
      kind: "refine",
      source: "ticket",
      title: "Refine the footer",
      branchName: `ostra/${randomBytes(4).toString("hex")}-refine`,
      state: "needs_you",
      needsYouReason: "draft_ready",
      ticketId: ticket.id,
      ticketKey: made.key,
      boardId,
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(task.id);
  const saved = await harness.test.db.$transaction((tx) => saveDraft({ tx, ...harness.deps.ports }, { organizationId: a.organization.id, taskId, draft: draft() }));
  expect(saved).toMatchObject({ ok: true });
  return { taskId, externalId: made.externalId };
};

/** The member edits, adds an image, previews, then "Update ticket"; core's job writes it. */
const previewThenWrite = async (taskId: TaskId) => {
  const member = await harness.as(harness.fixture.a.member);
  await member.drafts.save({ taskId, baseVersion: 1, fields: { ...draft(), description: "Make the footer fast, edited." } });
  const image = Buffer.from("PNG-bytes");
  await member.drafts.addImage({ taskId, name: "footer.png", contentType: "image/png", data: image.toString("base64") });
  const blobId = harness.uploads.at(-1)?.blobId ?? "";
  blobBytes.set(blobId, new Uint8Array(image));
  const view = await member.drafts.get({ taskId, version: null });
  harness.fakes.jobs.clear();
  await member.drafts.updateTicket({ taskId, version: 2 });
  const job = harness.fakes.jobs.jobs.find((sent) => sent.job === "draft.apply");
  await runApply(job?.payload);
  return view.preview;
};

/** Core's `draft.apply` on the payload the API enqueued. */
const runApply = async (sent: unknown): Promise<void> => {
  const payload = z.object({ draftId: z.string(), version: z.number() }).parse(sent);
  await draftApplyHandler({
    db: harness.test.db,
    trackers: createConnectionTrackers({ db: harness.test.db, secretStore: harness.fakes.secretStore, clock: systemClock, logger: silentLogger, build: () => harness.fakes.tracker.adapter }),
    notices: postgresChangeNotices,
    clock: systemClock,
    publicUrl: harness.deps.settings.publicUrl,
    logger: silentLogger,
    readBlob: (_organizationId, id) => Promise.resolve(blobBytes.get(id) ?? null),
  })(jobContext("draft.apply", { organizationId: harness.fixture.a.organization.id, draftId: draftIdSchema.parse(payload.draftId), version: payload.version }, silentLogger));
};

beforeAll(async () => {
  harness = await createApiHarness();
  fake = await createFakeLinear();
  fake.createApp({ name: "ostra", redirectUris: ["http://localhost:3000/api/linear/callback"], webhookUrl: null });
  linear = new LinearAdapter({ apiUrl: fake.apiUrl, auth: { kind: "oauth", token: fake.mintToken("app").accessToken } });
  site = createJiraSite();
  jira = new JiraFakeAdapter({ site });
  connectionId = await seedLinearConnection(harness);
  const projectId = harness.fixture.a.openProject.id;
  linearBoard = await seedBoard(harness, { projectId, connectionId, externalId: fake.team.id });
  jiraBoard = await seedBoard(harness, { projectId, connectionId, externalId: site.projects[0]?.id ?? "", key: "JIRA" });
});

afterAll(async () => {
  await fake.close();
  await harness.dispose();
});

describe("the draft's preview (F-099, ticket 27)", () => {
  it("F-099/c6: the preview equals what Update ticket writes to Linear: the criteria in the description, the image attached", async () => {
    use(linear);
    const { taskId, externalId } = await refineTaskOn("linear");
    written.length = 0;
    const preview = await previewThenWrite(taskId);
    expect(preview?.description).toContain("## Acceptance criteria");
    expect(preview?.acceptanceCriteria).toBeNull();
    expect(preview?.attachments).toEqual(["footer.png"]);
    expect(written).toEqual([{ description: preview?.description }]);
    // And Linear holds it as it was written.
    const read = await linear.getTicketContext({ externalId: fake.team.id }, { externalId: externalTicketIdSchema.parse(externalId) });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.ticket.description).toBe(preview?.description);
    expect(fake.issueView(externalTicketIdSchema.parse(externalId)).attachments).toHaveLength(1);
  });

  it("F-099/c6: the preview equals what Update ticket writes to the Jira fake: the criteria in their own field", async () => {
    use(jira);
    const { taskId, externalId } = await refineTaskOn("jira");
    written.length = 0;
    const preview = await previewThenWrite(taskId);
    expect(preview?.description).not.toContain("## Acceptance criteria");
    expect(preview?.acceptanceCriteria).toBe("- The footer renders in under 1 s\n- No layout shift");
    expect(written).toEqual([{ description: preview?.description, acceptanceCriteria: preview?.acceptanceCriteria }]);
    const read = await jira.getTicketContext({ externalId: site.projects[0]?.id ?? "" }, { externalId: externalTicketIdSchema.parse(externalId) });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.ticket.acceptanceCriteria).toContain("The footer renders in under 1 s");
  });

  it("F-099/c6: Create ticket on a prompt refine task makes the ticket, then writes its draft's sub-tickets under it", async () => {
    use(linear);
    const { a } = harness.fixture;
    const task = await harness.test.db.task.create({
      data: {
        organizationId: a.organization.id,
        projectId: a.openProject.id,
        kind: "refine",
        source: "prompt",
        title: "Refine the search page",
        prompt: "Refine the search page",
        branchName: `ostra/${randomBytes(4).toString("hex")}-refine`,
        state: "needs_you",
        needsYouReason: "draft_ready",
      },
      select: { id: true },
    });
    const taskId = taskIdSchema.parse(task.id);
    const withSub = { ...draft(), subTickets: [{ title: "Index the titles", description: "A GIN index." }] };
    await harness.test.db.$transaction((tx) => saveDraft({ tx, ...harness.deps.ports }, { organizationId: a.organization.id, taskId, draft: withSub }));
    const member = await harness.as(a.member);
    harness.fakes.jobs.clear();
    const made = await member.drafts.createTicket({ taskId, version: 1, boardId: linearBoard });
    // Nothing of the draft goes before the ticket exists.
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "draft.apply")).toHaveLength(0);
    const trackers = createConnectionTrackers({ db: harness.test.db, secretStore: harness.fakes.secretStore, clock: systemClock, logger: silentLogger, build: () => harness.fakes.tracker.adapter });
    await ticketSyncHandler({ db: harness.test.db, trackers, clock: systemClock, publicUrl: harness.deps.settings.publicUrl, logger: silentLogger, jobs: harness.fakes.jobs })(
      jobContext("ticket.sync", { organizationId: a.organization.id, ticketWriteId: ticketWriteIdSchema.parse(made.ticketWriteId) }, silentLogger),
    );
    const linked = await harness.test.db.task.findUniqueOrThrow({ where: { id: taskId }, include: { ticket: true } });
    expect(linked.ticket?.title).toBe("Refine the search page");
    const apply = harness.fakes.jobs.jobs.filter((job) => job.job === "draft.apply");
    expect(apply).toHaveLength(1);
    await runApply(apply[0]?.payload);
    const read = await linear.getTicketContext({ externalId: fake.team.id }, { externalId: externalTicketIdSchema.parse(linked.ticket?.externalId ?? "") });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.ticket.description).toContain("## Acceptance criteria");
    expect(read.value.children.map((child) => child.title)).toEqual(["Index the titles"]);
  });
});
