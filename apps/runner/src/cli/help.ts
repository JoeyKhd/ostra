import { runnerConfigFields } from "@ostra/protocol";
import { RUNNER_VERSION } from "../version.ts";

export const helpText = (): string => {
  const flags = Object.values(runnerConfigFields)
    .map((field) => `  --${field.flag.padEnd(12)} ${field.env.padEnd(24)} ${field.description}`)
    .join("\n");
  return [
    `ostra ${RUNNER_VERSION}`,
    "",
    "Usage:",
    "  ostra runner [flags]         Start a runner: sign in the first time, then take tasks",
    "  ostra runner status [flags]  Show the runner's ID, server, version window and last refusal",
    "  ostra login [--server <url>] Sign in as yourself, with a code you approve in the browser",
    "  ostra checkout <task> [--dir <folder>]",
    "                               Put a task's branches in your own clones (ticket key, task ID or URL)",
    "  ostra logout                 Sign out, and revoke the CLI session on the server",
    "  ostra --version",
    "",
    "Runner flags (each also an environment variable; a flag wins):",
    flags,
    "  --verbose                                   Print debug lines too",
  ].join("\n");
};
