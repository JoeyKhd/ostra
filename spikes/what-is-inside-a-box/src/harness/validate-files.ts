// `pnpm validate`: the static checks that run without Docker or a cluster.
// Parses every deploy YAML and asserts the shape the real runs rest on (the
// pod's sockets and capabilities, the compose file's many-boxes form and the
// init's capabilities, the Pod Security levels, the egress ranges, the gVisor
// runtime config), lints the Dockerfiles, and checks the snapshot generator.
// Returns a structured result the spike harness folds into V1 and P5.
//
// These checks only read files. A PASS here says a manifest has the intended
// shape; whether it runs is for the real-box mode (real-box.ts).

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { generateSnapshotDockerfile, secretsFoundInLayers } from "../snapshot/dockerfile.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOY_DIR = path.resolve(here, "..", "..", "deploy");

export type FileFinding = { readonly file: string; readonly ok: boolean; readonly note: string };

const BLOCKED_RANGES = ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;
const INIT_CAPS = ["SETUID", "SETGID", "KILL"] as const;

const listFiles = async (dir: string, match: (name: string) => boolean): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (match(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
};

const rel = (file: string): string => path.relative(DEPLOY_DIR, file).split(path.sep).join("/");

const read = async (...parts: string[]): Promise<string> => readFile(path.join(DEPLOY_DIR, ...parts), "utf8");

/** Parses every YAML document in a file; a syntax error is a finding. */
export const validateYaml = async (): Promise<FileFinding[]> => {
  const files = await listFiles(DEPLOY_DIR, (name) => name.endsWith(".yaml") || name.endsWith(".yml"));
  const findings: FileFinding[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const docs = parseAllDocuments(text, { strict: true });
    const errors = docs.flatMap((doc) => doc.errors);
    if (errors.length > 0) {
      findings.push({ file: rel(file), ok: false, note: `YAML error: ${errors[0]?.message ?? "parse error"}` });
      continue;
    }
    const kinds = docs.map((doc) => {
      const value: unknown = doc.toJS();
      return z.object({ kind: z.string() }).safeParse(value).data?.kind ?? "(no kind)";
    });
    findings.push({ file: rel(file), ok: true, note: `${String(docs.length)} doc(s): ${kinds.join(", ")}` });
  }
  return findings;
};

const docsOfKind = (text: string, kind: string): unknown[] =>
  parseAllDocuments(text)
    .map((doc): unknown => {
      const value: unknown = doc.toJS();
      return value;
    })
    .filter((value) => z.object({ kind: z.string() }).safeParse(value).data?.kind === kind);

const docOfKind = (text: string, kind: string): unknown => docsOfKind(text, kind)[0];

const flags = (entries: Readonly<Record<string, boolean>>): { readonly ok: boolean; readonly note: string } => ({
  ok: Object.values(entries).every(Boolean),
  note: Object.entries(entries)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(" "),
});

const envList = z.array(z.looseObject({ name: z.string(), value: z.string().optional() })).optional();
const mounts = z.array(z.looseObject({ name: z.string(), mountPath: z.string() })).optional();
const containerSchema = z.looseObject({
  name: z.string(),
  env: envList,
  volumeMounts: mounts,
  securityContext: z.looseObject({ capabilities: z.looseObject({ drop: z.array(z.string()).optional(), add: z.array(z.string()).optional() }).optional() }).optional(),
});

/** The shape checks the real runs rest on. */
export const validateManifestShape = async (): Promise<FileFinding[]> => {
  const findings: FileFinding[] = [];

  // The egress baseline on Kubernetes.
  const policy = z
    .object({
      spec: z.object({
        policyTypes: z.array(z.string()),
        egress: z.array(z.object({ to: z.array(z.object({ ipBlock: z.object({ cidr: z.string(), except: z.array(z.string()).optional() }).optional() })).optional() })),
      }),
    })
    .safeParse(docOfKind(await read("k8s", "egress-baseline.networkpolicy.yaml"), "NetworkPolicy"));
  if (!policy.success) {
    findings.push({ file: "k8s/egress-baseline.networkpolicy.yaml", ok: false, note: "not a NetworkPolicy with an egress spec" });
  } else {
    const excepts = policy.data.spec.egress.flatMap((rule) => rule.to ?? []).flatMap((to) => to.ipBlock?.except ?? []);
    const missing = BLOCKED_RANGES.filter((range) => !excepts.includes(range));
    const deniesIngress = policy.data.spec.policyTypes.includes("Ingress");
    findings.push({ file: "k8s/egress-baseline.networkpolicy.yaml", ok: missing.length === 0 && deniesIngress, note: missing.length === 0 ? `blocks private ranges + metadata; ingress ${deniesIngress ? "denied" : "OPEN"}` : `missing except ranges: ${missing.join(", ")}` });
  }

  // The box pod: containers, the init's capabilities, the runtime class
  // template, and the sidecar-only socket volume.
  const pod = z
    .object({
      metadata: z.looseObject({ namespace: z.string().optional() }),
      spec: z.looseObject({
        runtimeClassName: z.string().optional(),
        containers: z.array(containerSchema),
        initContainers: z.array(z.looseObject({ name: z.string(), restartPolicy: z.string().optional() })).optional(),
      }),
    })
    .safeParse(docOfKind(await read("k8s", "box-pod.yaml"), "Pod"));
  if (!pod.success) {
    findings.push({ file: "k8s/box-pod.yaml", ok: false, note: "not a Pod with the expected containers" });
  } else {
    const agent = pod.data.spec.containers.find((c) => c.name === "agent");
    const sidecar = pod.data.spec.containers.find((c) => c.name === "sidecar");
    const sidecarEnv = new Map((sidecar?.env ?? []).map((e) => [e.name, e.value ?? ""]));
    const socketVolume = (sidecar?.volumeMounts ?? []).find((m) => m.mountPath === "/run/ostra")?.name;
    const result = flags({
      agent: agent !== undefined,
      sidecar: sidecar !== undefined,
      serviceSidecar: (pod.data.spec.initContainers ?? []).some((c) => c.restartPolicy === "Always"),
      runtimeClassTemplated: pod.data.spec.runtimeClassName === "${OSTRA_RUNTIME_CLASS}",
      agentDropsAll: agent?.securityContext?.capabilities?.drop?.includes("ALL") ?? false,
      initCaps: INIT_CAPS.every((cap) => agent?.securityContext?.capabilities?.add?.includes(cap) ?? false),
      handoffOnSocket: (sidecarEnv.get("OSTRA_HANDOFF_SOCKET") ?? "").startsWith("/run/ostra/"),
      controlOnSocket: (sidecarEnv.get("OSTRA_CONTROL_SOCKET") ?? "").startsWith("/run/ostra/"),
      socketsSidecarOnly: socketVolume !== undefined && !(agent?.volumeMounts ?? []).some((m) => m.name === socketVolume),
      inBoxNamespace: pod.data.metadata.namespace === "ostra-boxes",
    });
    findings.push({ file: "k8s/box-pod.yaml", ...result });
  }

  // Pod Security levels: the box namespace must admit the pod (baseline), and
  // the build namespace the BuildKit Job (privileged); the runner's service
  // account exists for its RoleBinding.
  const namespaceText = await read("k8s", "namespace.yaml");
  const namespaces = new Map(
    docsOfKind(namespaceText, "Namespace").flatMap((doc) => {
      const parsed = z.object({ metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()).optional() }) }).safeParse(doc);
      return parsed.success ? [[parsed.data.metadata.name, parsed.data.metadata.labels ?? {}] as const] : [];
    }),
  );
  const accounts = new Set(docsOfKind(namespaceText, "ServiceAccount").flatMap((doc) => z.object({ metadata: z.object({ name: z.string() }) }).safeParse(doc).data?.metadata.name ?? []));
  const subjects = docsOfKind(namespaceText, "RoleBinding").flatMap((doc) => z.object({ subjects: z.array(z.object({ kind: z.string(), name: z.string() })) }).safeParse(doc).data?.subjects ?? []);
  const enforce = (name: string): string | undefined => namespaces.get(name)?.["pod-security.kubernetes.io/enforce"];
  findings.push({
    file: "k8s/namespace.yaml",
    ...flags({
      boxesBaseline: enforce("ostra-boxes") === "baseline",
      buildPrivileged: enforce("ostra-build") === "privileged",
      bindingSubjectsExist: subjects.length > 0 && subjects.filter((s) => s.kind === "ServiceAccount").every((s) => accounts.has(s.name)),
    }),
  });

  const job = z
    .object({
      metadata: z.object({ namespace: z.string() }),
      spec: z.object({ template: z.object({ metadata: z.looseObject({ annotations: z.record(z.string(), z.string()).optional() }).optional(), spec: z.object({ containers: z.array(z.looseObject({ securityContext: z.looseObject({ appArmorProfile: z.object({ type: z.string() }).optional() }).optional() })) }) }) }),
    })
    .safeParse(docOfKind(await read("k8s", "buildkit-rootless.yaml"), "Job"));
  findings.push({
    file: "k8s/buildkit-rootless.yaml",
    ...(job.success
      ? flags({
          inBuildNamespace: job.data.metadata.namespace === "ostra-build",
          appArmorField: job.data.spec.template.spec.containers.every((c) => c.securityContext?.appArmorProfile?.type === "Unconfined"),
          noDeprecatedAnnotation: !Object.keys(job.data.spec.template.metadata?.annotations ?? {}).some((k) => k.startsWith("container.apparmor.security.beta")),
        })
      : { ok: false, note: "not a Job" }),
  });

  // The compose file: the three services, the internal network, the init's
  // capabilities, and the many-boxes form (no fixed name, subnet or host port).
  const composeDoc: unknown = parseAllDocuments(await read("docker", "compose.box.yaml"))[0]?.toJS();
  const compose = z
    .object({
      name: z.string().optional(),
      services: z.record(z.string(), z.looseObject({ networks: z.array(z.string()).optional(), cap_add: z.array(z.string()).optional(), ports: z.array(z.string()).optional(), runtime: z.string().optional(), environment: z.record(z.string(), z.string()).optional() })),
      networks: z.record(z.string(), z.looseObject({ internal: z.boolean().optional(), ipam: z.object({ config: z.array(z.object({ subnet: z.string() })) }).optional() }).nullable()),
    })
    .safeParse(composeDoc);
  if (!compose.success) {
    findings.push({ file: "docker/compose.box.yaml", ok: false, note: "not a compose file with services and networks" });
  } else {
    const services = Object.keys(compose.data.services);
    const agent = compose.data.services["agent"];
    const sidecar = compose.data.services["sidecar"];
    const subnets = Object.values(compose.data.networks).flatMap((net) => net?.ipam?.config.map((c) => c.subnet) ?? []);
    findings.push({
      file: "docker/compose.box.yaml",
      ...flags({
        services: ["sidecar", "agent", "postgres"].every((s) => services.includes(s)),
        internalNetwork: Object.values(compose.data.networks).some((net) => net?.internal === true),
        agentInternalOnly: agent?.networks?.length === 1,
        initCaps: INIT_CAPS.every((cap) => agent?.cap_add?.includes(cap) ?? false),
        noFixedName: compose.data.name === undefined,
        ephemeralHostPorts: (sidecar?.ports ?? []).length > 0 && (sidecar?.ports ?? []).every((p) => /^127\.0\.0\.1::\d+$/.test(p)),
        subnetTemplated: subnets.length > 0 && subnets.every((s) => s.includes("${OSTRA_BOX_SUBNET")) && (sidecar?.environment?.["OSTRA_BOX_CIDRS"] ?? "").includes("${OSTRA_BOX_SUBNET"),
        runtimeTemplated: (agent?.runtime ?? "").includes("${OSTRA_AGENT_RUNTIME"),
      }),
    });
  }

  return findings;
};

/** The gVisor runtime config on both: Docker's daemon.json and the RuntimeClass. */
export const validateGvisor = async (): Promise<FileFinding[]> => {
  const findings: FileFinding[] = [];
  let daemonRaw: unknown;
  try {
    daemonRaw = JSON.parse(await read("gvisor", "daemon.json"));
  } catch {
    daemonRaw = undefined;
  }
  const daemon = z.object({ runtimes: z.object({ runsc: z.object({ path: z.string().min(1), runtimeArgs: z.array(z.string()).optional() }) }) }).safeParse(daemonRaw);
  findings.push({ file: "gvisor/daemon.json", ok: daemon.success, note: daemon.success ? `runtimes.runsc.path=${daemon.data.runtimes.runsc.path}` : "not a daemon.json with runtimes.runsc.path" });

  const runtimeClass = z.looseObject({ handler: z.string(), scheduling: z.unknown().optional() }).safeParse(docOfKind(await read("gvisor", "runtimeclass.yaml"), "RuntimeClass"));
  findings.push({
    file: "gvisor/runtimeclass.yaml",
    ...(runtimeClass.success ? flags({ handlerRunsc: runtimeClass.data.handler === "runsc", noProviderScheduling: runtimeClass.data.scheduling === undefined }) : { ok: false, note: "not a RuntimeClass" }),
  });
  return findings;
};

const DOCKERFILE_INSTRUCTIONS = new Set(["FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL"]);

/** A minimal Dockerfile lint: every logical line is a known instruction, the first is FROM/ARG/#syntax, continuations balance. */
export const validateDockerfiles = async (): Promise<FileFinding[]> => {
  const files = await listFiles(path.join(DEPLOY_DIR, "docker"), (name) => name.startsWith("Dockerfile"));
  const findings: FileFinding[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const rawLines = text.split(/\r?\n/);
    const logical: string[] = [];
    let buffer = "";
    for (const line of rawLines) {
      const trimmedRight = line.replace(/\s+$/, "");
      if (buffer === "" && line.trim() === "") continue;
      if (/^\s*#/.test(line) && buffer === "") {
        logical.push(line.trim());
        continue;
      }
      buffer += (buffer === "" ? "" : "\n") + trimmedRight;
      if (trimmedRight.endsWith("\\")) {
        buffer = buffer.slice(0, -1);
        continue;
      }
      if (buffer.trim() !== "") logical.push(buffer.trim());
      buffer = "";
    }
    if (buffer.trim() !== "") {
      findings.push({ file: rel(file), ok: false, note: "ends with an unterminated line continuation" });
      continue;
    }
    const instructions = logical.filter((line) => !line.startsWith("#"));
    const unknown = instructions.find((line) => {
      const keyword = line.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
      return !DOCKERFILE_INSTRUCTIONS.has(keyword);
    });
    const froms = instructions.filter((line) => line.toUpperCase().startsWith("FROM "));
    if (unknown !== undefined) {
      findings.push({ file: rel(file), ok: false, note: `unknown instruction: ${unknown.split(/\s+/, 1)[0] ?? ""}` });
    } else if (froms.length === 0) {
      findings.push({ file: rel(file), ok: false, note: "no FROM instruction" });
    } else {
      // The base image: uid 1000 must be free before `agent` takes it (the node image ships `node` at 1000).
      const base = path.basename(file) === "Dockerfile.base";
      const freesUid = !base || instructions.some((line) => line.includes("userdel -r node") && line.includes("--uid 1000"));
      const hashChecked = !base || instructions.some((line) => line.includes("sha256sum -c") && line.includes("/opt/ostra/bin/opencode"));
      findings.push({ file: rel(file), ok: freesUid && hashChecked, note: `${String(instructions.length)} instructions, ${String(froms.length)} stage(s)${base ? `; frees uid 1000=${String(freesUid)}; binary sha256 checked=${String(hashChecked)}` : ""}` });
    }
  }
  return findings;
};

/**
 * The snapshot generator's form (a unit-level check, filed under V1): the
 * setup secret is a mount, and the layer scan flags a planted value. Neither
 * says anything about a built image; that is the real-box snapshot run.
 */
export const validateSnapshot = (): FileFinding[] => {
  const dockerfile = generateSnapshotDockerfile({
    baseImage: "ostra/base@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    repos: [{ name: "ostra-test/app", commit: "0".repeat(40) }],
    setupScript: "pnpm install --frozen-lockfile\npnpm build",
    setupSecrets: [{ id: "npm_token", mountPath: "/run/secrets/npm_token" }],
  });
  const usesMount = dockerfile.includes("--mount=type=secret,id=npm_token");
  const planted = "npm_tok_0123456789abcdef";
  const catches = secretsFoundInLayers([`installed with ${planted} in .npmrc`], { npm_token: planted }).includes("npm_token");
  return [{ file: "snapshot/generator", ok: usesMount && catches, note: `setup secret is a BuildKit mount=${String(usesMount)}; layer scan flags a planted value=${String(catches)}` }];
};

export type Validation = {
  readonly yaml: FileFinding[];
  readonly shape: FileFinding[];
  readonly gvisor: FileFinding[];
  readonly dockerfiles: FileFinding[];
  readonly snapshot: FileFinding[];
};

export const runValidation = async (): Promise<Validation> => ({
  yaml: await validateYaml(),
  shape: await validateManifestShape(),
  gvisor: await validateGvisor(),
  dockerfiles: await validateDockerfiles(),
  snapshot: validateSnapshot(),
});

if (process.argv[1]?.endsWith("validate-files.ts") === true) {
  const result = await runValidation();
  let bad = 0;
  for (const [group, findings] of Object.entries(result)) {
    console.log(`\n${group}:`);
    for (const finding of findings) {
      console.log(`  ${finding.ok ? "ok  " : "FAIL"} ${finding.file} — ${finding.note}`);
      if (!finding.ok) bad += 1;
    }
  }
  if (bad > 0) {
    console.error(`\n${String(bad)} finding(s)`);
    process.exitCode = 1;
  }
}
