import { linkRelatedPullRequests } from "@ostra/domain";
import type { LinkRelatedDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// The "Related" sections of a task's PRs (F-098, ADR 0027 amended; milestone 4's ticket 17):
// `pr.link-related`, keyed by the task and the PR that opened, edits every open PR of the task so
// each lists the others, keeping the rest of its body. A code host failure throws, and the queue
// retries; a replay finds each section already right and writes nothing.

export const linkRelatedHandler =
  (deps: Omit<LinkRelatedDeps, "logger">): JobHandler<"pr.link-related"> =>
  async (context) => {
    const result = await linkRelatedPullRequests({ ...deps, logger: context.logger }, { organizationId: context.payload.organizationId, taskId: context.payload.taskId });
    context.logger.info("pr.link-related", { taskId: context.payload.taskId, repoId: context.payload.repoId, prNumber: context.payload.prNumber, updated: result.updated });
  };
