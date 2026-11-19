import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultAdapterContext } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { startFakeOciRegistry } from "@ostra/adapter-sdk/testing/net";
import type { FakeOciRegistry } from "@ostra/adapter-sdk/testing/net";
import { projectIdSchema, repoIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema } from "@ostra/protocol";
import type { SnapshotBuildEnvironment, SnapshotCredentials } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildEgressPolicy, BUILD_ROLE } from "./egress.ts";
import { KubernetesExecutor } from "./kubernetes-executor.ts";
import { BUILDKIT_SWITCHES_OFF, buildObjects } from "./snapshots.ts";
import type { BuildSettings } from "./snapshots.ts";
import { startFakeCluster } from "./testing/cluster.ts";
import type { FakeCluster } from "./testing/cluster.ts";
import { arrayOf, recordOf } from "./testing/surface.ts";

// Ticket 08: a snapshot on `kubernetes` (F-120, F-051's `kubernetes` half). The build pod's shape is
// read as a typed value; the build itself runs on ticket 06's fake cluster in its process mode: the
// pod's steps are this package's own build steps (`build-main.ts`), BuildKit is a stand-in that
// exports an OCI tarball of the context, and the push goes to ticket 06's fake registry with the
// push credential. Rootless BuildKit itself, on kind, is ticket 35's live run.

const BOXES = "ostra-boxes";
const BUILDS = "ostra-boxes-builds";
const BUILD_MAIN = fileURLToPath(new URL("./build-main.ts", import.meta.url));
const FAKE_BUILDKIT = fileURLToPath(new URL("./testing/fake-buildkit.ts", import.meta.url));
const API_TOKEN = "sk-setup-secret-k8s-0123456789abcdef";
const GIT_TOKEN = "ghs_k8sSnapshotToken0123456789abcdefXYZ";
const snapshotId = snapshotIdSchema.parse("snap-k8s-1");
const projectId = projectIdSchema.parse("project-a");
const web = repoIdSchema.parse("repo-web");

const environment = (cloneUrl: string, setupScript: string): SnapshotBuildEnvironment => ({
  baseImage: "node:24-bookworm",
  setupScript,
  repos: [
    {
      repoId: web,
      fullName: "ostra-test/test1",
      cloneUrl,
      defaultBranch: "main",
      checkoutDir: "test1",
      variables: [],
      files: [{ path: "config/app.json", content: '{ "plain": true }\n' }],
      envFile: ".env",
      setupSecrets: { variables: ["API_TOKEN"], files: [] },
    },
  ],
  inputsHash: sha256HexSchema.parse("b".repeat(64)),
});
const credentials: SnapshotCredentials = snapshotCredentialsSchema.parse({
  snapshotId,
  repos: [{ repoId: web, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 }],
  secrets: [{ repoId: web, entries: [{ kind: "variable", name: "API_TOKEN", value: API_TOKEN, availableDuringSetup: true }] }],
});

const settings: BuildSettings = {
  namespace: BUILDS,
  runnerImage: "ghcr.io/ostra/runner:1.0.0",
  buildkitImage: "moby/buildkit:v0.35.0-rootless",
  switches: BUILDKIT_SWITCHES_OFF,
  limits: { cpuMillis: 4000, memoryMiB: 4096 },
  stepCommand: ["ostra", "internal", "build-step"],
  buildkitCommand: ["buildctl-daemonless.sh"],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Rig = { readonly cluster: FakeCluster; readonly registry: FakeOciRegistry; readonly upstream: GitUpstream; readonly executor: KubernetesExecutor };

const rig = async (options: { readonly buildPolicy?: boolean } = {}): Promise<Rig> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ostra-k8s-build-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const upstream = await startGitUpstream(path.join(root, "upstream"));
  cleanups.push(() => upstream.close());
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
  const registry = await startFakeOciRegistry();
  cleanups.push(() => registry.close());
  const cluster = await startFakeCluster({
    namespaces: [BOXES],
    processMode: {
      root: path.join(root, "pods"),
      commands: { ostra: [process.execPath, BUILD_MAIN], "buildctl-daemonless.sh": [process.execPath, FAKE_BUILDKIT] },
      log: () => undefined,
    },
  });
  cleanups.push(() => cluster.close());
  await cluster.createNamespace(BUILDS);
  if (options.buildPolicy ?? true) {
    await cluster.applyPolicy(BUILDS, buildEgressPolicy({ namespace: BUILDS, registry: { addresses: ["127.0.0.1"], port: 443 }, packageHosts: [], codeHosts: ["140.82.112.0/20"] }));
  }
  const executor = new KubernetesExecutor(
    { kube: cluster.kube, namespace: BOXES, images: { runner: settings.runnerImage, base: "ghcr.io/ostra/base:1.0.0" }, serverUrl: "https://ostra.example", pollMs: 50 },
    defaultAdapterContext,
  );
  return { cluster, registry, upstream, executor };
};

const pushRef = (registry: FakeOciRegistry): string => `${registry.host}/ostra/snapshots/${projectId}:${snapshotId}`;

describe("snapshots on kubernetes (ticket 08)", () => {
  it("F-120: the build pod: context, rootless BuildKit to an OCI tarball, the scan, then the push; each step mounts only its own secret, and BuildKit's unjustified settings are off", () => {
    const objects = buildObjects(
      {
        snapshotId,
        projectId,
        plan: { repos: [{ cloneUrl: "https://github.com/x/y.git", defaultBranch: "main", checkoutDir: "y", token: GIT_TOKEN, files: [] }], dockerfile: "FROM node:24\n", contextFiles: [] },
        secrets: [{ id: "s0_0", value: API_TOKEN }],
        scanFor: [{ name: "API_TOKEN", value: API_TOKEN }],
        push: { ref: "registry.example/ostra/project-a:snap-k8s-1", credential: { username: "pusher", token: "push-token-k8s" } },
      },
      settings,
    );
    const spec = objects.pod.spec;
    expect(objects.pod.metadata?.labels).toMatchObject({ "ostra.dev/role": BUILD_ROLE, "ostra.dev/snapshot": snapshotId, "ostra.dev/project": projectId });
    expect(spec?.initContainers?.map((container) => container.name)).toEqual(["context", "build", "scan"]);
    expect(spec?.containers.map((container) => container.name)).toEqual(["push"]);
    expect(spec?.restartPolicy).toBe("Never");
    expect(spec?.automountServiceAccountToken).toBe(false);
    const build = spec?.initContainers?.[1];
    expect(build?.image).toBe("moby/buildkit:v0.35.0-rootless");
    expect(build?.args).toEqual([
      "build",
      "--frontend=dockerfile.v0",
      "--local=context=/context",
      "--local=dockerfile=/context",
      "--secret",
      "id=s0_0,src=/run/ostra-build/secrets/s0_0",
      "--output",
      "type=oci,dest=/out/image.tar",
    ]);
    // Never privileged; RuntimeDefault seccomp, no AppArmor override, the process sandbox kept.
    expect(build?.securityContext).toEqual({ runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } });
    expect(build?.env).toContainEqual({ name: "BUILDKITD_FLAGS", value: "" });
    // Which container mounts which secret volume.
    const volumes = new Map((spec?.volumes ?? []).map((volume) => [volume.name, volume]));
    const secretMounts = Object.fromEntries(
      [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((container) => [
        container.name,
        (container.volumeMounts ?? []).filter((mount) => volumes.get(mount.name)?.secret !== undefined).map((mount) => mount.name),
      ]),
    );
    expect(secretMounts).toEqual({ context: ["plan"], build: ["setup-secrets"], scan: ["scan"], push: ["push"] });
    expect(volumes.get("push")?.secret?.secretName).toBe(objects.names.pushSecret);
    // The push credential is in its own secret, which only the push step mounts.
    expect(JSON.stringify(objects.secret).includes("push-token-k8s")).toBe(false);
    expect(Buffer.from(objects.pushSecret.data?.["push.json"] ?? "", "base64").toString("utf8")).toContain("push-token-k8s");

    const switched = buildObjects(
      { snapshotId, projectId, plan: { repos: [], dockerfile: "", contextFiles: [] }, secrets: [], scanFor: [], push: { ref: "r.example/a:b", credential: { username: "u", token: "t" } } },
      { ...settings, switches: { unconfinedSeccomp: true, unconfinedAppArmor: true, noProcessSandbox: true } },
    ).pod.spec?.initContainers?.[1];
    expect(switched?.securityContext?.seccompProfile).toEqual({ type: "Unconfined" });
    expect(switched?.securityContext?.appArmorProfile).toEqual({ type: "Unconfined" });
    expect(switched?.env).toContainEqual({ name: "BUILDKITD_FLAGS", value: "--oci-worker-no-process-sandbox" });
  });

  it("F-120, F-051: builds in the build namespace, scans, and pushes a clean image with the push credential; the digest comes back and the build's objects are gone", async () => {
    const { cluster, registry, upstream, executor } = await rig();
    const before = cluster.fake.requests().length;
    const built = await executor.buildSnapshot({
      snapshotId,
      projectId,
      environment: environment(upstream.cloneUrl("ostra-test/test1"), "npm ci\n"),
      credentials,
      push: { ref: pushRef(registry), credential: { username: registry.push.username, token: registry.push.password } },
      onOutput: () => undefined,
    });
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value.outcome, JSON.stringify(built.value)).toBe("built");
    const held = registry.manifest(`ostra/snapshots/${projectId}`, snapshotId);
    expect(held).toBeDefined();
    expect(built.value).toMatchObject({ outcome: "built", imageRef: pushRef(registry), digest: held?.digest, imageDigest: held?.digest });
    // Every push to the registry was the push credential's.
    const pushes = registry.requests().filter((request) => request.action === "push");
    expect(pushes.length).toBeGreaterThan(0);
    expect(new Set(pushes.map((request) => request.user))).toEqual(new Set([registry.push.username]));
    // The context step cloned with the repo's token.
    expect(upstream.requests.length).toBeGreaterThan(0);
    // Everything happened in the build namespace, and nothing of the build is left.
    expect(cluster.fake.requests().slice(before).every((request) => request.namespace === BUILDS || request.namespace === null)).toBe(true);
    expect(cluster.fake.list("pods", BUILDS)).toEqual([]);
    expect(cluster.fake.list("secrets", BUILDS)).toEqual([]);
  });

  it("F-120: a scan hit pushes nothing: the build fails as secret-found, naming the secret, and the registry saw no push", async () => {
    const { registry, upstream, executor, cluster } = await rig();
    const built = await executor.buildSnapshot({
      snapshotId,
      projectId,
      // A setup script that writes its secret into the image (the stand-in BuildKit's `LEAK`).
      environment: environment(upstream.cloneUrl("ostra-test/test1"), 'echo "$API_TOKEN" > leaked.txt # LEAK\n'),
      credentials,
      push: { ref: pushRef(registry), credential: { username: registry.push.username, token: registry.push.password } },
      onOutput: () => undefined,
    });
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value).toMatchObject({ outcome: "failed", reason: "secret-found" });
    expect(built.value.outcome === "failed" ? built.value.detail : "").toContain("API_TOKEN");
    expect(JSON.stringify(built.value).includes(API_TOKEN)).toBe(false);
    expect(registry.requests().filter((request) => request.action === "push")).toEqual([]);
    expect(registry.manifest(`ostra/snapshots/${projectId}`, snapshotId)).toBeUndefined();
    // The push step never ran: the pod ended at the scan.
    expect(cluster.fake.list("pods", BUILDS)).toEqual([]);
  });

  it("F-120, F-051: a kubernetes runner refuses a build with no registry push, and builds nothing without the build namespace's egress policy", async () => {
    const { registry, upstream, executor, cluster } = await rig({ buildPolicy: false });
    const input = {
      snapshotId,
      projectId,
      environment: environment(upstream.cloneUrl("ostra-test/test1"), "npm ci\n"),
      credentials,
      onOutput: () => undefined,
    };
    expect(await executor.buildSnapshot(input)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const refused = await executor.buildSnapshot({ ...input, push: { ref: pushRef(registry), credential: { username: registry.push.username, token: registry.push.password } } });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.message).toContain("no NetworkPolicy restricting the egress of its snapshot builds");
    expect(cluster.fake.list("pods", BUILDS)).toEqual([]);
    expect(registry.requests().filter((request) => request.action === "push")).toEqual([]);
  });

  it("F-116, F-051: the build namespace's policy lets a build reach DNS, the registry and the code and package hosts, and nothing else", () => {
    const policy = buildEgressPolicy({ namespace: BUILDS, registry: { addresses: ["203.0.113.7"], port: 443 }, packageHosts: ["104.16.0.0/13"], codeHosts: ["140.82.112.0/20"] });
    expect(policy.spec?.podSelector).toEqual({ matchLabels: { "ostra.dev/role": BUILD_ROLE } });
    expect(policy.spec?.policyTypes).toEqual(["Egress", "Ingress"]);
    expect(policy.spec?.ingress).toEqual([]);
    const egress = arrayOf(recordOf(policy.spec)["egress"]);
    expect(egress.map((rule) => arrayOf(rule["to"]).map((peer) => recordOf(peer["ipBlock"])["cidr"] ?? "dns"))).toEqual([
      ["dns"],
      ["203.0.113.7/32"],
      ["104.16.0.0/13", "140.82.112.0/20"],
    ]);
    // No rule allows everything, and none reaches a private range.
    expect(egress.every((rule) => arrayOf(rule["to"]).length > 0)).toBe(true);
    expect(JSON.stringify(policy)).not.toContain("0.0.0.0/0");
  });

  it("F-116: with no registry address and no hosts, the build policy allows DNS only: an empty peer list would allow every destination", () => {
    const policy = buildEgressPolicy({ namespace: BUILDS, registry: { addresses: [], port: 443 }, packageHosts: [], codeHosts: [] });
    const egress = arrayOf(recordOf(policy.spec)["egress"]);
    expect(egress).toHaveLength(1);
    expect(egress.every((rule) => arrayOf(rule["to"]).length > 0)).toBe(true);
  });
});
