import { randomUUID } from "node:crypto";

import { memberIdSchema, organizationIdSchema, runnerIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { previewNotificationKinds, runnerNotificationKinds, teamNotificationKinds } from "../notification/base.ts";
import type {
  AccountNotification,
  MomentNotification,
  NotificationAdapter,
  NotificationRecipient,
  PreviewNotificationKind,
  RunnerNotificationKind,
  TeamNotificationKind,
} from "../notification/base.ts";
import type { LogRecord } from "../plumbing/logger.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every notification adapter passes (milestone 3, ticket 04; ADR 0050): the panel's, the
// tracker's (ticket 11), the two email ones (tickets 12 and 13) and Slack's (F-057), each against
// its own fake (the in-memory rows, the fake Linear server and the Jira fake, the fake Resend API,
// the fake SMTP server and `fake-slack/`). A notification goes out once per key; a recipient the
// channel can't reach is reported without failing the others; a rate limit is `rate-limited`; an
// email carries the link and the subject in both its parts; an adapter with `edits` edits in place.

/** What the channel delivered, as its fake saw it: by the provider's ID. */
export type DeliveredNotification = {
  readonly providerMessageId: string;
  /** The addresses, accounts or mentions it reached. */
  readonly to: readonly string[];
  readonly subject: string;
  /** An email's HTML part, `null` for a channel without one. */
  readonly html: string | null;
  /** The text that reached the recipient: an email's text part, a comment, a row's line. */
  readonly text: string;
};

export type NotificationSuiteFixture = {
  /** A recipient the channel reaches. */
  readonly reachable: NotificationRecipient;
  /** A second one it reaches, for the case with several. */
  readonly alsoReachable: NotificationRecipient;
  /** A recipient the channel refuses: no address, an address the fake refuses, no mention. Absent: the channel reaches every member. */
  readonly refused?: NotificationRecipient;
  /** Makes the channel's next call answer a rate limit. Absent: the case is skipped. */
  readonly rateLimitNext?: () => void;
  /** Everything the channel delivered so far. */
  readonly delivered: () => Promise<readonly DeliveredNotification[]>;
  /** Fills in what this channel needs of a notification (the ticket, the row), around the suite's own fields. */
  readonly prepare?: (notification: MomentNotification) => MomentNotification | Promise<MomentNotification>;
  /** Milestone 4: every line the adapter logged so far, to check an account mail's link and address never reach one. */
  readonly logs: () => readonly LogRecord[];
};

const organizationId = organizationIdSchema.parse("org-notification-suite");

let keys = 0;

/** A notification of an approval, with a key of its own and its parts rendered for email. */
export const sampleNotification = (recipients: readonly NotificationRecipient[]): MomentNotification => {
  keys += 1;
  const url = `https://ostra.example/t/task-1?item=${String(keys)}`;
  const subject = "Add CONTRIBUTING.md";
  return {
    organizationId,
    memberIds: recipients.map((recipient) => recipient.memberId),
    title: "An approval needs you",
    body: `The agent asks to run pnpm add zod. Open it: ${url}`,
    url,
    idempotencyKey: `suite:${String(keys)}:${String(Date.now())}`,
    kind: "approval",
    recipients,
    subject,
    rendered: {
      subject: `Approval needed: ${subject}`,
      html: `<table><tr><td><p>The agent asks to run <code>pnpm add zod</code> on <strong>${subject}</strong>.</p><p><a href="${url}">Open the task</a></p></td></tr></table>`,
      text: `The agent asks to run pnpm add zod on ${subject}.\n\nOpen the task: ${url}\n`,
    },
  };
};

export const defineNotificationContractSuite = (options: ContractSuiteOptions<NotificationAdapter, NotificationSuiteFixture>): void => {
  describe(`notification contract: ${options.name}`, () => {
    const subject = useSubject(options);
    defineCommonCases(subject, "notification", { channels: "array", edits: "boolean" });

    const make = async (recipients: readonly NotificationRecipient[]): Promise<MomentNotification> => {
      const notification = sampleNotification(recipients);
      return (await subject().fixture.prepare?.(notification)) ?? notification;
    };

    it("F-036: sends once per idempotency key: a second send answers the first's ID and delivers nothing new", async () => {
      const { adapter, fixture } = subject();
      const notification = await make([fixture.reachable]);
      const before = (await fixture.delivered()).length;
      const first = await adapter.send(notification);
      if (!first.ok) throw new Error(first.error.message);
      expect(first.value.refused).toEqual([]);
      const again = await adapter.send(notification);
      expect(again).toEqual(first);
      const delivered = await fixture.delivered();
      expect(delivered.length).toBe(before + 1);
      expect(delivered.at(-1)?.providerMessageId).toBe(first.value.providerMessageId);
    });

    it("F-036: a recipient the channel can't reach is reported, and the others still get it", async (context) => {
      const { adapter, fixture } = subject();
      const refusedOne = fixture.refused;
      if (refusedOne === undefined) {
        context.skip();
        return;
      }
      const sent = await adapter.send(await make([fixture.reachable, refusedOne, fixture.alsoReachable]));
      if (!sent.ok) throw new Error(sent.error.message);
      expect(sent.value.refused.map((refused) => refused.memberId)).toEqual([refusedOne.memberId]);
      expect(sent.value.refused[0]?.reason.length).toBeGreaterThan(0);
      const last = (await fixture.delivered()).at(-1);
      expect(last?.providerMessageId).toBe(sent.value.providerMessageId);
      expect(last?.to.length).toBe(2);
    });

    it("F-036: a rate limit answers rate-limited, with when to try again, and the next send goes out", async (context) => {
      const { adapter, fixture } = subject();
      if (fixture.rateLimitNext === undefined) {
        context.skip();
        return;
      }
      const notification = await make([fixture.reachable]);
      fixture.rateLimitNext();
      const limited = await adapter.send(notification);
      expect(limited).toMatchObject({ ok: false, error: { code: "rate-limited" } });
      expect(limited.ok ? undefined : limited.error.retryAfterMs).toBeGreaterThan(0);
      expect((await adapter.send(notification)).ok).toBe(true);
    });

    it("F-115: an email's HTML and text both carry the link and the subject", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.channels.includes("email")) {
        context.skip();
        return;
      }
      const notification = await make([fixture.reachable]);
      const sent = await adapter.send(notification);
      if (!sent.ok) throw new Error(sent.error.message);
      const mail = (await fixture.delivered()).find((delivered) => delivered.providerMessageId === sent.value.providerMessageId);
      expect(mail?.subject).toBe(notification.rendered?.subject);
      expect(mail?.html).toContain(notification.url);
      expect(mail?.html).toContain(notification.subject);
      expect(mail?.text).toContain(notification.url);
      expect(mail?.text).toContain(notification.subject);
    });

    it("F-036: an adapter that edits changes a sent notification in place; one that can't says so", async () => {
      const { adapter, fixture } = subject();
      const notification = await make([fixture.reachable]);
      const sent = await adapter.send(notification);
      if (!sent.ok) throw new Error(sent.error.message);
      const id = sent.value.providerMessageId;
      const changed: MomentNotification = { ...notification, body: `Answered: approved once. ${notification.url}` };
      if (!adapter.capabilities.edits || id === null) {
        expect(await adapter.update(changed, id ?? "none")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        return;
      }
      const before = (await fixture.delivered()).length;
      expect(await adapter.update(changed, id)).toEqual({ ok: true, value: undefined });
      const delivered = await fixture.delivered();
      expect(delivered.length).toBe(before);
      expect(delivered.find((candidate) => candidate.providerMessageId === id)?.text).toContain("Answered: approved once.");
    });

    // ---- milestone 4: budget notices and account mails (ticket 04) ----

    it("F-037: a budget notice is a moment, delivered as milestone 3's are", async () => {
      const { adapter, fixture } = subject();
      const notification: MomentNotification = { ...(await make([fixture.reachable])), kind: "budget_warning", category: "moment" };
      const sent = await adapter.send(notification);
      if (!sent.ok) throw new Error(sent.error.message);
      expect(sent.value.refused).toEqual([]);
      expect((await fixture.delivered()).at(-1)?.providerMessageId).toBe(sent.value.providerMessageId);
    });

    it("F-115: an account mail reaches one address that belongs to no member yet, its link in both the HTML and the text", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.channels.includes("email")) {
        context.skip();
        return;
      }
      const address = "newcomer@example.com";
      const mail = sampleAccountMail(address);
      const sent = await adapter.send(mail);
      if (!sent.ok) throw new Error(sent.error.message);
      expect(sent.value.refused).toEqual([]);
      const delivered = (await fixture.delivered()).find((candidate) => candidate.providerMessageId === sent.value.providerMessageId);
      expect(delivered?.to).toEqual([address]);
      expect(delivered?.subject).toBe(mail.rendered.subject);
      expect(delivered?.html).toContain(mail.url);
      expect(delivered?.text).toContain(mail.url);
    });

    it("F-115: an account mail's link and address are never in a log line, an error or what send returns", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.channels.includes("email")) {
        context.skip();
        return;
      }
      const address = "private-person@example.com";
      const returned: unknown[] = [];
      const mail = sampleAccountMail(address);
      returned.push(await adapter.send(mail), await adapter.send(mail));
      if (fixture.rateLimitNext !== undefined) {
        const limited = sampleAccountMail(address);
        fixture.rateLimitNext();
        const failed = await adapter.send(limited);
        expect(failed.ok).toBe(false);
        returned.push(failed, await adapter.send(limited));
      }
      const refusedAddress = fixture.refused?.email ?? "not-an-address";
      returned.push(await adapter.send(sampleAccountMail(refusedAddress)));
      const surface = leakSurface(returned, fixture.logs());
      expect(surface).not.toContain("ostra.example/accept");
      expect(surface).not.toContain(mail.url.split("=").at(-1));
      expect(surface).not.toContain("private-person");
      expect(surface).not.toContain(refusedAddress);
      expect(fixture.logs().length).toBeGreaterThan(0);
    });

    it("F-115: an account mail to an address the channel refuses is reported, not thrown", async (context) => {
      const { adapter, fixture } = subject();
      if (!adapter.capabilities.channels.includes("email")) {
        context.skip();
        return;
      }
      const before = (await fixture.delivered()).length;
      const sent = await adapter.send(sampleAccountMail(fixture.refused?.email ?? "not-an-address"));
      if (!sent.ok) throw new Error(sent.error.message);
      expect(sent.value.refused).toHaveLength(1);
      expect(sent.value.refused[0]?.memberId).toBeNull();
      expect(sent.value.refused[0]?.reason.length).toBeGreaterThan(0);
      expect((await fixture.delivered()).length).toBe(before);
    });

    it("F-115: a channel without email refuses an account mail as unsupported, and delivers nothing", async (context) => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.channels.includes("email")) {
        context.skip();
        return;
      }
      const before = (await fixture.delivered()).length;
      const mail = sampleAccountMail("newcomer@example.com");
      const sent = await adapter.send(mail);
      expect(sent).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(JSON.stringify(sent)).not.toContain(mail.url);
      expect((await fixture.delivered()).length).toBe(before);
    });

    // ---- milestone 5: the runner notices (ticket 03) ----

    for (const kind of runnerNotificationKinds) {
      it(`F-091: a ${kind} notice reaches the panel and email channels, a mail with the runner's facts in both parts; the tracker refuses it`, async () => {
        const { adapter, fixture } = subject();
        const notice = sampleRunnerNotice(kind, [fixture.reachable]);
        const notification = (await fixture.prepare?.(notice.notification)) ?? notice.notification;
        const before = (await fixture.delivered()).length;
        const sent = await adapter.send(notification);
        if (adapter.capabilities.channels.includes("tracker")) {
          expect(sent).toMatchObject({ ok: false, error: { code: "unsupported" } });
          expect((await fixture.delivered()).length).toBe(before);
          expect(await adapter.update(notification, "comment-1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
        } else {
          if (!sent.ok) throw new Error(sent.error.message);
          expect(sent.value.refused).toEqual([]);
          const delivered = (await fixture.delivered()).find((candidate) => candidate.providerMessageId === sent.value.providerMessageId);
          expect(delivered).toBeDefined();
          if (adapter.capabilities.channels.includes("email")) {
            for (const part of [delivered?.html ?? "", delivered?.text ?? ""]) {
              for (const fact of notice.facts) {
                expect(part, `the mail names ${fact}`).toContain(fact);
              }
            }
          }
        }
      });
    }

    // ---- milestone 6: the whole team's moments (ticket 04) ----

    for (const kind of teamNotificationKinds) {
      it(`F-036: the ${kind} moment reaches the channel with the task's title and key and one line, and none of it reaches a log line`, async () => {
        const { adapter, fixture } = subject();
        const notice = sampleTeamNotice(kind, [fixture.reachable]);
        const notification = (await fixture.prepare?.(notice.notification)) ?? notice.notification;
        const sent = await adapter.send(notification);
        if (!sent.ok) throw new Error(sent.error.message);
        expect(sent.value.refused).toEqual([]);
        const delivered = (await fixture.delivered()).find((candidate) => candidate.providerMessageId === sent.value.providerMessageId);
        expect(delivered).toBeDefined();
        if (adapter.capabilities.channels.includes("email")) {
          for (const part of [delivered?.html ?? "", delivered?.text ?? ""]) {
            expect(part).toContain(notice.taskKey);
            expect(part).toContain(notice.taskTitle);
            expect(part).toContain(notice.line);
          }
        }
        // The moment's words are the task's: data, never in a log line.
        const logged = JSON.stringify(fixture.logs());
        expect(logged).not.toContain(notice.taskTitle);
        expect(logged).not.toContain(notice.line);
      });
    }

    // ---- milestone 8: a preview shared with a named person (F-142) ----

    for (const kind of previewNotificationKinds) {
      it(`F-142/c3: a ${kind} notice reaches the panel and email channels, a mail with the preview's page in both parts and none of it in a log line; the tracker refuses it`, async () => {
        const { adapter, fixture } = subject();
        const notice = samplePreviewNotice(kind, [fixture.reachable]);
        const notification = (await fixture.prepare?.(notice.notification)) ?? notice.notification;
        const before = (await fixture.delivered()).length;
        const sent = await adapter.send(notification);
        if (adapter.capabilities.channels.includes("tracker")) {
          // The person may not see the task: a ticket would show it to everyone who can.
          expect(sent).toMatchObject({ ok: false, error: { code: "unsupported" } });
          expect((await fixture.delivered()).length).toBe(before);
          expect(await adapter.update(notification, "comment-1")).toMatchObject({ ok: false, error: { code: "unsupported" } });
          return;
        }
        if (!sent.ok) throw new Error(sent.error.message);
        expect(sent.value.refused).toEqual([]);
        const delivered = (await fixture.delivered()).find((candidate) => candidate.providerMessageId === sent.value.providerMessageId);
        expect(delivered).toBeDefined();
        if (adapter.capabilities.channels.includes("email")) {
          for (const part of [delivered?.html ?? "", delivered?.text ?? ""]) {
            for (const fact of notice.facts) {
              expect(part, `the mail names ${fact}`).toContain(fact);
            }
          }
        }
        expect(JSON.stringify(fixture.logs())).not.toContain(notice.label);
      });
    }
  });
};

let previewNotices = 0;

/**
 * Milestone 8 (F-142): a preview notice for a person named on it, as core builds it: the preview's
 * label and port, the organization, who shared it and the preview's own page. Nothing of the task.
 */
export const samplePreviewNotice = (
  kind: PreviewNotificationKind,
  recipients: readonly NotificationRecipient[],
): { readonly notification: MomentNotification; readonly label: string; readonly facts: readonly string[] } => {
  previewNotices += 1;
  const label = `checkout-web-${String(previewNotices)}`;
  const url = `https://ostra.example/previews/preview-suite-${String(previewNotices)}`;
  const heading = "A preview was shared with you";
  const line = `Ada Lovelace shared ${label} :5173 with you, to watch.`;
  return {
    notification: {
      organizationId,
      memberIds: recipients.map((recipient) => recipient.memberId),
      title: heading,
      body: `${line} ${url}`,
      url,
      idempotencyKey: `suite-preview:${kind}:${String(previewNotices)}:${String(Date.now())}`,
      kind,
      category: "moment",
      recipients,
      subject: label,
      preview: { label, port: 5173, sharedBy: "Ada Lovelace", organizationName: "Acme", url },
      rendered: {
        subject: `${heading} · ${label} :5173`,
        html: `<table><tr><td><p>${line}</p><p><a href="${url}">Watch the preview</a></p></td></tr></table>`,
        text: `${line}

Watch the preview: ${url}
`,
      },
    },
    label,
    facts: [label, ":5173", "Ada Lovelace", url],
  };
};

let teamNotices = 0;

/**
 * Milestone 6 (F-036, ADR 0050): a whole-team moment as core builds it: the task's title and key,
 * the moment and one line, and nothing of the task's content (no draft, finding, log or comment).
 */
export const sampleTeamNotice = (
  kind: TeamNotificationKind,
  recipients: readonly NotificationRecipient[],
): { readonly notification: MomentNotification; readonly taskTitle: string; readonly taskKey: string; readonly line: string } => {
  teamNotices += 1;
  const taskTitle = "Show the user's name in the banner";
  const taskKey = "OST-12";
  const url = `https://ostra.example/t/task-team-${String(teamNotices)}`;
  const moments: Readonly<Record<TeamNotificationKind, { readonly heading: string; readonly line: string }>> = {
    draft_ready: { heading: "A draft is ready", line: "The refine task handed in a draft for you to check." },
    review_requested: { heading: "A PR waits for your review", line: "You were asked to review the task's PR." },
    task_approval: { heading: "A task waits for approval", line: "Someone outside the project started it from Linear." },
    round_cap: { heading: "A task needs you", line: "It reached its limit of automatic rounds." },
    automation_paused: { heading: "An automation paused", line: "It reached its hourly limit of starts." },
  };
  const { heading, line } = moments[kind];
  return {
    notification: {
      organizationId,
      memberIds: recipients.map((recipient) => recipient.memberId),
      title: heading,
      body: `${line} ${url}`,
      url,
      idempotencyKey: `suite-team:${kind}:${String(teamNotices)}:${String(Date.now())}`,
      kind,
      category: "moment",
      recipients,
      subject: taskTitle,
      rendered: {
        subject: `${heading}: ${taskTitle} (${taskKey})`,
        html: `<table><tr><td><p><strong>${taskTitle}</strong> · ${taskKey}</p><p>${line}</p><p><a href="${url}">Open it</a></p></td></tr></table>`,
        text: `${taskTitle} · ${taskKey}

${line}

Open it: ${url}
`,
      },
    },
    taskTitle,
    taskKey,
    line,
  };
};

let runnerNotices = 0;

/**
 * Milestone 5 (F-091): a runner notice for the organization's admins, as core builds it from a joined
 * runner. `facts` are what its mail must name; the notice has no field for the join token or the
 * runner's key (the domain's renderer is tested for them).
 */
export const sampleRunnerNotice = (
  kind: RunnerNotificationKind,
  recipients: readonly NotificationRecipient[],
): { readonly notification: MomentNotification; readonly facts: readonly string[] } => {
  runnerNotices += 1;
  const joined = {
    runnerId: runnerIdSchema.parse(`runner-suite-${String(runnerNotices)}`),
    runnerName: "build-box-07",
    poolName: "linux-docker",
    executor: "docker",
    tokenLabel: "ci hosts, november",
  } as const;
  const url = `https://ostra.example/runners/${joined.runnerId}`;
  const heading = kind === "runner_joined" ? "A runner joined" : "A runner waits for approval";
  const line = `${joined.runnerName} joined the ${joined.poolName} pool (Docker, the token “${joined.tokenLabel}”).`;
  return {
    notification: {
      organizationId,
      memberIds: recipients.map((recipient) => recipient.memberId),
      title: heading,
      body: `${line} ${url}`,
      url,
      idempotencyKey: `suite-runner:${String(runnerNotices)}:${String(Date.now())}`,
      kind,
      category: "moment",
      recipients,
      subject: joined.runnerName,
      runner: {
        runnerId: joined.runnerId,
        runnerName: joined.runnerName,
        poolName: joined.poolName,
        executor: joined.executor,
        tokenLabel: joined.tokenLabel,
        url,
      },
      rendered: {
        subject: `${heading} · ${joined.runnerName} in ${joined.poolName}`,
        html: `<table><tr><td><p><strong>${joined.runnerName}</strong> joined the ${joined.poolName} pool.</p><p>Docker · ${joined.tokenLabel}</p><p><a href="${url}">Open the runner</a></p></td></tr></table>`,
        text: `${line}

Open the runner: ${url}
`,
      },
    },
    facts: [joined.runnerName, joined.poolName, "Docker", joined.tokenLabel, url],
  };
};

let accountMails = 0;

/**
 * Milestone 4 (ADR 0053): an invitation to an address that belongs to no member yet, with a bearer
 * link of its own in both parts. The link's code is random, so a search for it finds only this mail.
 */
export const sampleAccountMail = (email: string): AccountNotification => {
  accountMails += 1;
  // Short enough that the logger's token redaction wouldn't hide it: the case checks the adapter, not the logger.
  const token = `code${String(accountMails)}x${randomUUID().slice(0, 8)}`;
  const url = `https://ostra.example/accept?code=${token}`;
  const organization = "Acme";
  return {
    category: "account",
    kind: "invitation",
    organizationId,
    title: "You're invited",
    body: `Ada invited you to ${organization} on ostra. Accept: ${url}`,
    url,
    idempotencyKey: `suite-account:${String(accountMails)}:${String(Date.now())}`,
    subject: organization,
    to: { email, memberId: null },
    rendered: {
      subject: `Join ${organization} on ostra`,
      html: `<table><tr><td><p>Ada invited you to <strong>${organization}</strong>.</p><p><a href="${url}">Accept the invitation</a></p><p>It expires in 7 days.</p></td></tr></table>`,
      text: `Ada invited you to ${organization}.

Accept the invitation: ${url}

It expires in 7 days.
`,
    },
  };
};

/** Everything a send returned but the provider's message ID, and every log line, as text to search. */
const leakSurface = (returned: unknown, logs: readonly LogRecord[]): string =>
  JSON.stringify({ returned, logs }, (key: string, value: unknown) => (key === "providerMessageId" ? null : value));

/** A recipient for a fixture: a member, with an address and a mention or without. */
export const suiteRecipient = (name: string, reach: { readonly email: boolean; readonly mention: boolean }): NotificationRecipient => ({
  memberId: memberIdSchema.parse(`member-${name}`),
  email: reach.email ? `${name}@example.com` : null,
  trackerMention: reach.mention ? `@${name}` : null,
});
