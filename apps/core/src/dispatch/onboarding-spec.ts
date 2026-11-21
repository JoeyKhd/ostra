import type { Db } from "@ostra/db";
import { DRAFT_APP_PROCESS_BLOCK, ONBOARDING_COMMIT_PATHS, ONBOARDING_HOST_LINE, ONBOARDING_NO_APP_TOOLS_LINE, ONBOARDING_TOOLS } from "@ostra/domain";
import type { OstraToolSet } from "@ostra/protocol";

// Milestone 6's onboarding task in its spec (F-113, ADR 0038 amended; ticket 21): the sidecar serves
// `propose_environment` and the PR text, the runner commits only `AGENTS.md`, and the box starts from
// the base image (task-spec.ts leaves the snapshot out). On the `host` executor (ADR 0029) services
// aren't started, so the prompt says so; the agent may still name them in its proposal. Milestone 8
// (F-140): the app tools join them for a minor-7 runner (`app-spec.ts`); without them, the prompt
// says to leave the app's processes out.

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

/**
 * An onboarding task's prompt, with the host's line when its box runs on the host, and milestone
 * 8's line when it names app processes but the box serves no app tools (a runner below minor 7, or
 * an agent that can't reach ostra's tools): it leaves them out of its proposal.
 */
export const onboardingPromptOf = (prompt: string, onboarding: OnboardingSpecParts | null, appTools = false): string => {
  if (onboarding === null) {
    return prompt;
  }
  const namesProcesses = prompt.includes(`label="${DRAFT_APP_PROCESS_BLOCK}"`);
  return [prompt, ...(onboarding.onHost ? [ONBOARDING_HOST_LINE] : []), ...(namesProcesses && !appTools ? [ONBOARDING_NO_APP_TOOLS_LINE] : [])].join("\n\n");
};
