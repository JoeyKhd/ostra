import type { RunnerCapabilities } from "@ostra/protocol";
import type { Terminal } from "./cli/terminal.ts";
import type { CommandHandlers, ConnectionHooks } from "./connection/peer.ts";
import { updateStatus, updateStatusWith } from "./identity/store.ts";

// A pool runner's start (milestone 5, ticket 19, F-091): it joins with its pool's token, and in a
// pool that requires approval it's `joining` until an admin approves it. Each `welcome` says so
// (minor 4), and the approval reaches a connected runner as `resume`. Both land in status.json,
// which `ostra runner status` reads: "waiting for an admin to approve this runner in <pool>".

/** The `docker` executor's capabilities, as `DockerExecutor` declares them: a pool runner reports them for its boxes. */
export const DOCKER_CAPABILITIES: RunnerCapabilities = {
  isolation: "container",
  services: true,
  boxSizes: true,
  snapshots: "image",
  registry: "optional",
  nodeWait: false,
};

/** The welcome's pool, kept in status.json, and said once at the terminal while the runner waits. */
export const approvalHooks = (dataDir: string, terminal: Pick<Terminal, "say">, now: () => number = Date.now): Pick<ConnectionHooks, "onWelcome"> => {
  let said: boolean | null = null;
  return {
    onWelcome: (pool) => {
      if (pool === null) {
        return;
      }
      updateStatus(dataDir, { pool: { at: now(), name: pool.name, awaitingApproval: pool.awaitingApproval } }).catch(() => undefined);
      if (said !== pool.awaitingApproval) {
        said = pool.awaitingApproval;
        if (pool.awaitingApproval) {
          terminal.say(`Waiting for an admin to approve this runner in ${pool.name}. It takes no task until then.`);
        }
      }
    },
  };
};

/** `resume` also answers an approval: status.json stops saying the runner waits. */
export const withApprovalStatus = (handlers: CommandHandlers, dataDir: string, now: () => number = Date.now): CommandHandlers => ({
  ...handlers,
  resume: async (command) => {
    const outcome = await handlers.resume(command);
    await updateStatusWith(dataDir, (current) => {
      const pool = current.pool ?? null;
      return pool?.awaitingApproval === true ? { pool: { ...pool, at: now(), awaitingApproval: false } } : {};
    });
    return outcome;
  },
});

/** `ostra runner status`'s line for a pool runner, or `null` for a personal one (or before any welcome). */
export const poolStatusLine = (pool: { readonly name: string; readonly awaitingApproval: boolean } | null): string | null =>
  pool === null
    ? null
    : pool.awaitingApproval
      ? `Approval        waiting for an admin to approve this runner in ${pool.name}`
      : `Pool            ${pool.name} (approved)`;
