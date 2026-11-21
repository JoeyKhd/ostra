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
  /**
   * Milestone 5 (ADR 0060, F-120): whether a box needs its image from the organization's registry
   * (`required`, `kubernetes`, whose kubelets pull), can take one (`optional`, `docker`, which also
   * builds and keeps its own snapshot without one), or never does (`none`, `host`).
   */
  readonly registry: "required" | "optional" | "none";
  /**
   * Milestone 5 (F-093): a box can wait for the cluster to grow a node before it's scheduled, and
   * says so through `create`'s `onWaiting` (`kubernetes`).
   */
  readonly nodeWait: boolean;
  /**
   * Milestone 8 (ADR 0068, F-121): where the box's browser comes from: the box's image, Chromium in
   * the agent's container (`docker`, `kubernetes`), or the machine's own Chromium-family browser
   * (`host`). Neither is an allowed difference (ADR 0029): the task does the same with either, and
   * each picture names the browser that took it.
   */
  readonly boxBrowser: "image" | "machine";
  /**
   * Milestone 8 (ADR 0068, F-141, F-143): how the runner reaches an app's port: through the init's
   * forwarder, since the agent's container has a loopback of its own (`docker`), or at `localhost`,
   * the pod's or the machine's, over IPv6 and IPv4 (`kubernetes`, `host`; spike 08).
   */
  readonly appReach: "forwarder" | "loopback";
};
