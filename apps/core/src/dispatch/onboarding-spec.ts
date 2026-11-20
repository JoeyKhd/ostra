import type { Db } from "@ostra/db";
import { ONBOARDING_COMMIT_PATHS, ONBOARDING_HOST_LINE, ONBOARDING_TOOLS } from "@ostra/domain";
import type { OstraToolSet } from "@ostra/protocol";

// Milestone 6's onboarding task in its spec (F-113, ADR 0038 amended; ticket 21): the sidecar serves
// `propose_environment` and the PR text, the runner commits only `AGENTS.md`, and the box starts from
// the base image (task-spec.ts leaves the snapshot out). On the `host` executor (ADR 0029) services
// aren't started, so the prompt says so; the agent may still name them in its proposal.

export type OnboardingSpecParts = {
  readonly tools: readonly OstraToolSet[];
  readonly commitPaths: readonly string[];
  /** The box is a `host` executor's: the prompt gains `ONBOARDING_HOST_LINE`. */
  readonly onHost: boolean;
};

export const specOnboardingParts = async (
  db: Db,
  task: { readonly organizationId: string },
  lease: { readonly boxId: string },
): Promise<OnboardingSpecParts> => {
  const box = await db.box.findFirst({ where: { id: lease.boxId, organizationId: task.organizationId }, select: { executor: true } });
  return { tools: ONBOARDING_TOOLS, commitPaths: ONBOARDING_COMMIT_PATHS, onHost: box?.executor === "host" };
};

/** An onboarding task's prompt, with the host's line when its box runs on the host. */
export const onboardingPromptOf = (prompt: string, onboarding: OnboardingSpecParts | null): string =>
  onboarding?.onHost === true ? `${prompt}\n\n${ONBOARDING_HOST_LINE}` : prompt;
