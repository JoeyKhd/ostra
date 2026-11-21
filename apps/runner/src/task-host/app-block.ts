import type { LaunchApp } from "@ostra/adapter-sdk";
import { executorKindSchema } from "@ostra/protocol";
import type { ExecutorKind, TaskSpec, TaskSpecService } from "@ostra/protocol";

// The app's block in the agent's instructions (F-140, ADR 0068, milestone 8's ticket 14): what the
// launch tells the adapter about the app the box runs, from the task's spec. The adapter writes the
// block in the protocol's fixed words (`appInstructionsBlock`), beside the repos' `AGENTS.md`. A
// task whose environment has no app process gets none. Labels, names and ports only: a process's
// command and its log never reach it.

/**
 * A service's address in the box, by the executor (ADR 0068): by its name on `docker`'s box
 * network, at `localhost` in a `kubernetes` pod, whose containers share it. `host` runs no
 * services (ADR 0029, difference 1), and an executor ostra doesn't know reaches none.
 */
export const inBoxServiceAddress = (service: Pick<TaskSpecService, "name" | "port">, executor: ExecutorKind): string | null => {
  if (service.port === null) {
    return null;
  }
  switch (executor) {
    case "docker":
      return `http://${service.name}:${String(service.port)}`;
    case "kubernetes":
      return `http://localhost:${String(service.port)}`;
    case "host":
      return null;
    default:
      return executor satisfies never;
  }
};

/** The launch's app for a task (`PrepareLaunchInput.app`), on the executor named; `null` without an app process. */
export const launchAppOf = (spec: TaskSpec, executorName: string): LaunchApp | null => {
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
  };
};
