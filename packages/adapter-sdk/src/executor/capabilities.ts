import type { ProcessContainment } from "@ostra/protocol";

/**
 * What an executor can do (ADR 0025, ADR 0029). The differences between executors are these
 * declarations; `host` has the only allowed ones (no services, no box sizes, and weaker process
 * containment wherever the machine gives no kernel unit, which the runner reports).
 */
export type ExecutorCapabilities = {
  /** `container`: the agent runs in a box with no credential. `none`: a worktree, "not isolated". */
  readonly isolation: "container" | "none";
  /** It starts an environment's services beside the agent (F-094). */
  readonly services: boolean;
  /** It honours box sizes (Q43); without them it counts slots only. */
  readonly boxSizes: boolean;
  /**
   * What a box can start from instead of a full setup (F-051, ADR 0038; milestone 3): a snapshot
   * image this runner built and keeps (`image`, `docker`), the project's repo mirrors and dependency
   * cache (`host-cache`, `host`), or nothing (`none`).
   */
  readonly snapshots: "image" | "host-cache" | "none";
  /**
   * How a task's processes end together (ADR 0029): with the box's container, a Windows job
   * object, a Linux cgroup, or only by walking the agent's process tree (which can miss a process
   * that detached itself).
   */
  readonly processContainment: ProcessContainment;
};
