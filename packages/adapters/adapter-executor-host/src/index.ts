// @ostra/adapter-executor-host: the `host` executor (ADR 0029), a worktree per task on the
// runner's own machine, "personal, not isolated".
export { HostExecutor, coAuthorTrailer, commitMessageWithTrailers } from "./host-executor.ts";
export type { HostExecutorOptions } from "./host-executor.ts";
export {
  cgroupContainment,
  cgroupPrefix,
  detectContainment,
  jobObjectContainment,
  localMarkerSweep,
  markedInProc,
  markedInPs,
  newUnitMarker,
  ownCgroupPath,
  processTreeContainment,
  sweepLeftovers,
  TASK_UNIT_ENV,
} from "./containment.ts";
export type { AdoptOptions, Containment, ContainmentKind, ContainmentProbe, ContainmentUnit, MarkerSweep } from "./containment.ts";
export { loadJobObjects } from "./job-object.ts";
export type { JobHandle, JobObjects, JobObjectsLoad } from "./job-object.ts";
export { localProcesses } from "./task-processes.ts";
export type { StartAgentResult, StartedAgent, TaskProcesses } from "./task-processes.ts";
export { baseEnv, runProgram } from "./process.ts";
export type { RunOptions, RunResult } from "./process.ts";
