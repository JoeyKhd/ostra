import type { RunSidecar } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";

// `ostra sidecar`: the task host inside a `docker` box's sidecar container (ticket 22).
export const runSidecarCommand: RunSidecar = ({ terminal }) => {
  terminal.warn("ostra sidecar runs inside a docker box's sidecar container, which the docker executor starts (ticket 22).");
  return Promise.resolve(exitCodes.usage);
};
