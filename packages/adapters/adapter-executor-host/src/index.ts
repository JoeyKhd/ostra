// @ostra/adapter-executor-host: the `host` executor (ADR 0029), a worktree per task on the
// runner's own machine, "personal, not isolated".
export { HostExecutor, coAuthorTrailer, commitMessageWithTrailers } from "./host-executor.ts";
export type { HostAgentUserOptions, HostExecutorOptions, HostPoolOptions } from "./host-executor.ts";
export {
  agentUserMarkerSweep,
  agentUserProcesses,
  checkAgentUser,
  DEFAULT_SUDO,
  handOverToGroup,
  HOST_POOL_NO_USER_REASON,
  HOST_POOL_SAME_USER_PRODUCTION_REASON,
  HOST_POOL_WINDOWS_REASON,
  hostPoolAgentUser,
  SAME_USER_DEVELOPMENT,
  SAME_USER_ENV,
  sudoInvocation,
} from "./agent-user.ts";
export type { AgentUser, AgentUserCheck, HandOver, HostPoolSettings, RunCommand, SudoProgram } from "./agent-user.ts";
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
export { localProcesses, stopTree } from "./task-processes.ts";
export type { BrowserProcessResult, BrowserProgram, StartAgentResult, StartAppResult, StartedAgent, StartedApp, StartedBrowserProcess, TaskProcesses } from "./task-processes.ts";
export { baseEnv, runProgram } from "./process.ts";
export type { RunOptions, RunResult } from "./process.ts";
// Milestone 8 (ticket 11, F-121): the machine's browser, or the pinned headless shell.
export { machineBrowserCandidates, machineBrowserSource, resolveMachineBrowser } from "./machine-browser.ts";
export type { BrowserResolution, ResolveBrowserOptions } from "./machine-browser.ts";
export { ensureHeadlessShell, HEADLESS_SHELL_MAX_BYTES, HEADLESS_SHELL_PIN, headlessShellPlatform, headlessShellProgram, headlessShellUrl } from "./headless-shell.ts";
export type { EnsureHeadlessShellOptions, EnsureHeadlessShellResult, FetchZip, HeadlessShellPin, HeadlessShellPlatform } from "./headless-shell.ts";
export { extractZip, safeEntryPath } from "./zip-extract.ts";
export { agentUserBrowser, BROWSER_PIPE_CLOSE_FROM } from "./agent-user.ts";
export type { BrowserRunAs } from "./task-processes.ts";
