import type { TrackerAdapter } from "../../tracker/base.ts";
import type { AdfNode } from "../jira-fake.ts";
import type { TrackerFilesHooks, TrackerSuiteFixture } from "../tracker-suite.ts";
import type { FakeJira } from "./fake-jira.ts";

// The tracker contract suite's fixture on the fake Jira (ADR 0025, Q104): this site with a second
// project, and an adapter on another organization's site. The adapter under test is built with the
// fake's site, its gateway and cloud ID (`mode: "gateway"`, a scoped token, ADR 0047) or the site
// alone (`mode: "site"`, a classic token), and the service account's credential. `webhookMaxAgeMs`
// is the adapter's own freshness window, which the suite's stale delivery steps past.

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A zip's first bytes: an Office file as far as the fake cares. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%fake\n");

const paragraph = (text: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text }] });

/** A `media` node as Jira's editor writes an upload: by its media ID, with the file's name as `alt`. */
const mediaOf = (container: "mediaSingle" | "mediaGroup", upload: { readonly mediaId: string }, name: string): AdfNode => ({
  type: container,
  content: [{ type: "media", attrs: { type: "file", id: upload.mediaId, collection: "", alt: name } }],
});

const doc = (content: readonly AdfNode[]): AdfNode => ({ type: "doc", attrs: {}, content: [...content] });

/** The files cases' hooks on a fake Jira, as Jira's editor makes them: an upload is an attachment, and a media node shows it. */
export const fakeJiraFilesHooks = (fake: FakeJira, mode: "gateway" | "site"): TrackerFilesHooks => {
  const fileUrl = (id: string): string => `${fake.apiUrl(mode)}/rest/api/3/attachment/content/${id}`;
  const holder = (summary: string): string => fake.createIssue({ summary }).id;
  return {
    seedTicketWithFiles: () => {
      const created = fake.createIssue({ summary: "With files" });
      const mock = fake.attach(created.id, { name: "mock.png", contentType: "image/png", bytes: PNG_BYTES });
      const spec = fake.attach(created.id, { name: "spec.docx", contentType: DOCX_TYPE, bytes: ZIP_BYTES });
      const shot = fake.attach(created.id, { name: "broken.png", contentType: "image/png", bytes: PNG_BYTES });
      const design = fake.attach(created.id, { name: "design.pdf", contentType: "application/pdf", bytes: PDF_BYTES });
      fake.setDescription(created.id, doc([paragraph("Match the mock; the spec is attached. $(whoami)"), mediaOf("mediaSingle", mock, "mock.png"), mediaOf("mediaGroup", spec, "spec.docx")]));
      const commentId = fake.addComment(created.id, doc([paragraph("Here it breaks:"), mediaOf("mediaSingle", shot, "broken.png")]));
      const figma = "https://www.figma.com/file/0196f1a0/History?node-id=1-2";
      fake.addRemoteLink(created.id, { url: figma, title: "History panel (Figma)" });
      // On the site's file host, but on another issue: the suite's ostra comment shows it.
      const spare = fake.attach(holder("Holds a spare image"), { name: "progress.png", contentType: "image/png", bytes: PNG_BYTES });
      return Promise.resolve({
        externalId: created.id,
        key: created.key,
        descriptionImage: fileUrl(mock.id),
        descriptionFile: fileUrl(spec.id),
        commentId,
        commentImage: fileUrl(shot.id),
        attachedFile: fileUrl(design.id),
        linkAttachment: figma,
        spareImage: fileUrl(spare.id),
      });
    },
    followUpText: () => {
      const id = holder("A follow-up's files");
      const image = fake.attach(id, { name: "follow-up.png", contentType: "image/png", bytes: PNG_BYTES });
      const file = fake.attach(id, { name: "numbers.xlsx", contentType: XLSX_TYPE, bytes: ZIP_BYTES });
      const offHost = "https://files.example.test/rest/api/3/attachment/content/1";
      // The comment as the adapter reads it: each upload a link to its attachment.
      return Promise.resolve({
        text: `Also look at these:\n\n![follow-up.png](${fileUrl(image.id)})\n\n[numbers.xlsx](${fileUrl(file.id)}) and [the old one](${offHost})`,
        image: fileUrl(image.id),
        file: fileUrl(file.id),
        offHost,
      });
    },
    seedFile: (size) => Promise.resolve(fileUrl(fake.attach(holder("Holds a sized file"), { name: "sized.bin", contentType: "application/octet-stream", bytes: new Uint8Array(size).fill(7) }).id)),
    seedEndlessFile: () => Promise.resolve(fileUrl(fake.attachEndless(holder("Holds an endless file")).id)),
  };
};

export const fakeJiraSuiteFixture = (input: {
  readonly fake: FakeJira;
  readonly other: TrackerAdapter;
  readonly mode: "gateway" | "site";
  readonly webhookMaxAgeMs: number;
}): TrackerSuiteFixture => {
  const { fake } = input;
  const ops = fake.addProject("OPS", "Operations");
  const status = (name: string): string => {
    const found = fake.statuses.find((one) => one.name === name);
    if (found === undefined) throw new Error(`the fake Jira has no status ${name}`);
    return found.id;
  };
  return {
    board: { externalId: fake.project.id },
    boardKey: fake.project.key,
    otherBoard: { externalId: ops.id },
    mapping: { started: status("In Progress"), inReview: status("In Review"), done: status("Done") },
    other: input.other,
    webhookSecret: fake.webhookSecret,
    webhookMaxAgeMs: input.webhookMaxAgeMs,
    ownUserId: fake.serviceAccount.accountId,
    integrationInstalled: false,
    now: () => fake.clock.now(),
    advance: (ms) => {
      fake.clock.advance(ms);
      return Promise.resolve();
    },
    seedTicket: (ticket) => {
      const created = fake.createIssue({
        summary: ticket.title,
        ...(ticket.description === undefined ? {} : { description: ticket.description }),
        ...(ticket.labels === undefined ? {} : { labels: ticket.labels }),
        ...(ticket.comments === undefined ? {} : { comments: ticket.comments }),
        ...(ticket.withImage === undefined ? {} : { withImage: ticket.withImage }),
      });
      return Promise.resolve({ externalId: created.id, key: created.key });
    },
    editTicket: (externalId, title) => {
      fake.editIssue(externalId, { summary: title });
      return Promise.resolve();
    },
    moveToOtherBoard: (externalId) => Promise.resolve(fake.moveIssue(externalId, ops.id)),
    signedDelivery: (delivery) =>
      Promise.resolve(
        fake.signedDelivery({
          issueId: delivery.ticket.externalId,
          byAccountId: delivery.byOwnUser ? fake.serviceAccount.accountId : fake.person.accountId,
          sentAt: delivery.sentAt,
        }),
      ),
    rateLimitNext: (retryAfterSeconds) => {
      fake.injectFaults([{ kind: "rate-limited", retryAfterSeconds }]);
      return Promise.resolve();
    },
    seedUser: (email) => Promise.resolve({ userId: fake.addAccount({ displayName: `Seeded ${email.split("@")[0] ?? "user"}`, email }).accountId }),
    // Milestone 6: people by account ID; Jira has no agent sessions, so no session hooks.
    milestone6: { seedPerson: (person) => Promise.resolve({ userId: fake.addAccount({ displayName: person.name, email: person.email }).accountId }) },
    files: fakeJiraFilesHooks(fake, input.mode),
  };
};
