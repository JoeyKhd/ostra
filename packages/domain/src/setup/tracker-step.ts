import type { DbEnum, Tx } from "@ostra/db";
import type { OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { trackerKinds } from "../use-cases/tracker-connections.ts";

// Home's setup step "Connect a tracker" (F-076, F-152/c7; milestone 11, ADR 0071). It replaced the
// Linear step: done once any tracker connection of either kind is active, `pending` or `failed`
// while the newest one stands so, otherwise open, or skipped when an admin set it aside. An
// organization that skipped the Linear step stays skipped: the migration copied `linearSkippedAt`
// into `trackerSkippedAt`, and both are read and written until the release after milestone 11.

/** Where the step stands: `pending` and `failed` say how the newest connection stands. */
export const trackerSetupStepStates = ["done", "pending", "failed", "skipped", "open"] as const;
export type TrackerSetupStepState = (typeof trackerSetupStepStates)[number];

export type TrackerSetupStepInput = {
  /** The organization's tracker connections that aren't revoked, with when each was made. */
  readonly connections: readonly { readonly state: DbEnum.ConnectionState; readonly createdAt: number }[];
  readonly trackerSkippedAt: number | null;
  /** Milestone 2's column, still read: an organization that skipped the Linear step stays skipped. */
  readonly linearSkippedAt: number | null;
};

/** The step's state from the connections and the skip (pure). */
export const trackerSetupStepOf = (input: TrackerSetupStepInput): TrackerSetupStepState => {
  const live = input.connections.filter((connection) => connection.state !== "revoked");
  if (live.some((connection) => connection.state === "active")) {
    return "done";
  }
  const newest = [...live].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newest !== undefined) {
    switch (newest.state) {
      case "pending":
        return "pending";
      case "failed":
        return "failed";
      case "active":
      case "revoked":
        break;
      default:
        return newest.state satisfies never;
    }
  }
  return input.trackerSkippedAt !== null || input.linearSkippedAt !== null ? "skipped" : "open";
};

/** The organization's step, read from its connections and its setting. */
export const trackerSetupStepInTx = async (tx: Pick<Tx, "connection" | "organizationSetting">, organizationId: OrganizationId): Promise<TrackerSetupStepState> => {
  const [connections, setting] = await Promise.all([
    tx.connection.findMany({ where: { organizationId, kind: { in: [...trackerKinds] }, state: { not: "revoked" } }, select: { state: true, createdAt: true } }),
    tx.organizationSetting.findUnique({ where: { organizationId }, select: { trackerSkippedAt: true, linearSkippedAt: true } }),
  ]);
  return trackerSetupStepOf({
    connections: connections.map((connection) => ({ state: connection.state, createdAt: connection.createdAt.getTime() })),
    trackerSkippedAt: setting?.trackerSkippedAt?.getTime() ?? null,
    linearSkippedAt: setting?.linearSkippedAt?.getTime() ?? null,
  });
};

// ---------- "Skip for now" ----------

/**
 * The step an admin sets aside: `tracker`, or `linear`, the panel's word for it until its checklist
 * says "Connect a tracker" (milestone 11's ticket 16). Both mean the same step.
 */
export const skipSetupStepInputSchema = z.strictObject({ step: z.enum(["tracker", "linear"]) });
export type SkipSetupStepInput = z.infer<typeof skipSetupStepInputSchema>;

export type SkipSetupStepResult = UseCaseResult<{ readonly skippedAt: number }, "forbidden">;

export type SkipSetupStep = (
  deps: Pick<Ports, "audit" | "clock" | "notices"> & { readonly tx: Tx; readonly scope: MemberScope },
  input: SkipSetupStepInput,
) => Promise<SkipSetupStepResult>;

/**
 * Home's checklist: the admin sets the tracker step aside. It writes `trackerSkippedAt` and, until
 * the release after milestone 11, `linearSkippedAt` beside it. An active connection still makes it done.
 */
export const skipSetupStep: SkipSetupStep = async (deps) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an organization admin changes the setup checklist" };
  }
  const skippedAt = deps.clock.now();
  const skipped = { trackerSkippedAt: new Date(skippedAt), linearSkippedAt: new Date(skippedAt), linearSkippedByMemberId: scope.memberId };
  await tx.organizationSetting.upsert({ where: { organizationId }, create: { organizationId, ...skipped }, update: skipped });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "setup.step-skipped",
    entity: "organization",
    entityId: organizationId,
    data: { step: "tracker" },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
  return { ok: true, skippedAt };
};
