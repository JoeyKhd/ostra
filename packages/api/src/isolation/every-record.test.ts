import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { Db } from "@ostra/db";
import { buildIsolationRows, isolationModelNames, isolationProjectModels } from "@ostra/db/testing";
import type { IsolationModelName, SeededMember } from "@ostra/db/testing";
import { postgresChangeNotices, searchTasks } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { appRouter } from "../routers/app-router.ts";
import { openStream } from "../stream/subscribe.ts";
import { createApiHarness, seedConnectionAndModel, seedPreviewableTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// Milestone 4, ticket 09 (F-049, F-087, F-003; ADR 0053, ADR 0026): isolation for every kind of
// record. Every model with `organizationId` (the list in `@ostra/db/testing`'s isolation-models.ts)
// is built in organization A (an open and a restricted project) and in organization B, which the
// fixtures make. Then every query procedure of the panel's API is called by every role of A, and
// no output holds an ID of B's, nor, for a role that can't open the restricted project, an ID of
// that project's records. A guard fails when the router gains a query procedure this file has no
// row for. The live stream and search are in it too. And the matrix: each procedure, called by
// each role on the restricted project, gives the result the table says.

let harness: ApiHarness;

/** Each project's rows, by model. */
let open: ReadonlyMap<IsolationModelName, string>;
let restricted: ReadonlyMap<IsolationModelName, string>;
let other: ReadonlyMap<IsolationModelName, string>;
/** Every ID of a row of B's, and of a row inside A's restricted project. */
let idsOfB: readonly string[];
let idsOfRestricted: readonly string[];
let projectAdmin: SeededMember;

const tablesWith = async (db: Db, column: "organizationId" | "projectId"): Promise<readonly string[]> =>
  z
    .array(z.object({ table: z.string() }))
    .parse(
      await db.$queryRaw`
        SELECT c.table_name AS "table" FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = ${column}
          AND EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = c.table_name AND i.column_name = 'id')`,
    )
    .map((row) => row.table);

/** Every `id` of every table's rows whose column holds the value. */
const idsWhere = async (db: Db, column: "organizationId" | "projectId", value: string): Promise<readonly string[]> => {
  const ids: string[] = [];
  for (const table of await tablesWith(db, column)) {
    const rows = z.array(z.object({ id: z.string() })).parse(await db.$queryRawUnsafe(`SELECT id::text AS id FROM "${table}" WHERE "${column}" = $1`, value));
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
};

beforeAll(async () => {
  harness = await createApiHarness();
  // A working GitHub App and model provider first, as an install has them, so the admin's GitHub
  // and model reads run for real; the rows below are beside them.
  await seedConnectionAndModel(harness);
  const { a, b } = harness.fixture;
  const rowsA = await buildIsolationRows(harness.test.db, { organizationId: a.organization.id, memberId: a.admin.id, userId: a.admin.userId }, [a.openProject.id, a.restrictedProject.id]);
  const rowsB = await buildIsolationRows(harness.test.db, { organizationId: b.organization.id, memberId: b.admin.id, userId: b.admin.userId }, [b.project.id]);
  const need = <T,>(value: T | undefined): T => {
    if (value === undefined) {
      throw new Error("a project's rows weren't built");
    }
    return value;
  };
  open = need(rowsA.get(a.openProject.id));
  restricted = need(rowsA.get(a.restrictedProject.id));
  other = need(rowsB.get(b.project.id));
  idsOfB = [b.organization.id, ...(await idsWhere(harness.test.db, "organizationId", b.organization.id))];
  idsOfRestricted = [a.restrictedProject.id, ...(await idsWhere(harness.test.db, "projectId", a.restrictedProject.id))];
  // A project admin of the restricted project, who is an ordinary member of the organization.
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: "Project admin", email: `padmin-${randomUUID()}@example.com`, username: `padmin-${randomUUID().slice(0, 8)}` } });
  const row = await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: a.organization.id, userId: user.id, role: "member", createdAt: new Date() } });
  await harness.test.db.projectMember.create({ data: { organizationId: a.organization.id, projectId: a.restrictedProject.id, memberId: row.id, role: "admin" } });
  projectAdmin = mapMember(row);
  await harness.hub.start();
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

// ---------- the procedures ----------

type Rows = ReadonlyMap<IsolationModelName, string>;
/** What a procedure is called with: the rows of the project it's about, and that project's ID. */
type Target = { readonly rows: Rows; readonly projectId: string };
type InputOf = (target: Target) => unknown;

const row = (target: Target, model: IsolationModelName): string => {
  const value = target.rows.get(model);
  if (value === undefined) {
    throw new Error(`no ${model} row`);
  }
  return value;
};

const none: InputOf = () => undefined;
/** The month `SpendDaily`'s fixture rows fall in (`isolation-models.ts` writes them on 2026-11-01). */
const currentMonth = (): string => "2026-11";
const project: InputOf = (target) => ({ projectId: target.projectId });
const task: InputOf = (target) => ({ taskId: row(target, "Task") });

/**
 * Every query procedure, with its input. `about` says whether its input names a record inside a
 * project (`project`), so the matrix calls it on the restricted project, or nothing of a project
 * (`organization`).
 */
const procedures: Readonly<Record<string, { readonly input: InputOf; readonly about: "project" | "organization" }>> = {
  "account.cliSessions.list": { input: none, about: "organization" },
  "account.deviceRequest": { input: () => ({ userCode: "ABCD-EFGH" }), about: "organization" },
  "account.github.get": { input: none, about: "organization" },
  "accounts.resetPreview": { input: () => ({ token: "no-such-token" }), about: "organization" },
  "agentProfiles.agents": { input: none, about: "organization" },
  "agentProfiles.effortLevels": { input: (target) => ({ adapter: "opencode", modelId: row(target, "Model") }), about: "organization" },
  "agentProfiles.forStart": { input: (target) => ({ projectId: target.projectId, kind: "code" }), about: "project" },
  "agentProfiles.get": { input: (target) => ({ profileId: row(target, "AgentProfile") }), about: "organization" },
  "agentProfiles.list": { input: none, about: "organization" },
  "agentProfiles.modelOptions": { input: none, about: "organization" },
  "agentProfiles.providerOptions": { input: none, about: "organization" },
  "agentProfiles.presets": { input: none, about: "organization" },
  "agentProfiles.ruleCoverage": { input: () => ({ rules: [], mcpServers: [] }), about: "organization" },
  "approvals.preview": { input: (target) => ({ approvalId: row(target, "Approval") }), about: "project" },
  "audit.actions": { input: none, about: "organization" },
  "audit.list": { input: project, about: "project" },
  "automations.dryRun": { input: (target) => ({ projectId: target.projectId, filter: { labels: { mode: "any", names: ["bug"] } } }), about: "project" },
  "automations.get": { input: (target) => ({ automationId: row(target, "Automation") }), about: "project" },
  "automations.history": { input: (target) => ({ automationId: row(target, "Automation") }), about: "project" },
  "automations.list": { input: project, about: "project" },
  "automations.previewSchedule": { input: () => ({ cron: "0 9 * * 1", timeZone: "Europe/Amsterdam" }), about: "organization" },
  "automations.pausedByLimit": { input: none, about: "organization" },
  "boxSizes.list": { input: none, about: "organization" },
  "fleetUse.boxSizes": { input: none, about: "organization" },
  "fleetUse.project": { input: project, about: "project" },
  "boards.available": { input: project, about: "project" },
  "boards.get": { input: project, about: "project" },
  "diff.comments.list": { input: task, about: "project" },
  // Milestone 6 (ticket 27): the fixture's task is a code task, which has no draft: `NOT_FOUND`. The drafts
  // tests call it on refine tasks of another organization and of a restricted project.
  "drafts.get": { input: (target) => ({ taskId: row(target, "Task"), version: null }), about: "project" },
  "diff.get": { input: task, about: "project" },
  "email.on": { input: none, about: "organization" },
  "email.settings.get": { input: none, about: "organization" },
  "email.status": { input: none, about: "organization" },
  // Milestone 8 (ticket 16): the environment's App tab and a task's screenshots.
  "environments.appProcesses.detected": { input: project, about: "project" },
  "environments.appProcesses.list": { input: project, about: "project" },
  "environments.checks.list": { input: project, about: "project" },
  "environments.get": { input: project, about: "project" },
  "environments.screenshots.get": { input: project, about: "project" },
  "environments.services.list": { input: project, about: "project" },
  "environments.snapshot.get": { input: project, about: "project" },
  "github.appRequest": { input: none, about: "organization" },
  "github.connection": { input: none, about: "organization" },
  "github.connections": { input: none, about: "organization" },
  "github.detect": { input: () => ({ installationId: "9001", fullName: "ostra-test/test1", ref: "main" }), about: "organization" },
  "github.installations": { input: none, about: "organization" },
  "github.repos": { input: () => ({ installationId: "9001" }), about: "organization" },
  "github.reposByAccount": { input: none, about: "organization" },
  "home.board": { input: project, about: "project" },
  "home.needsYou": { input: () => ({}), about: "organization" },
  "home.overview": { input: none, about: "organization" },
  "inbox.bulkStart": { input: (target) => ({ projectId: target.projectId, bulkStartId: row(target, "BulkStart") }), about: "project" },
  "inbox.filters": { input: project, about: "project" },
  "inbox.get": { input: (target) => ({ projectId: target.projectId, ticketId: row(target, "Ticket") }), about: "project" },
  "inbox.list": { input: project, about: "project" },
  "tickets.parent": { input: (target) => ({ ticketId: row(target, "Ticket") }), about: "project" },
  "insights.get": { input: (target) => ({ projectId: target.projectId, period: { kind: "preset", days: 30 } }), about: "project" },
  "instance.accounts.search": { input: () => ({ query: "" }), about: "organization" },
  "instance.admins": { input: none, about: "organization" },
  // Ticket 26 (F-144): Instance › Previews, the instance admin's alone.
  "instance.previews": { input: none, about: "organization" },
  "invitations.preview": { input: (target) => ({ invitationId: row(target, "Invitation") }), about: "organization" },
  // Milestone 8 (F-145, F-146, ticket 30): the library, any member's to read; its sources, suggestions, counts, files and switch an admin's.
  "library.list": { input: none, about: "organization" },
  "library.get": { input: (target) => ({ itemId: row(target, "LibraryItem") }), about: "organization" },
  "library.counts": { input: none, about: "organization" },
  "library.file": { input: (target) => ({ versionId: row(target, "LibraryItemVersion"), path: "SKILL.md" }), about: "organization" },
  "library.sources.list": { input: none, about: "organization" },
  "library.suggestions.list": { input: none, about: "organization" },
  // Ticket 31: a member's own suggestions.
  "library.suggestions.mine": { input: none, about: "organization" },
  "library.searchState": { input: none, about: "organization" },
  "linear.status": { input: none, about: "organization" },
  "me.get": { input: none, about: "organization" },
  "members.invitations": { input: none, about: "organization" },
  "members.list": { input: () => ({ includeRemoved: true }), about: "organization" },
  "memory.note": { input: (target) => ({ noteId: row(target, "MemoryNote") }), about: "project" },
  "memory.notes": { input: (target) => ({ scope: "project", projectId: target.projectId }), about: "project" },
  "memory.index": { input: (target) => ({ scope: "project", projectId: target.projectId }), about: "project" },
  "memory.proposal": { input: (target) => ({ proposalId: row(target, "MemoryProposal") }), about: "project" },
  "memory.proposals": { input: (target) => ({ scope: "project", projectId: target.projectId }), about: "project" },
  "notifications.list": { input: () => ({ tab: "open" }), about: "organization" },
  "notifications.budgetNotices": { input: none, about: "organization" },
  // F-142: the previews shared with the member by name, for the Needs you page.
  "notifications.previewShares": { input: none, about: "organization" },
  "notifications.openCount": { input: none, about: "organization" },
  "notifications.preferences.get": { input: none, about: "organization" },
  "organization.get": { input: none, about: "organization" },
  "organization.members": { input: none, about: "organization" },
  "organization.previews": { input: none, about: "organization" },
  "organization.storage": { input: none, about: "organization" },
  "joinTokens.list": { input: (target) => ({ poolId: row(target, "RunnerPool") }), about: "organization" },
  "pools.get": { input: (target) => ({ poolId: row(target, "RunnerPool") }), about: "organization" },
  "pools.joinTokens": { input: (target) => ({ poolId: row(target, "RunnerPool") }), about: "organization" },
  "pools.list": { input: none, about: "organization" },
  "pools.names": { input: none, about: "organization" },
  "pools.queue": { input: (target) => ({ poolId: row(target, "RunnerPool") }), about: "organization" },
  "projects.access": { input: project, about: "project" },
  "projects.get": { input: project, about: "project" },
  "projects.reviewSettings": { input: project, about: "project" },
  "environments.proposal": { input: project, about: "project" },
  "environments.onboarding": { input: project, about: "project" },
  "projects.getTicketTemplate": { input: project, about: "project" },
  "projects.runners": { input: project, about: "project" },
  "projects.list": { input: none, about: "organization" },
  // Milestone 8 (ticket 20): the pane's list of a task's previews, with their sharing.
  "previews.list": { input: task, about: "project" },
  "projects.previewProviders": { input: (target) => ({ projectId: target.projectId, mode: { kind: "default" } }), about: "project" },
  "projects.providers": { input: project, about: "project" },
  "projects.repos": { input: project, about: "project" },
  "providers.choicesToConfirm": { input: none, about: "organization" },
  "providers.list": { input: none, about: "organization" },
  "providers.previewDefaultList": { input: (target) => ({ providerIds: [row(target, "ModelProvider")] }), about: "organization" },
  "providers.models": { input: (target) => ({ providerId: row(target, "ModelProvider") }), about: "organization" },
  "registry.get": { input: none, about: "organization" },
  "registryUse.get": { input: none, about: "organization" },
  "runners.get": { input: (target) => ({ runnerId: row(target, "Runner") }), about: "organization" },
  "runners.list": { input: none, about: "organization" },
  "runners.mine": { input: none, about: "organization" },
  "search.suggest": { input: () => ({ query: "" }), about: "organization" },
  "search.tasks": { input: () => ({ query: "" }), about: "organization" },
  "setup.status": { input: none, about: "organization" },
  // The instance admin's (ticket 24): the install's first organization, whoever asks.
  "setup.timeline": { input: () => ({ start: 0 }), about: "organization" },
  "spend.currentMonth": { input: none, about: "organization" },
  "spend.modelPrice": { input: (target) => ({ modelId: row(target, "Model"), month: currentMonth() }), about: "organization" },
  "spend.month": { input: () => ({ month: currentMonth() }), about: "organization" },
  "spend.project": { input: (target) => ({ projectId: target.projectId, month: currentMonth() }), about: "project" },
  "tasks.attachments": { input: task, about: "project" },
  "tasks.checks": { input: task, about: "project" },
  "tasks.eventLog": { input: task, about: "project" },
  "tasks.get": { input: task, about: "project" },
  "tasks.history": { input: task, about: "project" },
  "tasks.list": { input: project, about: "project" },
  "tasks.needsApproval": { input: project, about: "project" },
  "tasks.local": { input: task, about: "project" },
  "tasks.memory": { input: task, about: "project" },
  "tasks.rounds": { input: task, about: "project" },
  "review.screen": { input: task, about: "project" },
  "tasks.startCheck": { input: project, about: "project" },
  "tasks.runnerChoices": { input: project, about: "project" },
};

/** Which procedures read each model's rows: what the suite calls for it. */
const readers: Readonly<Record<IsolationModelName, readonly string[]>> = {
  Member: ["organization.members", "me.get", "members.list"],
  Invitation: ["organization.members", "members.invitations", "invitations.preview"],
  OrganizationSetting: ["setup.status", "organization.get", "organization.previews"],
  AuditEntry: ["environments.snapshot.get", "email.settings.get", "audit.list", "registryUse.get"],
  ChangeNotice: ["stream.subscribe"],
  Connection: ["github.connection", "linear.status", "setup.status"],
  CodeHostInstallation: ["github.installations", "github.repos", "github.connections", "github.reposByAccount"],
  ModelProvider: ["providers.list", "providers.models", "agentProfiles.providerOptions"],
  Model: ["providers.models", "agentProfiles.get", "agentProfiles.effortLevels", "spend.modelPrice"],
  RunnerPool: ["pools.list", "pools.joinTokens", "pools.get", "pools.names", "pools.queue"],
  JoinToken: ["pools.joinTokens", "pools.list", "joinTokens.list", "pools.get"],
  Runner: ["runners.list", "runners.mine", "runners.get", "tasks.runnerChoices", "fleetUse.boxSizes"],
  RunnerPresence: ["runners.list", "runners.mine"],
  AgentProfile: ["agentProfiles.list", "agentProfiles.get", "agentProfiles.forStart"],
  AgentProfileMember: ["agentProfiles.get"],
  AgentProfileSkill: ["agentProfiles.get"],
  Secret: [],
  Project: ["projects.list", "projects.get", "home.overview"],
  ProjectMember: ["projects.get", "projects.access", "members.list"],
  ProjectPool: ["projects.get", "pools.list", "projects.runners", "tasks.runnerChoices", "fleetUse.project"],
  Repo: ["projects.get", "tasks.get", "projects.repos"],
  Board: ["boards.get", "inbox.filters"],
  Ticket: ["inbox.list", "inbox.get", "tickets.parent"],
  TicketWrite: ["tasks.get"],
  Environment: ["environments.get"],
  EnvironmentEntry: ["environments.get"],
  Service: ["environments.services.list"],
  Check: ["environments.checks.list", "tasks.checks"],
  Snapshot: ["environments.snapshot.get", "registry.get", "registryUse.get"],
  Automation: ["automations.list", "automations.get"],
  Task: ["tasks.list", "tasks.get", "home.board", "home.overview"],
  TaskRepo: ["tasks.get", "diff.get"],
  TaskCoAuthor: ["tasks.get"],
  Box: ["tasks.get", "tasks.local", "runners.get", "fleetUse.boxSizes", "fleetUse.project"],
  SidecarCommand: [],
  Lease: ["tasks.get", "runners.list"],
  Session: ["tasks.get", "tasks.history"],
  Turn: ["tasks.history"],
  Event: ["tasks.history", "stream.subscribe", "tasks.eventLog"],
  Command: [],
  Approval: ["approvals.preview", "tasks.get"],
  NeedsYouItem: ["home.needsYou", "tasks.get", "notifications.list", "notifications.openCount"],
  WebhookDelivery: [],
  IdempotencyRecord: [],
  RateBudget: [],
  Blob: ["organization.storage"],
  BlobUpload: [],
  BlobChunk: [],
  OAuthState: [],
  TaskApprovalRule: ["tasks.get"],
  DiffComment: ["diff.comments.list"],
  DiffCache: ["diff.get"],
  TaskPullRequest: ["tasks.get", "home.board"],
  CheckRun: ["tasks.checks"],
  Notification: ["notifications.list", "notifications.budgetNotices", "notifications.previewShares"],
  NotificationDelivery: ["notifications.list", "notifications.budgetNotices", "notifications.previewShares"],
  NotificationPreference: ["notifications.preferences.get"],
  AccountMailDelivery: ["organization.members"],
  CliSession: ["account.cliSessions.list"],
  DeviceCode: ["account.deviceRequest"],
  SearchEntry: ["search", "search.tasks", "search.suggest"],
  SpendDaily: ["insights.get", "tasks.get", "spend.month", "spend.project"],
  Budget: ["insights.get", "spend.month", "spend.project", "tasks.startCheck"],
  BudgetNotice: ["spend.month", "notifications.budgetNotices"],
  HeldTurn: ["tasks.get", "spend.month"],
  TaskMetric: ["insights.get"],
  InsightDaily: ["insights.get"],
  InsightRun: ["insights.get"],
  MemoryNote: ["memory.notes", "memory.note"],
  MemoryNoteVersion: ["memory.note"],
  MemoryProposal: ["memory.proposals", "memory.proposal", "tasks.memory"],
  MemoryUse: ["tasks.get", "tasks.memory"],
  ReviewCheck: ["tasks.get"],
  ProviderListEntry: ["providers.list", "projects.get", "projects.providers", "providers.previewDefaultList"],
  ModelChoice: ["providers.list", "projects.get", "projects.providers", "projects.previewProviders", "providers.choicesToConfirm"],
  // Milestone 5 (its ticket 04): no procedure reads them yet; tickets 27 and 28 add theirs.
  BoxSize: ["boxSizes.list"],
  Registry: ["registry.get"],
  // Milestone 6 (its ticket 05): no procedure reads them yet; tickets 24 to 29 add theirs.
  AutomationRun: ["automations.history"],
  BulkStart: ["inbox.bulkStart"],
  BulkStartItem: [],
  AgentSession: ["linear.status"],
  AgentActivity: [],
  RefineDraft: ["drafts.get"],
  RefineDraftImage: ["drafts.get"],
  CiRun: ["review.screen", "tasks.rounds"],
  TaskRound: ["tasks.rounds"],
  ReviewRun: ["review.screen"],
  Finding: ["review.screen", "tasks.rounds"],
  TaskReviewer: ["review.screen"],
  EnvironmentProposal: ["environments.proposal", "environments.appProcesses.list"],
  // Milestone 8 (its ticket 04). Ticket 20's pane list reads the previews (the app processes, the
  // announced ports, the latest screenshot) and their sharing: levels, named people, links and the
  // open views. Ticket 16's App tab reads the processes, and the thread a task's screenshots and
  // recordings. Ticket 30 adds its own; a code is ticket 23's and 25's (no read lists one).
  AppProcess: ["previews.list", "environments.appProcesses.list", "environments.appProcesses.detected", "environments.screenshots.get"],
  TaskAttachment: ["previews.list", "tasks.attachments", "environments.proposal"],
  TaskPreview: ["previews.list"],
  PreviewAccess: ["previews.list", "notifications.previewShares"],
  PreviewAccessMember: ["previews.list", "notifications.previewShares"],
  PreviewLink: ["previews.list"],
  PreviewView: ["previews.list"],
  PreviewCode: [],
  // Ticket 30: the library's readers.
  LibraryItem: ["library.list", "library.get", "agentProfiles.get"],
  LibraryItemVersion: ["library.list", "library.get", "library.file", "agentProfiles.get"],
  AgentProfileLibraryItem: ["library.list", "library.get", "agentProfiles.get"],
  LibrarySource: ["library.sources.list", "library.list", "library.searchState"],
  LibrarySuggestion: ["library.suggestions.list", "library.suggestions.mine", "library.counts"],
};

/** Calls a procedure by its dotted path, as the panel does. */
const call = async (caller: AppCaller, path: string, input: unknown): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly code: string }> => {
  let target: unknown = caller;
  for (const part of path.split(".")) {
    target = Reflect.get(Object(target), part);
  }
  if (typeof target !== "function") {
    throw new Error(`no procedure ${path}`);
  }
  try {
    const output: unknown = await Reflect.apply(target, undefined, input === undefined ? [] : [input]);
    return { ok: true, output };
  } catch (error) {
    if (error instanceof TRPCError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
};

const leaked = (output: unknown, ids: readonly string[]): readonly string[] => {
  const text = output === undefined ? "" : JSON.stringify(output);
  return ids.filter((id) => text.includes(id));
};

/** The panel's query procedures, read from the router itself. */
const queryPaths = (): readonly string[] =>
  Object.entries(appRouter._def.procedures)
    .filter(([, procedure]) => Reflect.get(Object(Reflect.get(Object(procedure), "_def")), "type") === "query")
    .map(([path]) => path)
    .sort();

describe("the guards (F-049)", () => {
  it("F-049/c5: every query procedure of the router has a row in this suite, and no row names a procedure that's gone", () => {
    const paths = queryPaths();
    expect(paths.filter((path) => !Object.hasOwn(procedures, path)), "a new query procedure: add its row (and its readers)").toEqual([]);
    expect(Object.keys(procedures).filter((path) => !paths.includes(path))).toEqual([]);
  });

  it("F-049: the readers table names every listed model, and only procedures the suite calls", () => {
    expect(Object.keys(readers).sort()).toEqual([...isolationModelNames()].sort());
    const known = new Set([...Object.keys(procedures), "stream.subscribe", "search"]);
    for (const paths of Object.values(readers)) {
      for (const path of paths) {
        expect(known.has(path), path).toBe(true);
      }
    }
  });
});

// ---------- the roles ----------

type Role = "organization admin" | "organization member" | "project admin" | "project member" | "not listed";
const roles: readonly Role[] = ["organization admin", "organization member", "project admin", "project member", "not listed"];

const memberOf = (role: Role): SeededMember => {
  const { a } = harness.fixture;
  switch (role) {
    case "organization admin":
      return a.admin;
    case "organization member":
    case "not listed":
      return a.member;
    case "project admin":
      return projectAdmin;
    case "project member":
      return a.insider;
    default:
      return role satisfies never;
  }
};

/** The organization member works in the open project; every other role is called on the restricted one. */
const targetOf = (role: Role): Target =>
  role === "organization member" ? { rows: open, projectId: harness.fixture.a.openProject.id } : { rows: restricted, projectId: harness.fixture.a.restrictedProject.id };

/** Whether the role may see the restricted project's records. */
const seesRestricted = (role: Role): boolean => role === "organization admin" || role === "project admin" || role === "project member";

describe("no query crosses organizations, or opens a restricted project (F-049, F-087)", () => {
  it.each(roles)("F-049/c4,c5, F-087/c4: every query procedure, called by the %s, returns no row of another organization, nor of a project they can't open", async (role) => {
    const caller = await harness.as(memberOf(role));
    const target = targetOf(role);
    const crossed: string[] = [];
    const hidden: string[] = [];
    for (const [path, procedure] of Object.entries(procedures)) {
      const result = await call(caller, path, procedure.input(target));
      if (!result.ok) {
        continue;
      }
      crossed.push(...leaked(result.output, idsOfB).map((id) => `${path}: ${id}`));
      if (!seesRestricted(role)) {
        hidden.push(...leaked(result.output, idsOfRestricted).map((id) => `${path}: ${id}`));
      }
    }
    expect(crossed).toEqual([]);
    expect(hidden).toEqual([]);
  });

  it("F-049/c4,c5: every query procedure, called by an admin of A with B's IDs, finds nothing of B's", async () => {
    const caller = await harness.as(harness.fixture.a.admin);
    const target: Target = { rows: other, projectId: harness.fixture.b.project.id };
    const crossed: string[] = [];
    for (const [path, procedure] of Object.entries(procedures)) {
      const result = await call(caller, path, procedure.input(target));
      if (result.ok) {
        crossed.push(...leaked(result.output, idsOfB).map((id) => `${path}: ${id}`));
      } else if (procedure.about === "project") {
        // A project or task of B's is no project of A's: not found, never forbidden.
        expect(result.code, path).toBe("NOT_FOUND");
      }
    }
    expect(crossed).toEqual([]);
  });

  it("F-049/c4,c5, F-087/c4: the live stream sends a member no change notice of another organization's, nor of a project they can't open", async () => {
    const { a, b } = harness.fixture;
    const context = await harness.contextOf(a.member);
    const scope = context.member?.scope;
    if (scope === undefined) {
      throw new Error("no scope");
    }
    const controller = new AbortController();
    const seen: unknown[] = [];
    const reading = (async () => {
      try {
        for await (const value of openStream({ ...context, scope }, {}, controller.signal)) {
          seen.push(value);
        }
      } catch {
        // Stopped.
      }
    })();
    const notice = async (organizationId: string, projectId: string): Promise<string> => {
      const entityId = taskIdSchema.parse(randomUUID());
      await harness.test.db.$transaction((tx) =>
        postgresChangeNotices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId: projectIdSchema.parse(projectId), entity: "task", entityId }),
      );
      return entityId;
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ofB = await notice(b.organization.id, b.project.id);
    const ofRestricted = await notice(a.organization.id, a.restrictedProject.id);
    const ofOpen = await notice(a.organization.id, a.openProject.id);
    const deadline = Date.now() + 8_000;
    while (!JSON.stringify(seen).includes(ofOpen) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    await reading;
    const text = JSON.stringify(seen);
    expect(text).toContain(ofOpen);
    expect(text).not.toContain(ofB);
    expect(text).not.toContain(ofRestricted);
  });

  it("F-049/c4,c5, F-087/c4: search returns a member no task of another organization's, nor of a project they can't open", async () => {
    const { a } = harness.fixture;
    const scopeOf = (memberId: string, role: "admin" | "member", projectRoles: MemberScope["projectRoles"]): MemberScope => ({
      organizationId: organizationIdSchema.parse(a.organization.id),
      memberId: memberIdSchema.parse(memberId),
      role,
      projectRoles,
    });
    const query = { text: "fixture", ticketKey: null, repoId: null, memberId: null, state: null, limit: 100 };
    const asMember = (await searchTasks(harness.test.db, scopeOf(a.member.id, "member", new Map()), query)).map((result) => result.taskId);
    expect(asMember).toContain(row({ rows: open, projectId: a.openProject.id }, "Task"));
    expect(leaked(asMember, idsOfB)).toEqual([]);
    expect(leaked(asMember, idsOfRestricted)).toEqual([]);
    const asInsider = (await searchTasks(harness.test.db, scopeOf(a.insider.id, "member", new Map([[projectIdSchema.parse(a.restrictedProject.id), "member" as const]])), query)).map((result) => result.taskId);
    expect(asInsider).toContain(row({ rows: restricted, projectId: a.restrictedProject.id }, "Task"));
    expect(leaked(asInsider, idsOfB)).toEqual([]);
  });

  it("F-087/c4: the fixture holds every kind of project record in the restricted project, so the calls above cover each", () => {
    for (const model of isolationProjectModels) {
      expect(restricted.get(model), model).toEqual(expect.any(String));
    }
    // Every project record with an `id` column is among them (a few are keyed by their parents).
    expect(idsOfRestricted.length).toBeGreaterThan(40);
    expect(idsOfB.length).toBeGreaterThan(60);
  });
});

// ---------- the matrix ----------

type Outcome = "ok" | "FORBIDDEN" | "NOT_FOUND" | "PRECONDITION_FAILED";
const outcomeSchema = z.enum(["ok", "FORBIDDEN", "NOT_FOUND", "PRECONDITION_FAILED"]);

/**
 * Each query procedure, called by each role: the organization admin, an organization member (on the
 * open project), the restricted project's admin and member, and an organization member not listed
 * on it. A refusal of a project the member can't open is NOT_FOUND, never FORBIDDEN. The fixture's
 * organization admin is no instance admin, so the instance's own settings refuse every role here.
 * Linear isn't connected, so its teams are a precondition that fails for the two who may ask.
 */
const matrix: Readonly<Record<string, readonly [Outcome, Outcome, Outcome, Outcome, Outcome]>> = {
  "account.cliSessions.list": ["ok", "ok", "ok", "ok", "ok"],
  "account.deviceRequest": ["ok", "ok", "ok", "ok", "ok"],
  "account.github.get": ["ok", "ok", "ok", "ok", "ok"],
  "accounts.resetPreview": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.agents": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.effortLevels": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.forStart": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "agentProfiles.get": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.list": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.modelOptions": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "agentProfiles.providerOptions": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "agentProfiles.presets": ["ok", "ok", "ok", "ok", "ok"],
  "agentProfiles.ruleCoverage": ["ok", "ok", "ok", "ok", "ok"],
  "approvals.preview": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "audit.actions": ["ok", "ok", "ok", "ok", "ok"],
  "audit.list": ["ok", "FORBIDDEN", "ok", "FORBIDDEN", "NOT_FOUND"],
  "automations.dryRun": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "automations.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "automations.history": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "automations.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "automations.previewSchedule": ["ok", "ok", "ok", "ok", "ok"],
  "automations.pausedByLimit": ["ok", "ok", "ok", "ok", "ok"],
  "boxSizes.list": ["ok", "ok", "ok", "ok", "ok"],
  "fleetUse.boxSizes": ["ok", "ok", "ok", "ok", "ok"],
  "fleetUse.project": ["ok", "FORBIDDEN", "ok", "FORBIDDEN", "NOT_FOUND"],
  "boards.available": ["PRECONDITION_FAILED", "FORBIDDEN", "PRECONDITION_FAILED", "FORBIDDEN", "NOT_FOUND"],
  "boards.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "diff.comments.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "diff.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  // The fixture's task is a code task: it has no draft for anyone (ticket 27's tests hold the roles on a refine task).
  "drafts.get": ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"],
  "email.on": ["ok", "ok", "ok", "ok", "ok"],
  "email.settings.get": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "email.status": ["ok", "ok", "ok", "ok", "ok"],
  "environments.appProcesses.detected": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.appProcesses.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.checks.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.screenshots.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.services.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.snapshot.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "github.appRequest": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.connection": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.connections": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.detect": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.installations": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.repos": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "github.reposByAccount": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "home.board": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "home.needsYou": ["ok", "ok", "ok", "ok", "ok"],
  "home.overview": ["ok", "ok", "ok", "ok", "ok"],
  "inbox.bulkStart": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "inbox.filters": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "inbox.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "inbox.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tickets.parent": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "insights.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "instance.accounts.search": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "instance.admins": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "instance.previews": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "invitations.preview": ["ok", "ok", "ok", "ok", "ok"],
  // Milestone 8 (F-145, ticket 30): any member reads the library; the rest is an organization admin's.
  // The fixture's version holds no file, so an admin's read of one finds none.
  "library.list": ["ok", "ok", "ok", "ok", "ok"],
  "library.get": ["ok", "ok", "ok", "ok", "ok"],
  "library.counts": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "library.file": ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "library.sources.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "library.suggestions.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "library.suggestions.mine": ["ok", "ok", "ok", "ok", "ok"],
  "library.searchState": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "linear.status": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "me.get": ["ok", "ok", "ok", "ok", "ok"],
  "members.invitations": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "members.list": ["ok", "ok", "ok", "ok", "ok"],
  "memory.note": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "memory.notes": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "memory.index": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "memory.proposal": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "memory.proposals": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "notifications.list": ["ok", "ok", "ok", "ok", "ok"],
  "notifications.budgetNotices": ["ok", "ok", "ok", "ok", "ok"],
  "notifications.previewShares": ["ok", "ok", "ok", "ok", "ok"],
  "notifications.preferences.get": ["ok", "ok", "ok", "ok", "ok"],
  "notifications.openCount": ["ok", "ok", "ok", "ok", "ok"],
  "organization.get": ["ok", "ok", "ok", "ok", "ok"],
  "organization.members": ["ok", "ok", "ok", "ok", "ok"],
  // Organization › Previews (F-142): the organization's admins only.
  "organization.previews": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "organization.storage": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "joinTokens.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "pools.get": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "pools.joinTokens": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "pools.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "pools.names": ["ok", "ok", "ok", "ok", "ok"],
  "pools.queue": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "projects.access": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "projects.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "projects.reviewSettings": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.proposal": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "environments.onboarding": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "projects.getTicketTemplate": ["ok", "FORBIDDEN", "ok", "FORBIDDEN", "NOT_FOUND"],
  "projects.runners": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "projects.list": ["ok", "ok", "ok", "ok", "ok"],
  "projects.previewProviders": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "NOT_FOUND"],
  "projects.providers": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "projects.repos": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "providers.choicesToConfirm": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "providers.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "providers.previewDefaultList": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "providers.models": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "registry.get": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "registryUse.get": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "runners.list": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "runners.get": ["ok", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"],
  "runners.mine": ["ok", "ok", "ok", "ok", "ok"],
  "search.suggest": ["ok", "ok", "ok", "ok", "ok"],
  "search.tasks": ["ok", "ok", "ok", "ok", "ok"],
  "setup.status": ["ok", "ok", "ok", "ok", "ok"],
  "setup.timeline": ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "spend.currentMonth": ["ok", "ok", "ok", "ok", "ok"],
  "spend.modelPrice": ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"],
  "spend.month": ["ok", "ok", "ok", "ok", "ok"],
  "spend.project": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.attachments": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.checks": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.eventLog": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.get": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.history": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.needsApproval": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.local": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.memory": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.rounds": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "review.screen": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "previews.list": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.startCheck": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
  "tasks.runnerChoices": ["ok", "ok", "ok", "ok", "NOT_FOUND"],
};

describe("the matrix of procedures and roles (F-003, F-087)", () => {
  it("F-003/c1,c3, F-087/c4: every query procedure, called by each role, gives the result the table says", async () => {
    const actual: Record<string, Outcome[]> = {};
    for (const [path, procedure] of Object.entries(procedures)) {
      const results: Outcome[] = [];
      for (const role of roles) {
        const result = await call(await harness.as(memberOf(role)), path, procedure.input(targetOf(role)));
        results.push(outcomeSchema.parse(result.ok ? "ok" : result.code));
      }
      actual[path] = results;
    }
    expect(actual).toEqual(matrix);
  });

  it("F-003/c3, F-087: a project admin reads what only a project admin may, a project member can't, and neither is an organization admin", () => {
    const admins = Object.entries(matrix).filter(([, row]) => row[2] === "ok" && row[3] === "FORBIDDEN").map(([path]) => path);
    expect(admins).toContain("projects.getTicketTemplate");
    const organizationOnly = Object.entries(matrix).filter(([, row]) => row[0] === "ok" && row[2] === "FORBIDDEN").map(([path]) => path);
    expect(organizationOnly).toEqual(expect.arrayContaining(["providers.list", "runners.list", "pools.list"]));
  });
});

// ---------- a named person (milestone 8, F-142) ----------

describe("a person a preview names sees that preview and nothing else of the task (F-142)", () => {
  it("F-142/c3: an organization member the restricted project doesn't list, named on a task's preview, opens it watch-only, and every query procedure gives them what it gives anyone the project doesn't list", async () => {
    const { a } = harness.fixture;
    // A task in the restricted project whose box can show its preview, and the project's member names the outsider on it.
    const named = await seedPreviewableTask(harness, {
      organizationId: organizationIdSchema.parse(a.organization.id),
      projectId: projectIdSchema.parse(a.restrictedProject.id),
      ownerMemberId: a.admin.id,
      driverMemberId: a.insider.id,
    });
    const insider = await harness.as(a.insider);
    expect(await insider.previews.setLevel({ taskId: named.taskId, key: named.key, level: "named", memberIds: [a.member.id] })).toMatchObject({ ok: true, level: "named" });
    const person = await harness.as(a.member);
    try {
      // The preview: theirs to watch.
      expect(await person.previews.open({ taskId: named.taskId, key: named.key })).toMatchObject({ ok: true, input: false });
      // Everything else, called on that very task and the restricted project's rows, is what the
      // matrix gives an organization member the project doesn't list, and holds nothing of it.
      const target: Target = { rows: new Map([...restricted, ["Task", named.taskId]]), projectId: a.restrictedProject.id };
      const hiddenIds = [...idsOfRestricted, named.taskId, named.sessionId, named.boxId];
      const actual: Record<string, Outcome> = {};
      const expected: Record<string, Outcome> = {};
      const hidden: string[] = [];
      for (const [path, procedure] of Object.entries(procedures)) {
        const result = await call(person, path, procedure.input(target));
        actual[path] = outcomeSchema.parse(result.ok ? "ok" : result.code);
        const row = matrix[path];
        if (row === undefined) {
          throw new Error(`no matrix row for ${path}`);
        }
        expected[path] = row[4];
        if (result.ok) {
          hidden.push(...leaked(result.output, hiddenIds).map((id) => `${path}: ${id}`));
        }
      }
      expect(actual).toEqual(expected);
      expect(actual["tasks.get"]).toBe("NOT_FOUND");
      expect(actual["previews.list"]).toBe("NOT_FOUND");
      expect(hidden).toEqual([]);
    } finally {
      await insider.previews.setLevel({ taskId: named.taskId, key: named.key, level: "members", memberIds: [] });
    }
  });
});
