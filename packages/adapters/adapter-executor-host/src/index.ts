// @ostra/adapter-executor-host: the `host` executor (ADR 0029), a worktree per task on the
// runner's own machine, "personal, not isolated".
export { HostExecutor, coAuthorTrailer, commitMessageWithTrailers } from "./host-executor.ts";
export type { HostExecutorOptions } from "./host-executor.ts";
export { cgroupContainment, detectContainment, ownCgroupPath, processTreeContainment } from "./containment.ts";
export type { Containment, ContainmentKind, ContainmentProbe, ContainmentUnit } from "./containment.ts";
export { localProcesses } from "./task-processes.ts";
export type { StartAgentResult, StartedAgent, TaskProcesses } from "./task-processes.ts";
export { baseEnv, runProgram } from "./process.ts";
export type { RunOptions, RunResult } from "./process.ts";
