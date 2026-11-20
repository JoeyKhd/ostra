import type { CodeHostAdapter, CodeHostAppCredentials, Installation } from "@ostra/adapter-sdk";
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

/** The refusal for a repo of an installation ostra may not use: seen on GitHub, not linked. */
export const NOT_LINKED_MESSAGE = "This installation isn't linked";

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

// ---- ticket 49: the rule at every mint, and the installations ostra sees ----

/** The words a refusal carries when a repo's installation isn't linked, or was removed (F-136). */
export const INSTALLATION_NOT_LINKED = "the repo's GitHub installation isn't linked to ostra";

/** The `select` a repo query adds so its caller can ask `installationUsable` before any mint (F-136). */
export const installationStateSelect = { installation: { select: { state: true, removedAt: true } } } as const;

/** Whether an installation of a connection may be used now: its row, linked and not removed (F-136). */
export const installationUsableInTx = async (
  db: Db | Tx,
  input: { readonly organizationId: string; readonly connectionId: string; readonly installationId: string },
): Promise<boolean> => {
  const row = await db.codeHostInstallation.findFirst({
    where: { organizationId: input.organizationId, connectionId: input.connectionId, installationId: input.installationId },
    select: { state: true, removedAt: true },
  });
  return installationUsable(row);
};

/** The App's owner as a connection knows it; both `null` when ostra hasn't read it yet. */
export type KnownAppOwner = { readonly accountId: string | null; readonly login: string | null };

/** Whether an installation is on the App owner's own account: by the account's ID, else by its login. */
export const isOwnInstallation = (owner: KnownAppOwner, installation: { readonly accountId: string | null; readonly accountLogin: string }): boolean => {
  if (owner.accountId !== null && installation.accountId !== null) {
    return owner.accountId === installation.accountId;
  }
  return owner.login !== null && owner.login.toLowerCase() === installation.accountLogin.toLowerCase();
};

/**
 * An installation ostra just saw, in the caller's transaction (a listing, an `installation`
 * event, a project's repo): linked at once, by the system, when it's on the App owner's own
 * account and isn't linked yet. A removed one stays removed until an admin links it again.
 * Returns whether it's linked now.
 */
export const linkOwnInstallationInTx = async (
  deps: Pick<Ports, "audit" | "clock">,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly owner: KnownAppOwner; readonly installation: SeenInstallationRow },
): Promise<boolean> => {
  const existing = await tx.codeHostInstallation.findUnique({
    where: { connectionId_installationId: { connectionId: input.connectionId, installationId: input.installation.installationId } },
    select: { state: true, removedAt: true, accountId: true },
  });
  if (existing !== null) {
    if (existing.accountId === null && input.installation.accountId !== null) {
      // A row the upgrade made learns its account.
      await tx.codeHostInstallation.update({
        where: { connectionId_installationId: { connectionId: input.connectionId, installationId: input.installation.installationId } },
        data: { accountId: input.installation.accountId, accountLogin: input.installation.accountLogin, accountKind: input.installation.accountKind },
      });
    }
    return installationUsable(existing);
  }
  if (!isOwnInstallation(input.owner, input.installation)) {
    return false;
  }
  await tx.codeHostInstallation.create({
    data: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      installationId: input.installation.installationId,
      accountId: input.installation.accountId,
      accountLogin: input.installation.accountLogin,
      accountKind: input.installation.accountKind,
      state: "linked",
      linkedByMemberId: null,
      linkedAt: new Date(deps.clock.now()),
    },
  });
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "system", id: null },
    action: installationAuditActions.linked,
    entity: "connection",
    entityId: input.connectionId,
    data: { installationId: input.installation.installationId, account: input.installation.accountLogin, own: true },
  });
  return true;
};

/** An installation as a listing or an event names it; the account's ID may be unknown. */
export type SeenInstallationRow = {
  readonly installationId: string;
  readonly accountId: string | null;
  readonly accountLogin: string;
  readonly accountKind: "organization" | "user" | null;
};

/**
 * The App was uninstalled from an account (the host's `installation` `deleted` event): a linked
 * row is marked removed, by the system, with its audit entry. Nothing is minted for it after.
 */
export const installationGoneInTx = async (
  deps: Pick<Ports, "audit" | "clock">,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly installationId: string },
): Promise<boolean> => {
  const at = deps.clock.now();
  const changed = await tx.codeHostInstallation.updateMany({
    where: { organizationId: input.organizationId, connectionId: input.connectionId, installationId: input.installationId, state: "linked" },
    data: { state: "removed", removedAt: new Date(at), removedByMemberId: null },
  });
  if (changed.count === 0) {
    return false;
  }
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "system", id: null },
    action: installationAuditActions.removed,
    entity: "connection",
    entityId: input.connectionId,
    data: { installationId: input.installationId, uninstalled: true },
  });
  return true;
};

/**
 * The App's owner as ostra knows it (F-136): the connection's columns, else read once with the
 * App's own credentials (`readApp`, no installation token) and kept on the connection. Both
 * `null` when the host doesn't say.
 */
export const appOwnerInTx = async (
  tx: Tx,
  codeHost: Pick<CodeHostAdapter, "readApp">,
  app: CodeHostAppCredentials,
  connection: { readonly id: string; readonly organizationId: string; readonly ownerAccountId: string | null; readonly ownerLogin: string | null },
): Promise<KnownAppOwner> => {
  if (connection.ownerAccountId !== null || connection.ownerLogin !== null) {
    return { accountId: connection.ownerAccountId, login: connection.ownerLogin };
  }
  const read = await codeHost.readApp(app);
  const owner = read.ok ? read.value.owner : undefined;
  if (owner === undefined) {
    return { accountId: null, login: null };
  }
  await tx.connection.updateMany({ where: { id: connection.id, organizationId: connection.organizationId }, data: { ownerAccountId: owner.accountId, ownerLogin: owner.login } });
  return { accountId: owner.accountId, login: owner.login };
};

/** An installation as the code host lists it, in the shape the linking rule reads. */
export const seenInstallationOf = (installation: Installation): SeenInstallationRow => ({
  installationId: installation.installationId,
  accountId: installation.accountId ?? null,
  accountLogin: installation.accountLogin,
  accountKind: installation.accountKind,
});

/** An organization admin's link, in the caller's transaction, with its audit entry by the member. */
export const linkInstallationInTx = async (
  deps: Pick<Ports, "audit" | "clock">,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly installation: SeenInstallationRow; readonly memberId: MemberId },
): Promise<void> => {
  const data = {
    accountId: input.installation.accountId,
    accountLogin: input.installation.accountLogin,
    accountKind: input.installation.accountKind,
    state: "linked" as const,
    linkedByMemberId: input.memberId,
    linkedAt: new Date(deps.clock.now()),
    removedAt: null,
    removedByMemberId: null,
  };
  await tx.codeHostInstallation.upsert({
    where: { connectionId_installationId: { connectionId: input.connectionId, installationId: input.installation.installationId } },
    create: { organizationId: input.organizationId, connectionId: input.connectionId, installationId: input.installation.installationId, ...data },
    update: data,
  });
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "member", id: input.memberId },
    action: installationAuditActions.linked,
    entity: "connection",
    entityId: input.connectionId,
    data: { installationId: input.installation.installationId, account: input.installation.accountLogin, own: false },
  });
};
