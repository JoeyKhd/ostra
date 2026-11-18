/**
 * What an executor can do (ADR 0025, ADR 0029). The differences between executors are these
 * declarations; `host` has the only allowed ones (no services, no box sizes, and on macOS weaker
 * process containment).
 */
export type ExecutorCapabilities = {
  /** `container`: the agent runs in a box with no credential. `none`: a worktree, "not isolated". */
  readonly isolation: "container" | "none";
  /** It starts an environment's services beside the agent (F-094). */
  readonly services: boolean;
  /** It honours box sizes (Q43); without them it counts slots only. */
  readonly boxSizes: boolean;
  /** It starts boxes from a prepared snapshot (F-051). */
  readonly snapshots: boolean;
  /**
   * How a task's processes end together (ADR 0029): with the box's container, a Windows job
   * object, a Linux cgroup, or only by walking the agent's process tree (which can miss a process
   * that detached itself).
   */
  readonly processContainment: "container" | "job-object" | "cgroup" | "process-tree";
};
