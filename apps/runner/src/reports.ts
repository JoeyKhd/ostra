import path from "node:path";
import type { ExecutorCapabilities } from "@ostra/adapter-sdk";
import { isReservedLabel, reservedLabelPrefixes } from "@ostra/protocol";
import type { RunnerCapabilities, RunnerConfig, RunnerInstall, RunnerLabel } from "@ostra/protocol";

// What a runner reports in `hello` and each `status` (milestone 5, ticket 19, spec section 4):
// its executor's capabilities, what it offers, its labels and how it was installed. Core keeps them
// on the runner's row and adds the built-in `executor:`, `os:` and `arch:` labels itself.

/** The image sets this (`deploy/Dockerfile.runner`): its tag is the pin, so it installs nothing. */
export const INSTALL_ENV = "OSTRA_INSTALL";

/**
 * How this runner was installed (ADR 0034, ADR 0046): `npm` when its program lies in a
 * `node_modules` folder (a global install, `npx`, or a version the pin installed), `image` when the
 * runner image says so, and `source` otherwise (a checkout, `pnpm dev`).
 */
export const detectInstall = (programPath: string, env: Readonly<Record<string, string | undefined>>): RunnerInstall => {
  if (programPath.split(/[\\/]/).includes("node_modules")) {
    return "npm";
  }
  return env[INSTALL_ENV] === "image" ? "image" : "source";
};

/** The program this process runs: `main.ts` from source, the bundle from npm. */
export const programPath = (): string => path.resolve(process.argv[1] ?? "");

/** An executor's capabilities as the protocol reports them: everything but its containment, which `status` carries apart. */
export const reportedCapabilities = (capabilities: ExecutorCapabilities): RunnerCapabilities => ({
  isolation: capabilities.isolation,
  services: capabilities.services,
  boxSizes: capabilities.boxSizes,
  snapshots: capabilities.snapshots,
  registry: capabilities.registry,
  nodeWait: capabilities.nodeWait,
});

/** A personal runner holds two tasks at once unless `OSTRA_RUNNER_SLOTS` says otherwise (ADR 0059, Q231). */
export const PERSONAL_SLOTS = 2;
/** A `host` pool runner's default. */
export const HOST_POOL_SLOTS = 2;

/**
 * How many tasks a `host` runner holds at once: `OSTRA_RUNNER_SLOTS`, then the older
 * `OSTRA_RUNNER_CAPACITY`, then two (personal or pool). `docker` and `kubernetes` read theirs from
 * the executor's offer.
 */
export const hostSlots = (config: Pick<RunnerConfig, "slots" | "capacity">): number => config.slots ?? config.capacity ?? PERSONAL_SLOTS;

/** The labels a runner may not set itself: ostra's own prefixes. */
export const reservedLabelsOf = (labels: readonly RunnerLabel[]): readonly RunnerLabel[] => labels.filter((label) => isReservedLabel(label));

/** The sentence `ostra runner` refuses to start with when `OSTRA_RUNNER_LABELS` names a reserved label. */
export const reservedLabelsMessage = (reserved: readonly RunnerLabel[]): string =>
  `${reserved.length === 1 ? "the label" : "the labels"} ${reserved.join(", ")} ${reserved.length === 1 ? "is" : "are"} reserved: ostra sets ${reservedLabelPrefixes.join(", ")} labels itself. Remove ${reserved.length === 1 ? "it" : "them"} from OSTRA_RUNNER_LABELS (--labels).`;
