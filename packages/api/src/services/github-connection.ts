import { secretRefSchema } from "@ostra/adapter-sdk";
import type { CodeHostAppCredentials } from "@ostra/adapter-sdk";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";

import type { ApiDeps } from "../trpc/context.ts";
import type { MemberScope } from "@ostra/domain";

// The organization's GitHub App as a router uses it: the connection row, and the App's private key
// read from the secret store for the one call that needs it. The key lives in a local variable for
// that call and goes nowhere else: no router returns it and no log carries it.

export type GitHubConnection = {
  readonly connectionId: ConnectionId;
  readonly slug: string | null;
  readonly credentials: CodeHostAppCredentials;
};

export const loadGitHubConnection = async (deps: ApiDeps, scope: MemberScope): Promise<GitHubConnection> => {
  const row = await deps.db.connection.findFirst({ where: { organizationId: scope.organizationId, kind: "github" } });
  if (row === null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect GitHub first" });
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
    credentials: { appId: row.appId, privateKey: key.value },
  };
};
