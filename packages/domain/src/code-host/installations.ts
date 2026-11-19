import type { Db, Tx } from "@ostra/db";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId, MemberId, OrganizationId, TaskSpec } from "@ostra/protocol";
import { taskSpecNeedsMinor2, taskSpecNeedsMinor3 } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";

// Linked installations and several Apps (F-136, ADR 0065, Q279 to Q283): ostra works only through
// installations an organization admin linked, or the App owner's own, linked when seen. Nothing
// is minted, offered or stored for any other. An organization admin can also connect an App
// another GitHub account owns, beside the organization's own. Each repo's commits are its own
// App's bot's, at protocol minor 3.

/** The audit actions of linked installations (spec section 5.5). */
export const installationAuditActions = {
  linked: "installation.linked",
  unlinked: "installation.unlinked",
  removed: "installation.removed",
  connectionAdded: "connection.added",
} as const;

export type InstallationRow = { readonly state: "linked" | "removed"; readonly removedAt: Date | null };

/**
 * The one rule every token mint and repo listing asks (F-136): a known installation that's linked
 * and not removed. An unknown one (`null`) is never usable.
 */
export const installationUsable = (row: InstallationRow | null): boolean => row !== null && row.state === "linked" && row.removedAt === null;

/** An installation as the code host lists it. */
export type SeenInstallation = {
  readonly installationId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly accountKind: "organization" | "user";
};

export type InstallationDeps = { readonly db: Db } & Pick<Ports, "audit" | "clock">;

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const connectionOf = (tx: Tx, organizationId: OrganizationId, connectionId: ConnectionId) =>
  tx.connection.findFirst({ where: { id: connectionId, organizationId, kind: "github" }, select: { id: true, ownerAccountId: true } });

const upsertLinked = async (tx: Tx, organizationId: OrganizationId, connectionId: ConnectionId, seen: SeenInstallation, memberId: MemberId | null, at: number): Promise<void> => {
  const data = {
    accountId: seen.accountId,
    accountLogin: seen.accountLogin,
    accountKind: seen.accountKind,
    state: "linked" as const,
    linkedByMemberId: memberId,
    linkedAt: new Date(at),
    removedAt: null,
    removedByMemberId: null,
  };
  await tx.codeHostInstallation.upsert({
    where: { connectionId_installationId: { connectionId, installationId: seen.installationId } },
    create: { organizationId, connectionId, installationId: seen.installationId, ...data },
    update: data,
  });
};

/**
 * An installation ostra just saw (a webhook, a listing). On the App owner's own account it's
 * linked at once, with an audit entry by the system; any other waits for an admin.
 */
export const linkOwnInstallation = async (
  deps: InstallationDeps,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly installation: SeenInstallation },
): Promise<UseCaseResult<{ readonly linked: boolean }, "not-found">> =>
  deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly linked: boolean }, "not-found">> => {
    const connection = await connectionOf(tx, input.organizationId, input.connectionId);
    if (connection === null) {
      return refuse("not-found", "No such connection");
    }
    if (connection.ownerAccountId === null || connection.ownerAccountId !== input.installation.accountId) {
      return { ok: true, linked: false };
    }
    const existing = await tx.codeHostInstallation.findUnique({
      where: { connectionId_installationId: { connectionId: input.connectionId, installationId: input.installation.installationId } },
      select: { state: true },
    });
    if (existing?.state === "linked") {
      return { ok: true, linked: true };
    }
    await upsertLinked(tx, input.organizationId, input.connectionId, input.installation, null, deps.clock.now());
    await deps.audit.recordInTx(tx, {
      organizationId: input.organizationId,
      projectId: null,
      actor: { kind: "system", id: null },
      action: installationAuditActions.linked,
      entity: "connection",
      entityId: input.connectionId,
      data: { installationId: input.installation.installationId, account: input.installation.accountLogin, own: true },
    });
    return { ok: true, linked: true };
  });

/** An organization admin links an installation of one of the organization's connections. */
export const linkInstallation = async (
  deps: InstallationDeps,
  scope: MemberScope,
  input: { readonly connectionId: ConnectionId; readonly installation: SeenInstallation },
): Promise<UseCaseResult<{ readonly linked: true }, "forbidden" | "not-found">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin links an installation");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly linked: true }, "forbidden" | "not-found">> => {
    // Another organization's connection, and so its installations, is not-found here.
    const connection = await connectionOf(tx, organizationId, input.connectionId);
    if (connection === null) {
      return refuse("not-found", "No such connection");
    }
    await upsertLinked(tx, organizationId, input.connectionId, input.installation, scope.memberId, deps.clock.now());
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: installationAuditActions.linked,
      entity: "connection",
      entityId: input.connectionId,
      data: { installationId: input.installation.installationId, account: input.installation.accountLogin, own: false },
    });
    return { ok: true, linked: true };
  });
};

const endInstallation = async (
  deps: InstallationDeps,
  scope: MemberScope,
  input: { readonly connectionId: ConnectionId; readonly installationId: string },
  action: "unlinked" | "removed",
  beforeCommit: (tx: Tx) => Promise<void>,
): Promise<UseCaseResult<{ readonly at: number }, "forbidden" | "not-found">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin unlinks or removes an installation");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly at: number }, "forbidden" | "not-found">> => {
    const row = await tx.codeHostInstallation.findFirst({
      where: { organizationId, connectionId: input.connectionId, installationId: input.installationId, state: "linked" },
      select: { id: true },
    });
    if (row === null) {
      return refuse("not-found", "No such linked installation");
    }
    const at = deps.clock.now();
    await tx.codeHostInstallation.update({ where: { id: row.id }, data: { state: "removed", removedAt: new Date(at), removedByMemberId: scope.memberId } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: action === "unlinked" ? installationAuditActions.unlinked : installationAuditActions.removed,
      entity: "connection",
      entityId: input.connectionId,
      data: { installationId: input.installationId },
    });
    await beforeCommit(tx);
    return { ok: true, at };
  });
};

/** Stops using an installation: no token, no repo, no delivery; its repos stop new tasks with the reason. */
export const unlinkInstallation = (
  deps: InstallationDeps,
  scope: MemberScope,
  input: { readonly connectionId: ConnectionId; readonly installationId: string },
): Promise<UseCaseResult<{ readonly at: number }, "forbidden" | "not-found">> => endInstallation(deps, scope, input, "unlinked", () => Promise.resolve());

/**
 * Unlinks it and uninstalls the App from that account (`CodeHostAdapter.removeInstallation`,
 * ticket 47), before the transaction commits: a failed uninstall leaves it linked.
 */
export const removeInstallation = (
  deps: InstallationDeps & { readonly uninstall: (installationId: string) => Promise<void> },
  scope: MemberScope,
  input: { readonly connectionId: ConnectionId; readonly installationId: string },
): Promise<UseCaseResult<{ readonly at: number }, "forbidden" | "not-found">> =>
  endInstallation(deps, scope, input, "removed", () => deps.uninstall(input.installationId));

/**
 * An App another GitHub account owns, connected beside the organization's own (F-136): its ID,
 * its owner, and the secret references the caller stored (the private key, and the webhook secret
 * ostra generated and showed once). Each connected App has its own webhook address: its row's ID.
 */
export const connectExistingApp = async (
  deps: InstallationDeps,
  scope: MemberScope,
  input: {
    readonly appId: string;
    readonly slug: string | null;
    readonly ownerLogin: string;
    readonly ownerAccountId: string;
    readonly botName: string | null;
    readonly botEmail: string | null;
    readonly privateKeySecretRef: string;
    readonly webhookSecretSecretRef: string;
  },
): Promise<UseCaseResult<{ readonly connectionId: ConnectionId }, "forbidden" | "already-connected">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin connects an App");
  }
  return deps.db.$transaction(async (tx): Promise<UseCaseResult<{ readonly connectionId: ConnectionId }, "forbidden" | "already-connected">> => {
    const existing = await tx.connection.findFirst({ where: { organizationId, kind: "github", appId: input.appId }, select: { id: true } });
    if (existing !== null) {
      return refuse("already-connected", "That App is connected already");
    }
    const created = await tx.connection.create({
      data: {
        organizationId,
        kind: "github",
        appId: input.appId,
        slug: input.slug,
        botName: input.botName,
        botEmail: input.botEmail,
        ownerLogin: input.ownerLogin,
        ownerAccountId: input.ownerAccountId,
        privateKeySecretRef: input.privateKeySecretRef,
        webhookSecretSecretRef: input.webhookSecretSecretRef,
        createdByMemberId: scope.memberId,
      },
      select: { id: true },
    });
    const connectionId = connectionIdSchema.parse(created.id);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: installationAuditActions.connectionAdded,
      entity: "connection",
      entityId: connectionId,
      data: { appId: input.appId, owner: input.ownerLogin },
    });
    return { ok: true, connectionId };
  });
};

/**
 * The lowest runner minor a task's spec needs (F-136, F-021): a task whose repos have different
 * bots needs minor 3, as milestone 3's profile features need minor 2. The dispatch offers it only
 * to such a runner, and waits with `needs-protocol` when none is online.
 */
export const requiredRunnerMinor = (spec: TaskSpec): number => {
  if (taskSpecNeedsMinor3(spec)) {
    return 3;
  }
  return taskSpecNeedsMinor2(spec) ? 2 : 0;
};
