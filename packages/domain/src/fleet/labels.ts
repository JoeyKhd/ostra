import { isReservedLabel } from "@ostra/protocol";
import type { ExecutorKind } from "@ostra/protocol";

// Labels (F-069, ADR 0059). A runner's labels come from `OSTRA_RUNNER_LABELS`, plus the built-in
// `executor:<kind>`, `os:<platform>` and `arch:<arch>` that only ostra sets. A profile names the
// labels its tasks need, and a runner fits when it carries every one, compared exactly: no
// expressions, no "not", no weights.

/** Whether a runner's labels carry every label a task needs: an exact subset. */
export const labelsMatch = (required: readonly string[], carried: readonly string[]): boolean => {
  const have = new Set(carried);
  return required.every((label) => have.has(label));
};

/** The labels a task needs that a runner doesn't carry. */
export const missingLabels = (required: readonly string[], carried: readonly string[]): readonly string[] => {
  const have = new Set(carried);
  return required.filter((label) => !have.has(label));
};

/** What core knows of a runner's system, from its `hello`. */
export type RunnerPlatform = {
  readonly executor: ExecutorKind;
  /** Node's `process.platform`, such as `linux`, `darwin` or `win32`; `null` when not known. */
  readonly os: string | null;
  /** Node's `process.arch`, such as `x64` or `arm64`; `null` when not known. */
  readonly arch: string | null;
};

/** The built-in labels core adds from what a runner reports. */
export const builtInLabels = (platform: RunnerPlatform): readonly string[] => [
  `executor:${platform.executor}`,
  ...(platform.os === null ? [] : [`os:${platform.os}`]),
  ...(platform.arch === null ? [] : [`arch:${platform.arch}`]),
];

/**
 * A runner's stored labels: the ones it set, less any reserved one it tried to set itself (which
 * `dropped` names, for core's log line), plus the built-in ones. Sorted, without duplicates.
 */
export const runnerLabels = (
  reported: readonly string[],
  platform: RunnerPlatform,
): { readonly labels: readonly string[]; readonly dropped: readonly string[] } => {
  const dropped = reported.filter(isReservedLabel);
  const own = reported.filter((label) => !isReservedLabel(label));
  return { labels: [...new Set([...own, ...builtInLabels(platform)])].sort(), dropped };
};
