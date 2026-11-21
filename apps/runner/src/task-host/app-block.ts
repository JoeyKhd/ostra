import type { LaunchApp } from "@ostra/adapter-sdk";
import { executorKindSchema, inBoxServiceAddress } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";

// The app's block in the agent's instructions (F-140, ADR 0068, milestone 8's ticket 14): what the
// launch tells the adapter about the app the box runs, from the task's spec. The adapter writes the
// block in the protocol's fixed words (`appInstructionsBlock`), beside the repos' `AGENTS.md`. A
// task whose environment has no app process gets none. Labels, names and ports only: a process's
// command and its log never reach it.
//
// A service's address in the box is the protocol's rule (`inBoxServiceAddress`, ticket 12), the
// one the processes' `OSTRA_SERVICE_*_URL` variables use too: by its name on `docker`, at
// `localhost` on `kubernetes`, none on `host` (ADR 0029, difference 1).

export { inBoxServiceAddress };

/** A path as the agent reads it in words: `/` between its parts, which every shell and tool here takes. */
export const slashed = (folder: string): string => folder.replaceAll("\\", "/");

/**
 * The launch's app for a task (`PrepareLaunchInput.app`), on the executor named; `null` without an
 * app process. `logDir` is the box's `CreatedBox.appLogDir`, which the block names in full (ticket
 * 12): the agent works in a repo's checkout, below the task's folder that holds the logs.
 */
export const launchAppOf = (spec: TaskSpec, executorName: string, logDir: string | null = null): LaunchApp | null => {
  const processes = spec.environment.appProcesses ?? [];
  if (processes.length === 0) {
    return null;
  }
  const executor = executorKindSchema.safeParse(executorName);
  return {
    processes: processes.map((process) => ({ name: process.name, label: process.label, port: process.port, primary: process.primary })),
    services: (spec.services ?? []).flatMap((service) => {
      const address = executor.success ? inBoxServiceAddress(service, executor.data) : null;
      return address === null ? [] : [{ name: service.name, label: service.preview?.label ?? null, address }];
    }),
    ...(logDir === null ? {} : { logDir: slashed(logDir) }),
  };
};
