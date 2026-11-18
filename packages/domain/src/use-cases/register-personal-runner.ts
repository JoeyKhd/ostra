import type { Tx } from "@ostra/db";
import { registerRequestSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, RegisterRequest, RegisterResponse } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-013, F-014, ADR 0029, Q115: a personal runner's first contact. It presents the member's device
// session; core creates a personal runner owned by that member, in the session's active
// organization, with the runner's own Ed25519 public key, and then revokes the session. The runner
// holds a runner key from then on, never a member's login. Written by ticket 24.

export const registerPersonalRunnerInputSchema = registerRequestSchema;
export type RegisterPersonalRunnerInput = RegisterRequest;

/** Who the device session belongs to, as better-auth resolved it. */
export type DeviceSessionOwner = {
  readonly sessionId: string;
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
  /** Revokes the device session once the runner exists (Q115). */
  readonly revokeSession: (sessionId: string) => Promise<void>;
};

export type RegisterPersonalRunner = (
  deps: RegisterPersonalRunnerDeps,
  input: RegisterPersonalRunnerInput,
) => Promise<RegisterPersonalRunnerResult>;

export const registerPersonalRunner: RegisterPersonalRunner = () => notImplemented("24");
