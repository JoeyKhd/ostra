import { boxIdSchema, previewKeySchema } from "@ostra/protocol";
import type { BoxId, OrganizationId, PreviewKey, ProjectId, RunnerId } from "@ostra/protocol";

import type { ApiHarness } from "./harness.ts";
import { seedPersonalRunner, seedTask } from "./world.ts";
import type { SeededTask } from "./world.ts";

// Milestone 8 (ticket 20): a task whose box can show a preview, as core leaves one once the runner
// took it: the environment's primary app process, a personal runner at protocol minor 7 that says
// it can show the browser view and the tunnel, a `ready` box on `host`, an active lease the runner
// accepted, and the task's session in that box.

export type PreviewableTask = SeededTask & {
  readonly boxId: BoxId;
  readonly runnerId: RunnerId;
  /** The primary app process's preview. */
  readonly key: PreviewKey;
};

let runners = 0;

export const seedPreviewableTask = async (
  harness: ApiHarness,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    /** Whose personal runner holds the box. */
    readonly ownerMemberId: string;
    readonly driverMemberId?: string;
    /** The runner's protocol minor: 7 by default. */
    readonly minor?: number;
  },
): Promise<PreviewableTask> => {
  const db = harness.test.db;
  const { organizationId, projectId } = input;
  const environment = await db.environment.upsert({ where: { projectId }, create: { organizationId, projectId }, update: {}, select: { id: true } });
  // The project's primary app process, or a frontend made for it.
  let primary = await db.appProcess.findFirst({ where: { environmentId: environment.id, primary: true }, select: { name: true } });
  if (primary === null) {
    const repo = await db.repo.findFirstOrThrow({ where: { projectId, organizationId }, select: { id: true } });
    primary = await db.appProcess.create({
      data: { organizationId, projectId, environmentId: environment.id, repoId: repo.id, name: "web", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
      select: { name: true },
    });
  }
  runners += 1;
  const runnerId = await seedPersonalRunner(harness, input.ownerMemberId, `preview-runner-${String(runners)}-${String(Date.now())}`);
  await db.runner.update({ where: { id: runnerId }, data: { minor: input.minor ?? 7, preview: { stream: true, tunnel: true } } });
  const task = await seedTask(harness, { organizationId, projectId, state: "running", driverMemberId: input.driverMemberId ?? input.ownerMemberId, creatorMemberId: input.driverMemberId ?? input.ownerMemberId });
  const box = await db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "host", state: "ready" }, select: { id: true } });
  await db.lease.create({ data: { organizationId, projectId, taskId: task.taskId, epoch: 1, runnerId, boxId: box.id, state: "active", acceptedAt: new Date() } });
  await db.session.update({ where: { id: task.sessionId }, data: { boxId: box.id } });
  await db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 1 } });
  return { ...task, boxId: boxIdSchema.parse(box.id), runnerId, key: previewKeySchema.parse(`app-${primary.name}`) };
};
