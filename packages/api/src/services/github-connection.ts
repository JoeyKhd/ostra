import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAppCredentials } from "@ostra/adapter-sdk";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";

import type { ApiDeps } from "../trpc/context.ts";
import type { MemberScope } from "@ostra/domain";

// A GitHub App as a router uses it: the connection row, and the App's private key read from the
// secret store for the one call that needs it. The key lives in a local variable for that call and
// goes nowhere else: no router returns it and no log carries it.
//
// Milestone 4 (F-136, ADR 0065, ticket 51): an organization may connect several Apps, so a caller
// names the one it means by its connection ID. `null` is the organization's own App: the first one
// it connected (a client's App connected beside it comes later), which milestone 1 to 3's
// procedures, made when there was one, still mean.

export type GitHubConnection = {
  readonly connectionId: ConnectionId;
  readonly slug: string | null;
  readonly ownerLogin: string | null;
  readonly ownerAccountId: string | null;
  readonly credentials: CodeHostAppCredentials;
};

/** The organization's GitHub connections, its own App first. */
export const githubConnectionsOf = (deps: Pick<ApiDeps, "db">, scope: MemberScope) =>
  deps.db.connection.findMany({ where: { organizationId: scope.organizationId, kind: "github" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

export const loadGitHubConnection = async (deps: ApiDeps, scope: MemberScope, connectionId: ConnectionId | null): Promise<GitHubConnection> => {
  const row =
    connectionId === null
      ? ((await githubConnectionsOf(deps, scope))[0] ?? null)
      : await deps.db.connection.findFirst({ where: { id: connectionId, organizationId: scope.organizationId, kind: "github" } });
  if (row === null) {
    throw connectionId === null
      ? new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect GitHub first" })
      : new TRPCError({ code: "NOT_FOUND", message: "No such GitHub App in this organization" });
  }
  const ref = secretRefSchema.safeParse(row.privateKeySecretRef);
  if (!ref.success) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The GitHub App's key reference is malformed" });
  }
  const key = await deps.ports.adapters.secretStore.get(scope.organizationId, ref.data);
  if (!key.ok) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The GitHub App's private key could not be read from the secret store" });
  }
  return {
    connectionId: connectionIdSchema.parse(row.id),
    slug: row.slug,
    ownerLogin: row.ownerLogin,
    ownerAccountId: row.ownerAccountId,
    credentials: { appId: row.appId, privateKey: key.value },
  };
};
