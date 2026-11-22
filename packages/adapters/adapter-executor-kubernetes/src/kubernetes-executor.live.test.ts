import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultAdapterContext } from "@ostra/adapter-sdk";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { createKubeApi, kubeConfigFromString } from "./kube-api.ts";
import type { KubeApi } from "./kube-api.ts";
import { KubernetesExecutor } from "./kubernetes-executor.ts";
import { boxNames, boxSelector } from "./pod.ts";

// F-093 (ADR 0029, milestone 5's ticket 35), live: a box as a pod with its service on a real
// cluster, made by the `kubernetes` executor as a pool runner makes it, in the runner chart's
// namespace with the chart's egress baseline, from images already on the node (a warm node: kind
// loaded the runner's and the base image, and the service's ran there already, so nothing is
// pulled). The box is ready once its sidecar is ready, the box's init has connected to the
// sidecar's bridge (so the box can run the agent's processes, as `docker`'s F-017/c4 counts it)
// and its service is healthy: under 60 s from the executor's create. Then it's released, and
// nothing of it is left. The sidecar and the service get half the runner's default limits, so a
// small node has room for them; a box with the defaults has more CPU and starts no slower.
//
// It runs where `OSTRA_TEST_KUBECONFIG` names a cluster's kubeconfig (scripts/live/kind.sh, on
// both of its kind clusters) and skips itself everywhere else, CI included.

const kubeconfig = process.env["OSTRA_TEST_KUBECONFIG"] ?? "";
const live = kubeconfig !== "";
const settings = {
  namespace: process.env["OSTRA_TEST_KUBE_NAMESPACE"] ?? "ostra-boxes",
  base: process.env["OSTRA_TEST_BASE_IMAGE"] ?? "",
  runner: process.env["OSTRA_TEST_RUNNER_IMAGE"] ?? "",
  /** A Postgres image the node has already: the box's service. */
  service: process.env["OSTRA_TEST_SERVICE_IMAGE"] ?? "",
  /** Where the sidecar would reach the server. Nothing needs it to answer: the box is ready before it calls. */
  serverUrl: process.env["OSTRA_TEST_BOX_SERVER_URL"] ?? "http://127.0.0.1:9",
};

/** F-093's working value. */
const READY_WITHIN_MS = 60_000;

const proxies: TaskProxies = { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };

/** How long after `from` the sidecar's log first says its bridge has the box's init; `null` by the deadline or once stopped. */
const bridgeConnected = async (kube: KubeApi, pod: string, from: number, deadline: number, stop: AbortSignal): Promise<number | null> => {
  while (Date.now() < deadline && !stop.aborted) {
    const log = await kube.podLog(settings.namespace, pod, "sidecar");
    if (log.ok && log.value.includes("bridge connected")) return Date.now() - from;
    await sleep(250);
  }
  return null;
};

describe.skipIf(!live)(`a box as a pod on a real cluster, live (skipped: ${live ? "no" : "no cluster (OSTRA_TEST_KUBECONFIG)"})`, () => {
  it("F-093/c4: a box is ready in under 60 s on a warm node: its pod made, its sidecar ready, the box's init connected to the sidecar's bridge and its service healthy, with no image pulled, and nothing left after its release", async (context) => {
    for (const [name, value] of Object.entries({ OSTRA_TEST_BASE_IMAGE: settings.base, OSTRA_TEST_RUNNER_IMAGE: settings.runner, OSTRA_TEST_SERVICE_IMAGE: settings.service })) {
      expect(value, `${name} names the image`).not.toBe("");
    }
    const kube = createKubeApi(kubeConfigFromString(await readFile(kubeconfig, "utf8")));
    const executor = new KubernetesExecutor(
      {
        kube,
        namespace: settings.namespace,
        images: { base: settings.base, runner: settings.runner },
        serverUrl: settings.serverUrl,
        sidecarLimits: { cpuMillis: 500, memoryMiB: 256 },
        serviceLimits: { cpuMillis: 500, memoryMiB: 512 },
        pollMs: 250,
      },
      defaultAdapterContext,
    );
    // The chart's namespace passes the runner's own start check: 1.29 or later, the rights, the baseline.
    expect(await executor.health()).toEqual({ status: "ok" });

    const spec: TaskSpec = {
      ...taskSpecFixture,
      services: [
        {
          name: "postgres",
          image: settings.service,
          port: 5432,
          variables: [
            { name: "POSTGRES_USER", value: "app" },
            { name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" },
          ],
          healthCheck: "pg_isready -h 127.0.0.1 -U app",
        },
      ],
    };
    const stamp = Date.now().toString(36);
    const box: BoxRef = { taskId: taskIdSchema.parse(`task-live-ready-${stamp}`), boxId: boxIdSchema.parse(`box-live-ready-${stamp}`) };
    const pod = boxNames(box).pod;
    const reading = new AbortController();
    const started = Date.now();
    try {
      const created = await executor.create({ ...box, spec, proxies });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const acceptedMs = Date.now() - started;
      // The sidecar's log is read while the executor waits, so its "bridge connected" is caught at once.
      const connected = bridgeConnected(kube, pod, started, started + 2 * READY_WITHIN_MS, reading.signal);
      const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
      const preparedMs = Date.now() - started;
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      expect(prepared.ok && prepared.value.services?.map((service) => [service.name, service.outcome])).toEqual([["postgres", "healthy"]]);
      const connectedMs = await connected;
      expect(connectedMs, "the box's init never connected to its sidecar's bridge").not.toBeNull();
      const readyMs = Math.max(preparedMs, connectedMs ?? Number.POSITIVE_INFINITY);
      await context.annotate(`accepted after ${String(acceptedMs)} ms; sidecar ready and service healthy after ${String(preparedMs)} ms; init connected after ${String(connectedMs)} ms`);
      expect(readyMs, `ready after ${String(readyMs)} ms`).toBeLessThan(READY_WITHIN_MS);
      // A warm node: every image of the pod was there already.
      const events = await kube.podEvents(settings.namespace, pod);
      expect(events.ok, "the pod's events can be read").toBe(true);
      expect(events.ok ? events.value.filter((event) => event.reason === "Pulling").map((event) => event.message) : [], "no image was pulled").toEqual([]);
    } finally {
      reading.abort();
      const released = await executor.release(box, "requested");
      expect(released.ok, JSON.stringify(released)).toBe(true);
    }
    const pods = await kube.listPods(settings.namespace, boxSelector(box));
    expect(pods.ok && pods.value.map((each) => each.name)).toEqual([]);
    const secrets = await kube.listSecretNames(settings.namespace, boxSelector(box));
    expect(secrets.ok && secrets.value).toEqual([]);
  }, 300_000);
});
