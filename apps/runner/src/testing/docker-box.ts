import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_FEATURES, DockerExecutor, listenForInit } from "@ostra/adapter-executor-docker";
import { killTree, silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { sidecarAppReach } from "../run-sidecar.ts";

// The `docker` executor as a box's sidecar drives it (ADR 0029, ticket 22), for the runner's tests:
// `DockerExecutor` on a task volume, its processes through the real bridge to the box's init, which
// runs as a child of the test instead of a container's PID 1 (as the executor's contract test does
// it). The box's containers and volume come from the pool runner on the Engine API; a test that
// needs them uses the fake engine (`@ostra/adapter-executor-docker/testing`).
//
// Milestone 8 (ticket 12): the init gets the bridge's features as the pool runner sets them
// (`OSTRA_BRIDGE_FEATURES`), so it runs the app's processes and forwards; and a pod's sidecar is the
// same executor reaching the app at the pod's `localhost` (`appReach: "loopback"`), as
// `run-sidecar.ts` builds it in a `kubernetes` box: `startLocalPodBox`.

const INIT = fileURLToPath(new URL("./init/main.ts", import.meta.resolve("@ostra/adapter-executor-docker")));

export type LocalDockerBox = {
  readonly executor: DockerExecutor;
  readonly kind: "docker" | "kubernetes";
  readonly dispose: () => Promise<void>;
};

const startLocalBox = async (input: { readonly dataDir: string; readonly logger: Logger }, kind: LocalDockerBox["kind"]): Promise<LocalDockerBox> => {
  const boxId = boxIdSchema.parse(`local-box-${randomBytes(4).toString("hex")}`);
  const nonce = randomBytes(32).toString("base64url");
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  const init: ChildProcess = spawn(process.execPath, [INIT], {
    env: {
      ...process.env,
      OSTRA_BOX_ID: boxId,
      OSTRA_BRIDGE_NONCE: nonce,
      OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}`,
      OSTRA_BRIDGE_FEATURES: BRIDGE_FEATURES.join(","),
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const bridge = await listener.connected;
  return {
    executor: new DockerExecutor(
      { taskRoot: path.join(input.dataDir, "task"), bridge, appReach: sidecarAppReach(kind) },
      { logger: input.logger, clock: { now: () => Date.now() } },
    ),
    kind,
    dispose: async () => {
      bridge.close();
      if (init.pid !== undefined && init.exitCode === null && init.signalCode === null) {
        await killTree(init.pid);
      }
    },
  };
};

/** A `docker` box's sidecar side: the executor on `<dataDir>/task`, with an init of its own, reaching the app through its forwarder. */
export const startLocalDockerBox = (input: { readonly dataDir: string; readonly logger: Logger }): Promise<LocalDockerBox> => startLocalBox(input, "docker");

/** A `kubernetes` box's sidecar side: the same, reaching the app at the pod's `localhost`, as `run-sidecar.ts` builds it in a pod. */
export const startLocalPodBox = (input: { readonly dataDir: string; readonly logger: Logger }): Promise<LocalDockerBox> => startLocalBox(input, "kubernetes");
