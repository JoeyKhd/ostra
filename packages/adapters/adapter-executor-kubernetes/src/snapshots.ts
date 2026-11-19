import type { V1Container, V1Pod, V1Secret, V1Volume } from "@kubernetes/client-node";
import type { BoxSize, RegistryCredential } from "@ostra/adapter-sdk";
import type { ProjectId, SnapshotId } from "@ostra/protocol";

import { BUILD_ROLE } from "./egress.ts";
import { dnsPart, labelValue, LABELS, resourcesOf } from "./pod.ts";

// A snapshot build on `kubernetes` (ticket 08, F-120, ADR 0038, ADR 0060): a pod in the build
// namespace, never beside the boxes, ported from spike 3's `buildkit-rootless.yaml` and
// `build-rootless.sh` and built as a typed value. Its containers run in order, each ending before
// the next starts, and a failed one ends the pod (`restartPolicy: Never`):
//
//   context  (init, the runner image)   clones each repo with its token for its one clone and writes
//                                        the Dockerfile and the context's files (`build-steps.ts`)
//   build    (init, rootless BuildKit)  builds with the setup secrets as BuildKit secrets, for the
//                                        build only, and exports an OCI tarball to the pod's volume:
//                                        it pushes nothing and holds no registry credential
//   scan     (init, the runner image)   milestone 3's scan of every layer for each setup secret's
//                                        value and each git token; a hit ends the pod here
//   push     (the runner image)         only after a clean scan: pushes the tarball with the push
//                                        credential, which no other container mounts, and prints
//                                        the manifest's digest
//
// Each container mounts only its own key of the build's secret. BuildKit's settings spike 3
// couldn't justify are each a named switch, off unless a live run shows one is needed, and on
// milestone 7's security review's list: `Unconfined` seccomp, `Unconfined` AppArmor, and
// `--oci-worker-no-process-sandbox`.

/** BuildKit's rootless image, pinned. */
export const BUILDKIT_IMAGE = "moby/buildkit:v0.35.0-rootless";

/** The settings spike 3's rootless BuildKit used and couldn't justify: each off unless a live run needs it (milestone 7's review). */
export type BuildkitSwitches = {
  readonly unconfinedSeccomp: boolean;
  readonly unconfinedAppArmor: boolean;
  readonly noProcessSandbox: boolean;
};

export const BUILDKIT_SWITCHES_OFF: BuildkitSwitches = { unconfinedSeccomp: false, unconfinedAppArmor: false, noProcessSandbox: false };

export type BuildSettings = {
  readonly namespace: string;
  readonly runnerImage: string;
  readonly buildkitImage: string;
  readonly switches: BuildkitSwitches;
  /** The build container's limits. */
  readonly limits: BoxSize;
  /** The runner image's build steps: `ostra internal build-step <step>`. */
  readonly stepCommand: readonly string[];
  /** BuildKit's daemonless build in its image. */
  readonly buildkitCommand: readonly string[];
};

/** What the context step reads: the repos to clone, with their tokens, the Dockerfile and the context's files. Never logged. */
export type ContextPlan = {
  readonly repos: readonly {
    readonly cloneUrl: string;
    readonly defaultBranch: string;
    readonly checkoutDir: string;
    readonly token: string | null;
    readonly files: readonly { readonly path: string; readonly content: string }[];
  }[];
  readonly dockerfile: string;
  readonly contextFiles: readonly { readonly path: string; readonly content: string }[];
};

export type BuildPodInput = {
  readonly snapshotId: SnapshotId;
  readonly projectId: ProjectId;
  readonly plan: ContextPlan;
  /** BuildKit's secrets: the setup secrets, by their id in the Dockerfile. */
  readonly secrets: readonly { readonly id: string; readonly value: string }[];
  /** What the scan looks for: each setup secret and each git token, by name. */
  readonly scanFor: readonly { readonly name: string; readonly value: string }[];
  readonly push: { readonly ref: string; readonly credential: RegistryCredential };
};

export type BuildObjects = {
  readonly names: { readonly pod: string; readonly secret: string; readonly pushSecret: string };
  readonly labels: Readonly<Record<string, string>>;
  readonly selector: string;
  readonly secret: V1Secret;
  readonly pushSecret: V1Secret;
  readonly pod: V1Pod;
};

export const CONTEXT_DIR = "/context";
export const OUT_DIR = "/out";
export const IMAGE_ARCHIVE = `${OUT_DIR}/image.tar`;
const BUILD_DIR = "/run/ostra-build";
export const STEP_FILES = {
  plan: `${BUILD_DIR}/plan/plan.json`,
  scan: `${BUILD_DIR}/scan/scan.json`,
  push: `${BUILD_DIR}/push/push.json`,
  secrets: `${BUILD_DIR}/secrets`,
} as const;

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

export const buildNames = (snapshotId: SnapshotId): BuildObjects["names"] => {
  const base = `ostra-build-${dnsPart(snapshotId)}`;
  return { pod: base, secret: base, pushSecret: `${base}-push` };
};

export const buildSelector = (snapshotId: SnapshotId): string => `${LABELS.role}=${BUILD_ROLE},ostra.dev/snapshot=${labelValue(snapshotId)}`;

/** The build's pod and its two secrets, as typed values. Pure: the unit tests read them. */
export const buildObjects = (input: BuildPodInput, settings: BuildSettings): BuildObjects => {
  const names = buildNames(input.snapshotId);
  const labels = { [LABELS.partOf]: "ostra", [LABELS.role]: BUILD_ROLE, "ostra.dev/snapshot": labelValue(input.snapshotId), "ostra.dev/project": labelValue(input.projectId) };
  const secretKeys = input.secrets.map((secret) => secret.id);
  const secret: V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.secret, labels: { ...labels } },
    type: "Opaque",
    data: {
      "plan.json": base64(JSON.stringify(input.plan)),
      "scan.json": base64(JSON.stringify({ targets: input.scanFor })),
      ...Object.fromEntries(input.secrets.map((each) => [each.id, base64(each.value)])),
    },
  };
  const pushSecret: V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.pushSecret, labels: { ...labels } },
    type: "Opaque",
    data: { "push.json": base64(JSON.stringify({ ref: input.push.ref, username: input.push.credential.username, token: input.push.credential.token })) },
  };
  const step = (name: "context" | "scan" | "push", env: Record<string, string>, mounts: NonNullable<V1Container["volumeMounts"]>): V1Container => ({
    name,
    image: settings.runnerImage,
    command: [...settings.stepCommand, name],
    env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
    securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
    resources: resourcesOf({ cpuMillis: 1000, memoryMiB: 1024 }),
    volumeMounts: [{ name: "tmp", mountPath: "/tmp" }, ...mounts],
  });
  const switches = settings.switches;
  const build: V1Container = {
    name: "build",
    image: settings.buildkitImage,
    command: [...settings.buildkitCommand],
    args: [
      "build",
      "--frontend=dockerfile.v0",
      `--local=context=${CONTEXT_DIR}`,
      `--local=dockerfile=${CONTEXT_DIR}`,
      ...secretKeys.flatMap((id) => ["--secret", `id=${id},src=${STEP_FILES.secrets}/${id}`]),
      // An OCI tarball on the pod's volume: the scan reads it before anything is pushed.
      "--output",
      `type=oci,dest=${IMAGE_ARCHIVE}`,
    ],
    env: [
      { name: "BUILDKITD_FLAGS", value: switches.noProcessSandbox ? "--oci-worker-no-process-sandbox" : "" },
      { name: "HOME", value: "/home/user" },
    ],
    securityContext: {
      // Rootless: never privileged, the image's unprivileged user (spike 3).
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      seccompProfile: { type: switches.unconfinedSeccomp ? "Unconfined" : "RuntimeDefault" },
      ...(switches.unconfinedAppArmor ? { appArmorProfile: { type: "Unconfined" } } : {}),
    },
    resources: resourcesOf(settings.limits),
    volumeMounts: [
      { name: "context", mountPath: CONTEXT_DIR, readOnly: true },
      { name: "out", mountPath: OUT_DIR },
      { name: "buildkitd", mountPath: "/home/user/.local/share/buildkit" },
      ...(secretKeys.length === 0 ? [] : [{ name: "setup-secrets", mountPath: STEP_FILES.secrets, readOnly: true }]),
    ],
  };
  const volumes: V1Volume[] = [
    { name: "context", emptyDir: {} },
    { name: "out", emptyDir: {} },
    { name: "buildkitd", emptyDir: {} },
    { name: "tmp", emptyDir: { medium: "Memory" } },
    { name: "plan", secret: { secretName: names.secret, items: [{ key: "plan.json", path: "plan.json", mode: 0o400 }], defaultMode: 0o400 } },
    { name: "scan", secret: { secretName: names.secret, items: [{ key: "scan.json", path: "scan.json", mode: 0o400 }], defaultMode: 0o400 } },
    ...(secretKeys.length === 0 ? [] : [{ name: "setup-secrets", secret: { secretName: names.secret, items: secretKeys.map((id) => ({ key: id, path: id, mode: 0o400 })), defaultMode: 0o400 } }]),
    { name: "push", secret: { secretName: names.pushSecret, items: [{ key: "push.json", path: "push.json", mode: 0o400 }], defaultMode: 0o400 } },
  ];
  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: names.pod, labels: { ...labels } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      activeDeadlineSeconds: 3600,
      securityContext: { fsGroup: 1000 },
      initContainers: [
        step("context", { OSTRA_BUILD_PLAN: STEP_FILES.plan, OSTRA_BUILD_CONTEXT: CONTEXT_DIR }, [
          { name: "plan", mountPath: `${BUILD_DIR}/plan`, readOnly: true },
          { name: "context", mountPath: CONTEXT_DIR },
        ]),
        build,
        step("scan", { OSTRA_BUILD_SCAN: STEP_FILES.scan, OSTRA_BUILD_IMAGE: IMAGE_ARCHIVE }, [
          { name: "scan", mountPath: `${BUILD_DIR}/scan`, readOnly: true },
          { name: "out", mountPath: OUT_DIR, readOnly: true },
        ]),
      ],
      containers: [
        step("push", { OSTRA_BUILD_PUSH: STEP_FILES.push, OSTRA_BUILD_IMAGE: IMAGE_ARCHIVE, OSTRA_BUILD_LAYOUT: `${OUT_DIR}/layout` }, [
          { name: "push", mountPath: `${BUILD_DIR}/push`, readOnly: true },
          { name: "out", mountPath: OUT_DIR },
        ]),
      ],
      volumes,
    },
  };
  return { names, labels, selector: buildSelector(input.snapshotId), secret, pushSecret, pod };
};
