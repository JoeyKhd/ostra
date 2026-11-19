import os from "node:os";
import path from "node:path";

import { spawnChild } from "./procs.ts";
import type { Child } from "./procs.ts";

// A cloudflared quick tunnel to core's port, so Linear's webhooks reach this stack (ticket 38). The
// suite starts its own and ends it after the run. cloudflared is `~/.local/bin/cloudflared(.exe)`
// unless OSTRA_FS_CLOUDFLARED names it.

export type Tunnel = { readonly url: string; readonly child: Child };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const cloudflaredPath = (env: Readonly<Record<string, string | undefined>>): string =>
  env["OSTRA_FS_CLOUDFLARED"] ?? path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

/** Starts the tunnel to `localUrl` and answers its public address once cloudflared prints it. */
export const startTunnel = async (input: { readonly binary: string; readonly localUrl: string; readonly logFile: string }): Promise<Tunnel> => {
  const child = await spawnChild({
    name: "tunnel",
    command: input.binary,
    args: ["tunnel", "--no-autoupdate", "--url", input.localUrl],
    cwd: os.tmpdir(),
    env: process.env,
    logFile: input.logFile,
  });
  const line = await child.waitForLine((text) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(text), 90_000);
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];
  if (url === undefined) throw new Error("the tunnel printed no address");
  return { url, child };
};

/** Waits until the tunnel's public address reaches the service behind it (`probePath` answers 200). */
export const waitForTunnel = async (url: string, probePath: string, timeoutMs = 180_000): Promise<void> => {
  // A new quick tunnel's name takes a while to resolve everywhere.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await fetch(`${url}${probePath}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (answer?.status === 200) return;
    if (Date.now() > deadline) throw new Error("the tunnel's address never reached core");
    await sleep(2000);
  }
};
