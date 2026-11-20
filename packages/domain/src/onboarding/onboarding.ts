import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { environmentIdSchema, environmentProposalIdSchema, environmentProposalSchema, organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { EnvironmentEntry, EnvironmentProposal, EnvironmentProposalId, OrganizationId, OstraToolSet, ProjectId, RepoId, TaskId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { scanMemoryText } from "../memory/secret-scan.ts";
import { organizationSecretValues } from "../memory/store.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import { onboardingPrompt } from "../prompts/m6.ts";
import type { DraftEnvironmentRepo } from "../prompts/m6.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { createPromptTask } from "../use-cases/create-prompt-task.ts";
import type { CreatePromptTaskResult } from "../use-cases/create-prompt-task.ts";
import { detectRepoEnvironment } from "../use-cases/create-project.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx } from "../use-cases/needs-you-items.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { saveEnvironment } from "../use-cases/save-environment.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";

// The onboarding task and environment proposals (F-113, ADR 0038 amended; milestone 6's ticket 21).
// - `startOnboarding`, a project admin's "Test this environment": a code task with the origin
//   `onboarding` from the built-in template (the onboarding prompt) on the project's environment,
//   or the detected draft (F-112) when none is saved. Its box starts from the base image (no
//   snapshot), the sidecar serves `propose_environment` and the PR text (`ONBOARDING_TOOLS`), and the
//   runner commits only `AGENTS.md` (`ONBOARDING_COMMIT_PATHS`); the prompt names the repos that lack
//   one. One open onboarding task per project.
// - `proposeEnvironment`, the `environment-proposal` endpoint's use case: an onboarding task only;
//   milestone 4's secret scan over the scripts, the checks, the services and the notes, with the
//   organization's secret values (the environment's among them); a hit refuses, naming the kind.
//   An earlier open proposal is superseded; `environment.proposed` goes in the thread, and a
//   needs-you item (`environment_proposal`) waits on the project's admins.
// - `decideEnvironmentProposal`, a project admin's: "Accept" (or "Edit and accept") saves the
//   environment's next version through milestone 1's `saveEnvironment`, keeping its entries and
//   secrets, in one transaction with the audit entry; "Reject" with a reason. A proposal never holds
//   a secret's value.
// Scripts, notes and the agent's words never reach a log line.

/** The sidecar's tools for an onboarding task: the proposal, and the PR's text for its `AGENTS.md` PR. */
export const ONBOARDING_TOOLS = ["environment", "pr-text"] as const satisfies readonly OstraToolSet[];

/** The only paths an onboarding turn commits, in every repo (ADR 0038). */
export const ONBOARDING_COMMIT_PATHS = ["AGENTS.md"] as const;

/** The onboarding task's title. */
export const ONBOARDING_TITLE = "Set up the environment";

/**
 * The line an onboarding task's prompt gains on the `host` executor (ADR 0029): services need a
 * container runtime, so they aren't started there. Core adds it when the box is a host's.
 */
export const ONBOARDING_HOST_LINE =
  "This box runs on the host executor, where services aren't available: don't try to start them. You may still name the services the project needs in the proposal; a project admin sees them as not tested here.";

/** The task states an onboarding task is still open in. */
const ENDED = ["stopped", "merged", "done"] as const;

export type OnboardingDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly logger?: Logger;
};

export type StartOnboardingResult = UseCaseResult<
  { readonly taskId: TaskId },
  "forbidden" | "not-found" | "already-running" | Exclude<CreatePromptTaskResult, { readonly ok: true }>["error"]
>;

/** Each repo's draft for the prompt: the saved environment's, else what detection reads from the repo (F-112). */
const draftReposOf = async (
  deps: OnboardingDeps,
  organizationId: OrganizationId,
  projectId: ProjectId,
): Promise<readonly DraftEnvironmentRepo[]> => {
  const { db } = deps;
  const { codeHost, secretStore } = deps.adapters;
  const [repos, environment] = await Promise.all([
    db.repo.findMany({ where: { projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, fullName: true, defaultBranch: true } }),
    db.environment.findFirst({ where: { projectId, organizationId }, select: { id: true, status: true, setupScript: true } }),
  ]);
  const saved = environment?.status === "saved" ? environment : null;
  const checks = saved === null ? [] : await db.check.findMany({ where: { environmentId: saved.id }, orderBy: { position: "asc" }, select: { name: true, command: true, repoId: true } });
  const drafts: DraftEnvironmentRepo[] = [];
  for (const [index, repo] of repos.entries()) {
    const access = await repoAccessFor(db, secretStore, organizationId, repoIdSchema.parse(repo.id));
    if (!access.ok) {
      throw new Error(`startOnboarding: ${access.reason}`);
    }
    const agentsMd = await codeHost.readFiles(access.access, repo.defaultBranch, ["AGENTS.md"]);
    if (!agentsMd.ok) {
      throw new Error(`startOnboarding: the code host couldn't read the repo's files (${agentsMd.error.code})`);
    }
    const hasAgentsMd = agentsMd.value.files.some((file) => file.path === "AGENTS.md");
    const fullName = repoFullNameSchema.parse(repo.fullName);
    if (saved !== null) {
      // The environment's one setup script runs in the workspace: it's shown with the first repo.
      drafts.push({
        fullName,
        setupScript: index === 0 ? (saved.setupScript ?? "") : "",
        checks: checks.filter((check) => check.repoId === repo.id || (check.repoId === null && index === 0)).map((check) => ({ name: check.name, command: check.command })),
        hasAgentsMd,
      });
      continue;
    }
    const detected = await detectRepoEnvironment(codeHost, access.access, repo.defaultBranch);
    drafts.push({ fullName, setupScript: detected.setupScript ?? "", checks: [], hasAgentsMd });
  }
  return drafts;
};

/**
 * A project admin starts the onboarding task. Reads each repo (its `AGENTS.md`, and the detected
 * draft when no environment is saved) before the transaction; a code host failure throws.
 */
export const startOnboarding = async (deps: OnboardingDeps, scope: MemberScope, input: { readonly projectId: ProjectId }): Promise<StartOnboardingResult> => {
  const { db } = deps;
  const organizationId = scope.organizationId;
  const project = await db.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "Only a project admin starts the onboarding task" };
  }
  const repos = await draftReposOf(deps, organizationId, input.projectId);
  const prompt = onboardingPrompt({ repos });
  return db.$transaction(
    async (tx): Promise<StartOnboardingResult> => {
      // One open onboarding task per project: the project's row is the lock two starts meet on.
      await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const open = await tx.task.findFirst({ where: { projectId: input.projectId, onboarding: true, state: { notIn: [...ENDED] } }, select: { id: true } });
      if (open !== null) {
        return { ok: false, error: "already-running", message: "The project's onboarding task is still open" };
      }
      const created = await createPromptTask({ tx, scope, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock }, { projectId: input.projectId, prompt, title: ONBOARDING_TITLE });
      if (!created.ok) {
        return created;
      }
      await tx.task.update({ where: { id: created.taskId }, data: { onboarding: true, origin: "onboarding" } });
      deps.logger?.info("onboarding.started", { taskId: created.taskId, projectId: input.projectId, repos: repos.length, withoutAgentsMd: repos.filter((repo) => !repo.hasAgentsMd).length });
      return { ok: true, taskId: created.taskId };
    },
    { timeout: 20_000 },
  );
};

// ---------- the proposal ----------

export type ProposeEnvironmentDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  readonly db: Db;
  readonly adapters: Pick<ServerAdapters, "secretStore">;
  readonly logger?: Logger;
};

export type ProposeEnvironmentResult =
  | { readonly ok: true; readonly proposalId: EnvironmentProposalId }
  | { readonly ok: false; readonly error: "wrong-kind" | "invalid"; readonly message: string }
  | { readonly ok: false; readonly error: "secret-found"; readonly message: string; readonly found: readonly string[] };

/** Every piece of a proposal's text the secret scan reads: the scripts, the checks, the services and the notes. */
export const proposalTexts = (proposal: EnvironmentProposal): readonly string[] => [
  ...proposal.repos.flatMap((repo) => [repo.setupScript ?? "", ...repo.checks.flatMap((check) => [check.name, check.command]), ...repo.variableNames]),
  ...proposal.services.flatMap((service) => [service.name, service.image, service.healthCheck ?? "", ...service.variableNames]),
  proposal.notes,
];

/** The `environment-proposal` endpoint's use case, for the task the token is for. */
export const proposeEnvironment = async (deps: ProposeEnvironmentDeps, input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly proposal: EnvironmentProposal }): Promise<ProposeEnvironmentResult> => {
  const { db } = deps;
  const task = await db.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId }, select: { id: true, projectId: true, kind: true, onboarding: true } });
  if (task?.kind !== "code" || !task.onboarding) {
    return { ok: false, error: "wrong-kind", message: "Only an onboarding task proposes an environment" };
  }
  const projectId = projectIdSchema.parse(task.projectId);
  const parsed = environmentProposalSchema.safeParse(input.proposal);
  if (!parsed.success) {
    return { ok: false, error: "invalid", message: "The proposal doesn't parse" };
  }
  const proposal = parsed.data;
  const repoIds = new Set((await db.repo.findMany({ where: { projectId, organizationId: input.organizationId }, select: { id: true } })).map((repo) => repo.id));
  if (proposal.repos.some((repo) => !repoIds.has(repo.repoId)) || new Set(proposal.repos.map((repo) => repo.repoId)).size !== proposal.repos.length) {
    return { ok: false, error: "invalid", message: "The proposal names a repo that isn't the project's, or one twice" };
  }
  // Milestone 4's scan: the organization's secret values (the environment's own among them) and the credential shapes.
  const scan = scanMemoryText(proposalTexts(proposal), await organizationSecretValues(db, deps.adapters.secretStore, input.organizationId));
  if (!scan.ok) {
    deps.logger?.info("environment.proposal-refused", { taskId: input.taskId, code: "secret-found", found: scan.found.length });
    return { ok: false, error: "secret-found", message: `The proposal holds ${scan.found.join(", ")}: name the variable instead, and a project admin sets its value.`, found: scan.found };
  }
  const now = deps.clock.now();
  const proposalId = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${task.id} FOR UPDATE`;
      const environment =
        (await tx.environment.findFirst({ where: { projectId, organizationId: input.organizationId }, select: { id: true } })) ??
        (await tx.environment.create({ data: { organizationId: input.organizationId, projectId, status: "draft" }, select: { id: true } }));
      // An earlier open proposal is superseded by this one.
      await tx.environmentProposal.updateMany({ where: { environmentId: environment.id, state: "proposed" }, data: { state: "superseded" } });
      const row = await tx.environmentProposal.create({
        data: { organizationId: input.organizationId, projectId, environmentId: environment.id, taskId: task.id, body: { repos: proposal.repos, services: proposal.services, notes: proposal.notes }, notes: proposal.notes, state: "proposed" },
        select: { id: true },
      });
      const id = environmentProposalIdSchema.parse(row.id);
      const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session !== null) {
        await appendServerEvent(tx, { organizationId: input.organizationId, projectId, taskId: input.taskId, sessionId: sessionIdSchema.parse(session.id), at: now, event: { kind: "environment.proposed", proposalId: id } });
      }
      // The project's admins decide it: the item is the project's, and only an admin can answer it.
      await createNeedsYouItemInTx(deps, tx, { organizationId: input.organizationId, projectId, taskId: task.id, reason: "environment_proposal", audience: "project_members" });
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId, entity: "task", entityId: input.taskId });
      return id;
    },
    { timeout: 20_000 },
  );
  deps.logger?.info("environment.proposed", { taskId: input.taskId, proposalId, repos: proposal.repos.length, services: proposal.services.length });
  return { ok: true, proposalId };
};

// ---------- the decision ----------

export type DecideEnvironmentProposalDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock" | "adapters"> & { readonly db: Db };

export type EnvironmentDecision =
  /** "Accept" (`edited: null`) or "Edit and accept" (the admin's edit of the proposal). */
  | { readonly kind: "accept"; readonly edited: EnvironmentProposal | null }
  /** "Reject", with the admin's reason. The audit entry records that one was given, never its words. */
  | { readonly kind: "reject"; readonly reason?: string };

export type DecideEnvironmentProposalResult =
  | UseCaseResult<{ readonly resultVersion: number | null }, "forbidden" | "not-found" | "already-decided" | "invalid-input">
  /** An admin's edit holding a secret's value (ticket 29): milestone 4's scan, as the agent's proposal gets. */
  | { readonly ok: false; readonly error: "secret-found"; readonly message: string; readonly found: readonly string[] };

/** The environment's version: how many times it was saved, as its audit trail counts them. */
const environmentVersionInTx = (tx: Tx, environmentId: string): Promise<number> => tx.auditEntry.count({ where: { entity: "environment", entityId: environmentId, action: "environment.saved" } });

/**
 * The proposal's scripts as the environment's one setup script: each repo's in its own folder of
 * the workspace, in the project's order. One repo's script runs as it is.
 */
export const proposedSetupScript = (repos: readonly { readonly checkoutDir: string; readonly setupScript: string | null }[]): string | null => {
  const scripts = repos.filter((repo) => repo.setupScript !== null && repo.setupScript.trim() !== "");
  if (scripts.length === 0) {
    return null;
  }
  if (repos.length === 1) {
    return scripts[0]?.setupScript ?? null;
  }
  return scripts.map((repo) => `# ${repo.checkoutDir}\n(\n  cd ${JSON.stringify(repo.checkoutDir)}\n${repo.setupScript ?? ""}\n)`).join("\n\n");
};

const refuse = (error: Exclude<Exclude<DecideEnvironmentProposalResult, { readonly ok: true }>["error"], "secret-found">, message: string): DecideEnvironmentProposalResult => ({ ok: false, error, message });

export const decideEnvironmentProposal = (deps: DecideEnvironmentProposalDeps, scope: MemberScope, input: { readonly proposalId: EnvironmentProposalId; readonly decision: EnvironmentDecision }): Promise<DecideEnvironmentProposalResult> =>
  deps.db.$transaction(
    async (tx): Promise<DecideEnvironmentProposalResult> => {
      const organizationId = scope.organizationId;
      const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "environment_proposal" WHERE "id" = ${input.proposalId} AND "organizationId" = ${organizationId} FOR UPDATE`;
      if (locked.length === 0) {
        return refuse("not-found", "No such proposal");
      }
      const proposal = await tx.environmentProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
      const project = await tx.project.findFirst({ where: { id: proposal.projectId, organizationId }, select: { id: true, access: true } });
      if (project === null) {
        return refuse("not-found", "No such proposal");
      }
      const projectId = projectIdSchema.parse(project.id);
      const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "admin");
      if (!access.ok) {
        return access.code === "not-found" ? refuse("not-found", "No such proposal") : refuse("forbidden", "Only a project admin decides an environment proposal");
      }
      if (proposal.state !== "proposed") {
        return refuse("already-decided", "This proposal was decided already, or a newer one replaced it");
      }
      const now = new Date(deps.clock.now());
      const taskId = taskIdSchema.parse(proposal.taskId);
      const answerItem = async (): Promise<void> => {
        await resolveNeedsYouItemsInTx(deps, tx, { taskId, reason: "environment_proposal" }, { state: "answered", at: now, byMemberId: scope.memberId });
        await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
      };
      if (input.decision.kind === "reject") {
        await tx.environmentProposal.update({ where: { id: proposal.id }, data: { state: "rejected", decidedByMemberId: scope.memberId, decidedAt: now } });
        await deps.audit.recordInTx(tx, {
          organizationId,
          projectId,
          actor: { kind: "member", id: scope.memberId },
          action: "environment.proposal-rejected",
          entity: "environment",
          entityId: environmentIdSchema.parse(proposal.environmentId),
          data: { proposalId: proposal.id, taskId, withReason: (input.decision.reason ?? "").trim() !== "" },
        });
        await answerItem();
        return { ok: true, resultVersion: null };
      }
      const body = environmentProposalSchema.safeParse(input.decision.edited ?? proposal.body);
      if (!body.success) {
        return refuse("invalid-input", "The proposal doesn't parse");
      }
      const accepted = body.data;
      // An admin's edit is scanned as the agent's proposal was: a variable's value goes in as a secret, never in a script (ticket 29).
      if (input.decision.edited !== null) {
        const scan = scanMemoryText(proposalTexts(accepted), await organizationSecretValues(tx, deps.adapters.secretStore, organizationId));
        if (!scan.ok) {
          return { ok: false, error: "secret-found", message: `The edit holds ${scan.found.join(", ")}: name the variable instead, and set its value as a secret.`, found: scan.found };
        }
      }
      const repos = await tx.repo.findMany({ where: { projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, checkoutDir: true } });
      if (accepted.repos.some((repo) => !repos.some((one) => one.id === repo.repoId))) {
        return refuse("invalid-input", "The proposal names a repo that isn't in this project");
      }
      const names = accepted.repos.flatMap((repo) => repo.checks.map((check) => check.name));
      if (new Set(names).size !== names.length || new Set(accepted.services.map((service) => service.name)).size !== accepted.services.length) {
        return refuse("invalid-input", "Two checks, or two services, have one name");
      }
      // The environment as it is: its entries are kept, and a secret is kept by its reference (no value is sent).
      const environment = await tx.environment.findUniqueOrThrow({ where: { id: proposal.environmentId } });
      const entries = await tx.environmentEntry.findMany({ where: { environmentId: environment.id }, orderBy: { createdAt: "asc" } });
      const repoRows = await tx.repo.findMany({ where: { projectId, organizationId }, select: { id: true, envFile: true } });
      const scriptOf = new Map(accepted.repos.map((repo) => [repo.repoId, repo.setupScript] as const));
      const saved = await saveEnvironment(
        { tx, scope, notices: deps.notices, audit: deps.audit, clock: deps.clock, adapters: deps.adapters },
        {
          projectId,
          environment: {
            baseImage: environment.baseImage,
            setupScript: proposedSetupScript(repos.map((repo) => ({ checkoutDir: repo.checkoutDir, setupScript: scriptOf.get(repoIdSchema.parse(repo.id)) ?? null }))),
            envFiles: repoRows.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), path: repo.envFile })),
            entries: entries.flatMap((entry): EnvironmentEntry[] => {
              const repoId: RepoId = repoIdSchema.parse(entry.repoId);
              const base = { repoId, availableDuringSetup: entry.availableDuringSetup };
              switch (entry.kind) {
                case "variable":
                  return entry.name === null ? [] : [{ ...base, kind: "variable" as const, name: entry.name, value: entry.value ?? "" }];
                case "secret":
                  return entry.name === null ? [] : [{ ...base, kind: "secret" as const, name: entry.name }];
                case "file":
                  return entry.path === null ? [] : [{ ...base, kind: "file" as const, path: entry.path, content: entry.value ?? "" }];
                default:
                  return entry.kind satisfies never;
              }
            }),
          },
        },
      );
      if (!saved.ok) {
        return refuse("invalid-input", saved.message);
      }
      // The checks and services by name: the proposal's are written, the others are kept.
      for (const [position, check] of accepted.repos.flatMap((repo) => repo.checks.map((one) => ({ ...one, repoId: repo.repoId }))).entries()) {
        const data = { command: check.command, repoId: check.repoId, timeoutSeconds: check.timeoutSeconds, position };
        await tx.check.upsert({ where: { environmentId_name: { environmentId: environment.id, name: check.name } }, create: { organizationId, projectId, environmentId: environment.id, name: check.name, ...data }, update: data });
      }
      for (const service of accepted.services) {
        const data = { image: service.image, port: service.port, healthCheck: service.healthCheck };
        await tx.service.upsert({
          where: { environmentId_name: { environmentId: environment.id, name: service.name } },
          create: { organizationId, projectId, environmentId: environment.id, name: service.name, variables: [], ...data },
          update: data,
        });
      }
      const resultVersion = await environmentVersionInTx(tx, environment.id);
      await tx.environmentProposal.update({ where: { id: proposal.id }, data: { state: "accepted", decidedByMemberId: scope.memberId, decidedAt: now, resultVersion, ...(input.decision.edited === null ? {} : { body: { repos: accepted.repos, services: accepted.services, notes: accepted.notes } }) } });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "environment.proposal-accepted",
        entity: "environment",
        entityId: environmentIdSchema.parse(environment.id),
        data: { proposalId: proposal.id, taskId, edited: input.decision.edited !== null, resultVersion, checks: names.length, services: accepted.services.length },
      });
      // The environment changed: its snapshot is rebuilt, as a saved check or service does.
      await deps.jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId: organizationIdSchema.parse(organizationId), projectId, reason: "environment-changed" });
      await answerItem();
      return { ok: true, resultVersion };
    },
    { timeout: 20_000 },
  );
