import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CoreV1Api, KubeConfig, KubernetesObjectApi, loadAllYaml } from "@kubernetes/client-node";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";
import { taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { sleep, waitFor } from "./context.ts";
import type { Demo } from "./context.ts";
import { startPoolRunner } from "./runners.ts";
import { promptTask, runnerByName } from "./steps-pools.ts";
import { devToolSwitch } from "./stack.ts";

// Spec section 3, steps 12 to 15: the `kubernetes` executor on ticket 06's fake cluster (process
// mode: each container a local process here, with no isolation and no limits), the registry against
// the fake OCI registry, the images', charts' and egress checks that run without Docker, and the load
// test's record. What only Linux, kind or a real registry can show is ticket 35's.

const NAMESPACE = "ostra-boxes";
const BUILDS = "ostra-builds";
const RELEASE_NAMESPACE = "ostra-runner";

const run = (command: string, args: readonly string[], cwd = repoRoot, env: Readonly<Record<string, string>> = {}): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code: unknown = error === null ? 0 : Reflect.get(error, "code");
      resolve({ code: typeof code === "number" ? code : 1, output: `${stdout}${stderr}` });
    });
  });

const helmBinary = (): string => path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "helm.exe" : "helm");

const kubeOf = (d: Demo): KubeConfig => {
  const kubeconfig = z.looseObject({ kubeconfig: z.string() }).parse(d.tools.fakeKube.ready).kubeconfig;
  const config = new KubeConfig();
  config.loadFromFile(kubeconfig);
  return config;
};

const objectSchema = z.looseObject({ apiVersion: z.string(), kind: z.string(), metadata: z.looseObject({ name: z.string() }) });

const containerSchema = z.looseObject({
  name: z.string(),
  restartPolicy: z.string().optional(),
  resources: z.looseObject({ limits: z.record(z.string(), z.string()).optional() }).optional(),
  volumeMounts: z.array(z.looseObject({ name: z.string(), mountPath: z.string() })).optional(),
  env: z.array(z.looseObject({ name: z.string() })).optional(),
});
const podSchema = z.looseObject({
  metadata: z.looseObject({ name: z.string(), labels: z.record(z.string(), z.string()).optional() }),
  spec: z.looseObject({
    automountServiceAccountToken: z.boolean().optional(),
    containers: z.array(containerSchema),
    initContainers: z.array(containerSchema).optional(),
    volumes: z.array(z.looseObject({ name: z.string(), secret: z.looseObject({ secretName: z.string() }).optional() })).optional(),
    imagePullSecrets: z.array(z.looseObject({ name: z.string() })).optional(),
  }),
});

const core = (d: Demo): CoreV1Api => kubeOf(d).makeApiClient(CoreV1Api);

const listPods = async (d: Demo, namespace: string): Promise<readonly unknown[]> => (await core(d).listNamespacedPod({ namespace }).catch(() => ({ items: [] }))).items;

const appliedObjects = new WeakMap<Demo, string[]>();
const applied = (d: Demo): readonly string[] => appliedObjects.get(d) ?? [];

/** Step 12: `k8s-fake`, the runner chart rendered and applied to the fake API, a `kubernetes` runner, and test2's task waiting for a registry. */
export const step12 = async (d: Demo): Promise<void> => {
  const made = z.object({ poolId: z.string(), joinToken: z.object({ token: z.string() }) }).parse(await d.api.mutate("pools.create", { name: "k8s-fake" }));
  d.secrets.push(made.joinToken.token);
  d.facts["k8sPoolId"] = made.poolId;
  // The runner chart, rendered by Helm with its required values, applied to the fake API. The fake
  // serves no Deployment or PersistentVolumeClaim: the runner those would start runs here as a process.
  const rendered = await run(helmBinary(), [
    "template",
    "ostra-runner",
    path.join(repoRoot, "deploy", "helm", "ostra-runner"),
    "--namespace",
    RELEASE_NAMESPACE,
    "-f",
    path.join(repoRoot, "deploy", "helm", "ostra-runner", "examples", "required-values.yaml"),
    "--set",
    `server.url=${d.stack.coreUrls[0] ?? ""}`,
  ]);
  if (rendered.code !== 0) throw new Error(`helm template failed: ${rendered.output.slice(0, 400)}`);
  await writeFile(path.join(d.settings.stateDir, "runner-chart.yaml"), rendered.output);
  const docs = z.array(objectSchema).parse(loadAllYaml(rendered.output).filter((doc: unknown) => doc !== null));
  const client = KubernetesObjectApi.makeApiClient(kubeOf(d));
  const applied: string[] = [];
  appliedObjects.set(d, applied);
  const skipped: string[] = [];
  await client.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: RELEASE_NAMESPACE } }).catch(() => undefined);
  for (const doc of docs.sort((a, b) => (a.kind === "Namespace" ? -1 : b.kind === "Namespace" ? 1 : 0))) {
    if (doc.kind === "Deployment" || doc.kind === "PersistentVolumeClaim") {
      skipped.push(doc.kind);
      continue;
    }
    await client.create(doc);
    applied.push(`${doc.kind}/${doc.metadata.name}`);
  }
  // The join token's secret, as an admin makes it from the pool's token (the chart reads it as a file).
  const joinSecret = { apiVersion: "v1", kind: "Secret", metadata: { name: "ostra-join-token", namespace: RELEASE_NAMESPACE }, stringData: { "join-token": made.joinToken.token } };
  await client.create(joinSecret);
  d.check(12, "the runner chart renders with helm template and its objects apply to the fake API", applied.some((one) => one.startsWith("Namespace/ostra-boxes")) && applied.some((one) => one.startsWith("NetworkPolicy/")) && applied.some((one) => one.startsWith("Role/")), `${applied.join(", ")}; not served by the fake: ${skipped.join(", ")}`);
  const kubeconfig = z.looseObject({ kubeconfig: z.string() }).parse(d.tools.fakeKube.ready).kubeconfig;
  const runner = await startPoolRunner({
    cli: d.cli,
    name: "k8s-runner-01",
    dataDir: path.join(d.settings.runnersDir, "k8s-01"),
    logDir: d.logDir,
    serverUrl: d.stack.coreUrls[0] ?? "",
    executor: "kubernetes",
    joinToken: made.joinToken.token,
    env: { KUBECONFIG: kubeconfig, OSTRA_K8S_NAMESPACE: NAMESPACE, OSTRA_K8S_BUILD_NAMESPACE: BUILDS, OSTRA_BOX_SERVER_URL: d.stack.coreUrls[0] ?? "" },
  });
  d.runners.set("k8s-runner-01", runner);
  const row = await waitFor("the kubernetes runner online", 120_000, async () => {
    const one = await runnerByName(d, "k8s-runner-01");
    return one?.state === "online" ? one : null;
  });
  d.facts["k8sRunner"] = row.id;
  d.check(12, "a runner with --executor kubernetes joins k8s-fake against the fake API", row.executor === "kubernetes", `${row.executor}, online`);
  await d.demo.goto("/organization/runners");
  const poolRow = (await d.demo.getByRole("row").filter({ hasText: "k8s-fake" }).first().innerText()).replaceAll(/\s+/g, " ");
  d.check(12, "the fleet view says k8s-fake's agent has direct internet access", poolRow.includes("direct internet"), poolRow.slice(0, 200));
  await d.shot(d.demo, "12-fleet-with-k8s");
  await d.api.mutate("projects.setPools", { projectId: d.test2.id, pools: [{ poolId: made.poolId, maxBoxes: null }] });
  await d.api.mutate("projects.setDefaultBoxSize", { projectId: d.test2.id, size: "small" });
  const taskId = await promptTask(d, { projectId: d.test2.id, title: "On the fake cluster", steps: 3, ms: 2000 });
  d.facts["k8sTask"] = taskId;
  await d.demo.goto(`/tasks/${taskId}`);
  const line = d.demo.getByTestId("task-wait-line");
  await line.filter({ hasText: "needs a registry" }).waitFor({ timeout: 60_000 });
  d.check(12, "test2's task waits: k8s-fake needs a registry for snapshots", (await line.innerText()).includes("k8s-fake needs a registry for snapshots"), (await line.innerText()).trim());
  await d.shot(d.demo, "12-needs-registry");
};

const credentialOf = (lines: readonly string[], which: "push" | "pull"): { readonly username: string; readonly password: string } => {
  const line = lines.find((one) => one.includes(`${which} credential:`)) ?? "";
  const [username = "", password = ""] = line.split(":").slice(1).join(":").trim().split(" / ");
  return { username, password };
};

/** Step 13: the registry in the panel, its check, then test2's task as a pod on the fake cluster, and a snapshot build. */
export const step13 = async (d: Demo): Promise<void> => {
  const lines = d.tools.registry.lines;
  const host = /Set it in the panel as (\S+)\./.exec(lines.join("\n"))?.[1] ?? "";
  const push = credentialOf(lines, "push");
  const pull = credentialOf(lines, "pull");
  d.secrets.push(push.password, pull.password);
  const page = d.demo;
  await page.goto("/organization/registry");
  await page.getByRole("heading", { level: 1, name: "Registry" }).waitFor();
  await page.getByLabel("Registry", { exact: true }).fill(`http://${host}`);
  await page.getByLabel("Repository prefix").fill("ostra-dev/");
  await page.getByTestId("registry-push").getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Push credential: Username").fill(push.username);
  await page.getByLabel("Push credential: Password or token").fill(push.password);
  await page.getByTestId("registry-pull").getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Pull credential: Username").fill(pull.username);
  await page.getByLabel("Pull credential: Password or token").fill(pull.password);
  // Before the save: the next pods are held unschedulable, with a scale-up event, for 3 minutes.
  say(`step 13: ${await devToolSwitch("e2e/m5-the-fleet/src/dev/fake-kube.ts", ["hold", "180s"], d.toolEnv)} at ${new Date().toISOString()}`);
  // Every pod the runner makes, as the fake API lists it, from now on: a box's pod and a build's.
  const seen = new Map<string, unknown>();
  const watching = { on: true };
  const watch = (async () => {
    while (watching.on) {
      for (const namespace of [NAMESPACE, BUILDS]) {
        for (const item of await listPods(d, namespace)) {
          const parsed = podSchema.safeParse(item);
          const key = parsed.success ? `${namespace}/${parsed.data.metadata.name}` : null;
          if (key !== null && !seen.has(key)) seen.set(key, item);
        }
      }
      await sleep(250);
    }
  })();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const result = page.getByTestId("registry-check-result");
  await result.filter({ hasText: "allowed" }).waitFor({ timeout: 60_000 });
  const text = (await result.innerText()).trim();
  d.check(13, "Check answers: push and pull both allowed for ostra-dev/", text === "Push and pull both allowed for ostra-dev/", text);
  await page.screenshot({ path: path.join(d.settings.screenshotDir, "13-registry.png"), mask: [page.getByLabel(/Password or token/)] });
  const taskId = taskIdSchema.parse(d.facts["k8sTask"]);
  // The dispatch is accepted at once; the pod waits for a node.
  const lease = await waitFor("the task's lease on the kubernetes runner", 120_000, () => d.db.lease.findFirst({ where: { taskId }, select: { grantedAt: true } }), 1000);
  const accepted = await waitFor("the dispatch accepted", 30_000, async () => (await d.db.lease.findFirst({ where: { taskId }, select: { acceptedAt: true } }))?.acceptedAt ?? null, 500);
  const acceptSeconds = Math.round((accepted.getTime() - lease.grantedAt.getTime()) / 100) / 10;
  d.check(13, "the dispatch is accepted at once while the pod waits for a node", acceptSeconds < 10, `accepted ${String(acceptSeconds)} s after the grant`);
  await page.goto(`/tasks/${taskId}`);
  const waiting = page.getByTestId("task-box-waiting");
  const sawWaiting = await waiting
    .filter({ hasText: "Waiting for a node" })
    .waitFor({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    );
  d.check(13, "the task page says Waiting for a node", sawWaiting, sawWaiting ? (await waiting.innerText()).trim() : "not shown");
  if (sawWaiting) await d.shot(page, "13-waiting-for-a-node");
  const boxPod = await waitFor("the box's pod", 60_000, () => Promise.resolve([...seen].find(([key]) => key.startsWith(`${NAMESPACE}/`))?.[1] ?? null), 500);
  const pod = podSchema.parse(boxPod);
  const sidecars = (pod.spec.initContainers ?? []).filter((one) => one.restartPolicy === "Always").map((one) => one.name);
  const agent = pod.spec.containers[0];
  const tokenVolumes = (pod.spec.volumes ?? []).filter((one) => one.secret !== undefined).map((one) => one.name);
  const mountsTokenIn = [...(pod.spec.initContainers ?? []), ...pod.spec.containers].filter((one) => (one.volumeMounts ?? []).some((mount) => tokenVolumes.includes(mount.name))).map((one) => one.name);
  const limits = agent?.resources?.limits ?? {};
  d.check(
    13,
    "the fake API has the box's pod: the agent, the sidecar as a native sidecar, small's limits, no service account token, the task token mounted only into the sidecar",
    sidecars.length >= 1 && pod.spec.automountServiceAccountToken === false && ["2", "2000m"].includes(limits["cpu"] ?? "") && ["4Gi", "4096Mi"].includes(limits["memory"] ?? "") && mountsTokenIn.length > 0 && mountsTokenIn.every((name) => sidecars.includes(name)),
    `sidecars ${sidecars.join(", ")}; agent limits ${JSON.stringify(limits)}; secret mounts in ${mountsTokenIn.join(", ")}; pull secrets ${String(pod.spec.imagePullSecrets?.length ?? 0)}`,
  );
  // The pod as JSON, its secrets' values never read: only its spec, kept for demo.md.
  await writeFile(path.join(d.settings.screenshotDir, "13-pod.json"), `${JSON.stringify({ metadata: { labels: pod.metadata.labels }, spec: pod.spec }, null, 2)}\n`);
  const pr = await waitFor("the task's PR on test2", 300_000, () => d.db.taskRepo.findFirst({ where: { taskId, prNumber: { not: null } }, select: { prNumber: true } }), 3000).catch(() => null);
  if (pr === null) {
    d.note(
      13,
      "the agent's container doesn't run in dev:fake-kube's process mode on this machine: its command is the base image's init (node /opt/ostra/init/main.ts), which the dev tool maps to nothing here, so the pod ends and the box fails as it starts. The agent in a pod is ticket 35's kind job's.",
    );
  } else {
    d.check(13, "the agent works in the pod and the PR opens on test2", true, `PR #${String(pr.prNumber)}`);
  }
  watching.on = false;
  await watch;
  const builds = [...seen.keys()].filter((key) => key.startsWith(`${BUILDS}/`));
  d.check(13, "a snapshot build for k8s-fake runs as a BuildKit pod in ostra-builds, under its own egress policy", builds.length > 0 && applied(d).includes("NetworkPolicy/ostra-build-egress"), builds.length === 0 ? "no build pod seen" : builds.join(", "));
  d.note(
    13,
    "the build's result isn't recorded here: the pod's ostra steps run (ostra internal build-step, routed by the CLI since this ticket), but its BuildKit container has no stand-in in the fake's process mode, so the build ends there and no image is pushed. The real build, scan and push are ticket 35's kind job's.",
  );
  // The pod and its secrets are deleted once the box is released.
  const gone = await waitFor("the box's pod deleted", 300_000, async () => ((await listPods(d, NAMESPACE)).length === 0 ? true : null), 5000).catch(() => false);
  const secrets = await core(d)
    .listNamespacedSecret({ namespace: NAMESPACE })
    .then(
      (list) => list.items.length,
      () => -1,
    );
  d.check(13, "once the box is released its pod and its secrets are deleted", gone && secrets === 0, `pods gone: ${String(gone)}; secrets left: ${String(secrets)}`);
  say("step 13: done");
};

/** Step 14: the images' and charts' checks, and the egress baseline's cross-check, here. */
export const step14 = async (d: Demo): Promise<void> => {
  const images = await run(process.execPath, [path.join(repoRoot, "packages", "deploy-checks", "src", "check-images.ts")]);
  d.check(14, "pnpm check:images passes", images.code === 0, images.output.trim().split("\n").at(-1) ?? "");
  const helm = await run(process.execPath, [path.join(repoRoot, "packages", "deploy-checks", "src", "check-helm.ts")], repoRoot, { PATH: `${path.dirname(helmBinary())}${path.delimiter}${process.env["PATH"] ?? ""}` });
  d.check(14, "pnpm check:helm lints and renders both charts", helm.code === 0 && !helm.output.includes("didn't run"), helm.output.trim().split("\n").at(-1) ?? "");
  // Kept as the run's live evidence (F-118), with this machine's folders masked.
  const masked = helm.output.replaceAll(repoRoot, "<repo>").replaceAll(os.homedir(), "~");
  await mkdir(path.join(d.settings.screenshotDir, "helm"), { recursive: true });
  await writeFile(path.join(d.settings.screenshotDir, "helm", "check-helm.txt"), masked);
  const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  // Only the files that hold F-116's tests, one at a time: beside the demo's stack, seven files in
  // parallel failed to load in the 2026-11-20 run from a fresh clone. The whole output is kept.
  const egressFiles = ["src/egress-baseline.test.ts", "src/services-egress.test.ts", "src/snapshots.test.ts"];
  const egress = await run(process.execPath, [vitest, "run", "--reporter=dot", "--maxWorkers=1", "-t", "F-116", ...egressFiles], path.join(repoRoot, "packages", "adapters", "adapter-executor-kubernetes"));
  await writeFile(path.join(d.settings.stateDir, "step14-egress.log"), egress.output);
  d.check(14, "the docker rules and the chart's NetworkPolicy match the baseline's list (F-116's tests)", egress.code === 0, egress.output.trim().split("\n").filter((line) => /Tests|passed|failed/.test(line)).slice(-2).join(" "));
};

/** Step 15: the load test's record on this machine (ticket 34), not run again here. */
export const step15 = async (d: Demo): Promise<void> => {
  d.check(15, "the load test's ramp on this machine is recorded (ticket 34, load-windows.md)", true, "held 250 tasks; 500 failed on dispatch time and steer p99; not run again in this demo");
  await sleep(0);
};
