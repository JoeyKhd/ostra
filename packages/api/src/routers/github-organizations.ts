import type { Installation } from "@ostra/adapter-sdk";
import {
  appOwnerInTx,
  installationUsable,
  isOwnInstallation,
  linkInstallationInTx,
  linkOwnInstallationInTx,
  NOT_LINKED_MESSAGE,
  removeInstallation,
  seenInstallationOf,
  unlinkInstallation,
} from "@ostra/domain";
import type { InstallationDeps, MemberScope } from "@ostra/domain";
import { connectionIdSchema, memberIdSchema, projectIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { githubConnectionsOf, loadGitHubConnection } from "../services/github-connection.ts";
import type { GitHubConnection } from "../services/github-connection.ts";
import type { Context } from "../trpc/context.ts";
import { adapterErrorToTrpc } from "../trpc/errors.ts";
import { adminProcedure, unwrap } from "../trpc/init.ts";

// F-136 (ticket 51; ADR 0065): GitHub organizations, installations and several Apps in the panel.
// Each App the organization connected, with its owner, its own webhook address, its webhook's
// state, and its installations: linked (ostra works through them), waiting (seen on GitHub, on
// another account, not linked), and removed. An organization admin links, unlinks and removes an
// installation, each with its audit entry. Repos come only from linked installations: a waiting
// one's are offered nowhere.

/** The refusal for a repo of an installation ostra may not use (the domain's, so `projects.addRepo` says the same). */
export { NOT_LINKED_MESSAGE };

/** Where GitHub delivers a connection's events: its own address (core's `/webhooks/github/:id`). */
export const webhookUrlOf = (corePublicUrl: string, connectionId: ConnectionId): string => `${corePublicUrl}/webhooks/github/${connectionId}`;

const personSchema = z.object({ memberId: memberIdSchema, name: z.string() }).nullable();

const repoViewSchema = z.object({ hostRepoId: z.string(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() });

const installationViewSchema = z.object({
  installationId: z.string(),
  accountLogin: z.string(),
  accountKind: z.enum(["organization", "user"]).nullable(),
  /** `linked`: ostra works through it. `waiting`: on GitHub, not linked. `removed`: unlinked or uninstalled. */
  state: z.enum(["linked", "waiting", "removed", "suspended"]),
  /** On the App owner's own account. */
  isOwner: z.boolean(),
  /** `null` when GitHub doesn't list it any more. */
  repoSelection: z.enum(["all", "selected"]).nullable(),
  /** A linked installation's repos; a waiting or removed one's are offered nowhere, so empty. */
  repos: z.array(repoViewSchema),
  installedAt: z.number().nullable(),
  /** The admin who linked it; `null` for the owner's own, linked by ostra, or the upgrade's. */
  installedBy: personSchema,
  removedAt: z.number().nullable(),
  removedBy: personSchema,
  /** The projects with a repo through it. */
  projects: z.array(z.object({ projectId: projectIdSchema, name: z.string() })),
});

const webhookStateSchema = z.discriminatedUnion("kind", [
  /** The App has no webhook secret: it takes no events. */
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("receiving"), lastDeliveryAt: z.number().nullable() }),
  z.object({ kind: z.literal("failing"), lastDeliveryAt: z.number(), lastError: z.string() }),
]);

export const connectionsViewSchema = z.array(
  z.object({
    connectionId: connectionIdSchema,
    appId: z.string(),
    slug: z.string().nullable(),
    ownerLogin: z.string().nullable(),
    ownerKind: z.enum(["organization", "user"]).nullable(),
    /** `true` when another account has it installed; `null` when ostra can't tell. */
    public: z.boolean().nullable(),
    /** The organization's own App: the first one connected. */
    own: z.boolean(),
    webhookUrl: z.string(),
    webhook: webhookStateSchema,
    installations: z.array(installationViewSchema),
  }),
);

/**
 * Whether ostra may work through an installation of this App now: its row, linked. One ostra hasn't
 * seen yet is linked here when it's on the App owner's own account; one on another account waits.
 * When the host doesn't say who owns the App, the admin's choice links it, as before milestone 4.
 */
export const installationAccess = async (
  ctx: Pick<Context, "deps"> & { readonly scope: MemberScope },
  github: GitHubConnection,
  installationId: string,
): Promise<"linked" | "not-linked" | "unknown"> => {
  const { db, ports } = ctx.deps;
  const known = await db.codeHostInstallation.findUnique({
    where: { connectionId_installationId: { connectionId: github.connectionId, installationId } },
    select: { state: true, removedAt: true },
  });
  if (known !== null) {
    return installationUsable(known) ? "linked" : "not-linked";
  }
  const listed = await ports.adapters.codeHost.listInstallations(github.credentials);
  const seen = listed.ok ? listed.value.find((installation) => installation.installationId === installationId) : undefined;
  if (seen === undefined) {
    return "unknown";
  }
  const linked = await db.$transaction(async (tx) => {
    const connection = await tx.connection.findFirstOrThrow({ where: { id: github.connectionId, organizationId: ctx.scope.organizationId } });
    const owner = await appOwnerInTx(tx, ports.adapters.codeHost, github.credentials, connection);
    if (owner.accountId === null && owner.login === null) {
      return true;
    }
    return linkOwnInstallationInTx(ports, tx, { organizationId: ctx.scope.organizationId, connectionId: github.connectionId, owner, installation: seenInstallationOf(seen) });
  });
  return linked ? "linked" : "not-linked";
};

/** Throws unless ostra may work through the installation: `NOT_FOUND` for one GitHub doesn't list, `PRECONDITION_FAILED` for one that isn't linked. */
export const requireLinkedInstallation = async (ctx: Pick<Context, "deps"> & { readonly scope: MemberScope }, github: GitHubConnection, installationId: string): Promise<void> => {
  const access = await installationAccess(ctx, github, installationId);
  switch (access) {
    case "linked":
      return;
    case "unknown":
      throw new TRPCError({ code: "NOT_FOUND", message: "GitHub lists no such installation of this App" });
    case "not-linked":
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: NOT_LINKED_MESSAGE });
    default:
      access satisfies never;
  }
};

const installationDeps = (ctx: Pick<Context, "deps">): InstallationDeps => ({ db: ctx.deps.db, audit: ctx.deps.ports.audit, clock: ctx.deps.ports.clock });

const installationInput = z.strictObject({ connectionId: connectionIdSchema, installationId: z.string().min(1).max(64) });

const installationErrors = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" } as const;

/** One App's view: its installations as GitHub lists them and as ostra keeps them. */
const connectionView = async (ctx: Pick<Context, "deps"> & { readonly scope: MemberScope }, row: Awaited<ReturnType<typeof githubConnectionsOf>>[number], own: boolean) => {
  const { db, ports, settings } = ctx.deps;
  const organizationId = ctx.scope.organizationId;
  const connectionId = connectionIdSchema.parse(row.id);
  // An App whose key can't be read is still listed, with what ostra keeps of it.
  const github = await loadGitHubConnection(ctx.deps, ctx.scope, connectionId).catch(() => null);
  const listed = github === null ? null : await ports.adapters.codeHost.listInstallations(github.credentials);
  const seen: readonly Installation[] = listed?.ok === true ? listed.value : [];
  // The owner's own installations are linked as a listing shows them (ticket 49's rule).
  const owner =
    github === null
      ? { accountId: row.ownerAccountId, login: row.ownerLogin }
      : await db.$transaction(async (tx) => {
          const connection = await tx.connection.findFirstOrThrow({ where: { id: connectionId, organizationId } });
          const known = await appOwnerInTx(tx, ports.adapters.codeHost, github.credentials, connection);
          for (const installation of seen) {
            await linkOwnInstallationInTx(ports, tx, { organizationId, connectionId, owner: known, installation: seenInstallationOf(installation) });
          }
          return known;
        });
  const [rows, repoRows, lastDelivery] = await Promise.all([
    db.codeHostInstallation.findMany({ where: { organizationId, connectionId }, orderBy: [{ linkedAt: "asc" }, { id: "asc" }] }),
    db.repo.findMany({ where: { organizationId, connectionId }, select: { installationId: true, project: { select: { id: true, name: true } } } }),
    db.webhookDelivery.findFirst({ where: { organizationId, connectionId }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], select: { status: true, receivedAt: true, error: true } }),
  ]);
  const memberIds = [...new Set(rows.flatMap((installation) => [installation.linkedByMemberId, installation.removedByMemberId]).filter((id): id is string => id !== null))];
  const members = memberIds.length === 0 ? [] : await db.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, user: { select: { name: true } } } });
  const nameOf = new Map(members.map((member) => [member.id, member.user.name] as const));
  const person = (id: string | null) => (id === null ? null : { memberId: memberIdSchema.parse(id), name: nameOf.get(id) ?? "A former member" });
  const byId = new Map(rows.map((installation) => [installation.installationId, installation] as const));
  const seenById = new Map(seen.map((installation) => [installation.installationId, installation] as const));
  const ids = [...new Set([...seen.map((installation) => installation.installationId), ...rows.map((installation) => installation.installationId)])];
  const installations = [];
  for (const installationId of ids) {
    const stored = byId.get(installationId);
    const listedNow = seenById.get(installationId);
    const accountLogin = listedNow?.accountLogin ?? stored?.accountLogin ?? "";
    const accountId = listedNow?.accountId ?? stored?.accountId ?? null;
    const linked = stored !== undefined && installationUsable(stored);
    const state = linked ? ("linked" as const) : stored?.state === "removed" ? ("removed" as const) : ("waiting" as const);
    let repos: z.infer<typeof repoViewSchema>[] = [];
    if (linked && listedNow !== undefined && github !== null) {
      const listedRepos = await ports.adapters.codeHost.listRepos(github.credentials, installationId);
      repos = listedRepos.ok ? listedRepos.value.map((repo) => ({ hostRepoId: repo.hostRepoId, fullName: repo.fullName, defaultBranch: repo.defaultBranch, private: repo.private })) : [];
    }
    const projects = new Map(repoRows.filter((repo) => repo.installationId === installationId).map((repo) => [repo.project.id, repo.project.name] as const));
    installations.push({
      installationId,
      accountLogin,
      accountKind: listedNow?.accountKind ?? stored?.accountKind ?? null,
      state,
      isOwner: isOwnInstallation(owner, { accountId, accountLogin }),
      repoSelection: listedNow?.repositorySelection ?? null,
      repos,
      installedAt: stored === undefined ? null : stored.linkedAt.getTime(),
      installedBy: person(stored?.linkedByMemberId ?? null),
      removedAt: stored?.removedAt?.getTime() ?? null,
      removedBy: person(stored?.removedByMemberId ?? null),
      projects: [...projects.entries()].map(([projectId, name]) => ({ projectId: projectIdSchema.parse(projectId), name })).sort((x, y) => x.name.localeCompare(y.name)),
    });
  }
  const ownerInstallation = installations.find((installation) => installation.isOwner);
  const webhook: z.infer<typeof webhookStateSchema> =
    row.webhookSecretSecretRef === null
      ? { kind: "none" }
      : lastDelivery?.status === "failed"
        ? { kind: "failing", lastDeliveryAt: lastDelivery.receivedAt.getTime(), lastError: lastDelivery.error ?? "The last delivery failed" }
        : { kind: "receiving", lastDeliveryAt: lastDelivery?.receivedAt.getTime() ?? null };
  return {
    connectionId,
    appId: row.appId,
    slug: row.slug,
    ownerLogin: owner.login,
    ownerKind: ownerInstallation?.accountKind ?? null,
    public: installations.some((installation) => !installation.isOwner && (owner.accountId !== null || owner.login !== null)) ? true : null,
    own,
    webhookUrl: webhookUrlOf(settings.corePublicUrl, connectionId),
    webhook,
    installations,
  };
};

export const githubOrganizationProcedures = {
  /** Every App the organization connected, its own first, each with its installations. */
  connections: adminProcedure.output(connectionsViewSchema).query(async ({ ctx }) => {
    const rows = await githubConnectionsOf(ctx.deps, ctx.scope);
    const views = [];
    for (const [index, row] of rows.entries()) {
      views.push(await connectionView(ctx, row, index === 0));
    }
    return views;
  }),

  /**
   * The repos of every linked installation, grouped by the account it's on, across the Apps: what a
   * project can be made from. A waiting or removed installation's repos aren't here.
   */
  reposByAccount: adminProcedure
    .output(
      z.array(
        z.object({
          connectionId: connectionIdSchema,
          installationId: z.string(),
          accountLogin: z.string(),
          accountKind: z.enum(["organization", "user"]).nullable(),
          repos: z.array(repoViewSchema),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const groups = [];
      for (const row of await githubConnectionsOf(ctx.deps, ctx.scope)) {
        const github = await loadGitHubConnection(ctx.deps, ctx.scope, connectionIdSchema.parse(row.id)).catch(() => null);
        const listed = github === null ? null : await ctx.deps.ports.adapters.codeHost.listInstallations(github.credentials);
        if (github === null || !listed?.ok) {
          continue;
        }
        for (const installation of listed.value) {
          if ((await installationAccess(ctx, github, installation.installationId)) !== "linked") {
            continue;
          }
          const repos = await ctx.deps.ports.adapters.codeHost.listRepos(github.credentials, installation.installationId);
          groups.push({
            connectionId: github.connectionId,
            installationId: installation.installationId,
            accountLogin: installation.accountLogin,
            accountKind: installation.accountKind,
            repos: repos.ok ? repos.value.map((repo) => ({ hostRepoId: repo.hostRepoId, fullName: repo.fullName, defaultBranch: repo.defaultBranch, private: repo.private })) : [],
          });
        }
      }
      return groups.sort((x, y) => x.accountLogin.localeCompare(y.accountLogin));
    }),

  /** An organization admin links an installation GitHub lists for the App: ostra may then use it. */
  linkInstallation: adminProcedure
    .input(installationInput)
    .output(z.object({ linked: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope, input.connectionId);
      const listed = await ctx.deps.ports.adapters.codeHost.listInstallations(github.credentials);
      if (!listed.ok) {
        throw adapterErrorToTrpc(listed.error, "GitHub did not list the App's installations");
      }
      const seen = listed.value.find((installation) => installation.installationId === input.installationId);
      if (seen === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: "GitHub lists no such installation of this App" });
      }
      // The connection is this organization's (`loadGitHubConnection`), and the caller its admin.
      await ctx.deps.db.$transaction((tx) =>
        linkInstallationInTx(ctx.deps.ports, tx, { organizationId: ctx.scope.organizationId, connectionId: github.connectionId, installation: seenInstallationOf(seen), memberId: ctx.scope.memberId }),
      );
      return { linked: true as const };
    }),

  /** Stops using an installation: no token, no repo, no delivery; the App stays installed on GitHub. */
  unlinkInstallation: adminProcedure
    .input(installationInput)
    .output(z.object({ at: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await loadGitHubConnection(ctx.deps, ctx.scope, input.connectionId);
      const result = unwrap(await unlinkInstallation(installationDeps(ctx), ctx.scope, input), installationErrors);
      return { at: result.at };
    }),

  /** Unlinks it and uninstalls the App from that account on GitHub; a failed uninstall leaves it linked. */
  removeInstallation: adminProcedure
    .input(installationInput)
    .output(z.object({ at: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope, input.connectionId);
      const uninstall = async (installationId: string): Promise<void> => {
        const removed = await ctx.deps.ports.adapters.codeHost.removeInstallation(github.credentials, installationId);
        if (!removed.ok) {
          throw adapterErrorToTrpc(removed.error, "GitHub did not remove the installation");
        }
      };
      const result = unwrap(await removeInstallation({ ...installationDeps(ctx), uninstall }, ctx.scope, input), installationErrors);
      return { at: result.at };
    }),
};
