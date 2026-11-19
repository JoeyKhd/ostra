import type { Tx } from "@ostra/db";
import { registerRequestSchema, runnerIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, RegisterRequest, RegisterResponse } from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// F-013, F-014, ADR 0029, Q115: a personal runner's first contact. It presents the member's device
// session; core creates a personal runner owned by that member, in the session's active
// organization, with the runner's own Ed25519 public key, and then revokes the session. The runner
// holds a runner key from then on, never a member's login. Written by ticket 24.

export const registerPersonalRunnerInputSchema = registerRequestSchema;
export type RegisterPersonalRunnerInput = RegisterRequest;

/** The ID of a device session: the row better-auth keeps for it, which core revokes (not an ostra record). */
export const deviceSessionIdSchema = z.string().min(1).regex(/^\S+$/, "an ID has no whitespace").brand<"DeviceSessionId">();
export type DeviceSessionId = z.infer<typeof deviceSessionIdSchema>;

/** Who the device session belongs to, as better-auth resolved it. */
export type DeviceSessionOwner = {
  readonly sessionId: DeviceSessionId;
  readonly memberId: MemberId;
  readonly organizationId: OrganizationId;
};

export type RegisterPersonalRunnerResult = UseCaseResult<
  RegisterResponse,
  "no-session" | "join-token-not-allowed" | "public-key-taken" | "executor-not-allowed"
>;

export type RegisterPersonalRunnerDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly owner: DeviceSessionOwner;
  /**
   * Revokes the device session in the caller's transaction (Q115): `false` when it was gone
   * already, revoked by a register that raced this one.
   */
  readonly revokeSession: (sessionId: DeviceSessionId) => Promise<boolean>;
};

export type RegisterPersonalRunner = (
  deps: RegisterPersonalRunnerDeps,
  input: RegisterPersonalRunnerInput,
) => Promise<RegisterPersonalRunnerResult>;

const refuse = (error: Exclude<RegisterPersonalRunnerResult, { readonly ok: true }>["error"], message: string) =>
  ({ ok: false, error, message }) as const;

export const registerPersonalRunner: RegisterPersonalRunner = async (deps, input) => {
  if (input.joinToken !== undefined) {
    return refuse("join-token-not-allowed", "a personal runner registers with a device session, not a join token");
  }
  // A personal runner runs tasks on the member's own machine: `host` or `docker`, never a cluster.
  if (input.executor === "kubernetes") {
    return refuse("executor-not-allowed", "a personal runner uses the host or docker executor");
  }
  const taken = await deps.tx.runner.findUnique({ where: { publicKey: input.publicKey }, select: { id: true } });
  if (taken !== null) {
    return refuse("public-key-taken", "a runner with this key exists; make a new key pair");
  }
  const { owner } = deps;
  // The device session is a full member session for about a week: it's used once, then revoked
  // (Q115, spike 9). It goes first, so of two registers racing with it only the one that revokes
  // it makes a runner: the other waits on its row, finds it gone, and makes nothing. If making the
  // runner fails, the transaction puts the session back. From here on the runner holds its own key.
  if (!(await deps.revokeSession(owner.sessionId))) {
    return refuse("no-session", "the device session was used already; sign in again");
  }
  const runner = await deps.tx.runner.create({
    data: {
      organizationId: owner.organizationId,
      kind: "personal",
      ownerMemberId: owner.memberId,
      name: input.name,
      publicKey: input.publicKey,
      executor: input.executor,
      capacity: input.capacity,
      labels: [...input.labels],
      version: input.version,
      os: { platform: input.os.platform, arch: input.os.arch, release: input.os.release },
      // Accepted at once (a personal runner needs no admin's approval), online once it connects.
      state: "joining",
    },
    select: { id: true },
  });
  const runnerId = runnerIdSchema.parse(runner.id);
  await deps.audit.recordInTx(deps.tx, {
    organizationId: owner.organizationId,
    projectId: null,
    actor: { kind: "member", id: owner.memberId },
    action: "runner.registered",
    entity: "runner",
    entityId: runnerId,
    data: { kind: "personal", executor: input.executor, capacity: input.capacity },
  });
  await deps.notices.emitInTx(deps.tx, {
    organizationId: owner.organizationId,
    projectId: null,
    entity: "runner",
    entityId: runnerId,
  });
  return { ok: true, runnerId, kind: "personal", poolId: null };
};
