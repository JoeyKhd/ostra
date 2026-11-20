// The checks of a chart's rendered manifests (`helm template`), read with `@kubernetes/client-node`'s
// `loadAllYaml` (ADR 0060, F-118): the runner's role is namespaced and holds the executor's rights and
// no more, the egress policies are the ones the kubernetes executor's typed values build, the runner
// reads its join token from the admin's secret; the server's processes share one secret, made once.

import { loadAllYaml } from "@kubernetes/client-node";
import {
  BASELINE_POLICY_NAME,
  BUILD_POLICY_NAME,
  baselineEgressPolicy,
  buildEgressPolicy,
  LABELS,
  NEEDED_ACCESS,
} from "@ostra/adapter-executor-kubernetes";
import type { ServerAddress } from "@ostra/adapter-executor-kubernetes";
import { z } from "zod";

import type { RunnerValues, ServerValues } from "./values.ts";

export type RenderRule =
  | "cluster-role"
  | "role-scope"
  | "role-rights"
  | "baseline-policy"
  | "build-policy"
  | "runner-deployment"
  | "join-token"
  | "shared-secret"
  | "server-deployments"
  | "ingress";

export type RenderProblem = { readonly rule: RenderRule; readonly message: string };

const metadataSchema = z.looseObject({
  name: z.string(),
  namespace: z.string().optional(),
  labels: z.record(z.string(), z.string()).nullish(),
  annotations: z.record(z.string(), z.string()).nullish(),
});

const manifestSchema = z.looseObject({ apiVersion: z.string(), kind: z.string(), metadata: metadataSchema });
export type Manifest = z.infer<typeof manifestSchema>;

/** The manifests of a `helm template` output, as plain data. */
export const parseRender = (text: string): readonly Manifest[] => {
  const docs: unknown[] = loadAllYaml(text);
  return docs.filter((doc) => doc !== null && doc !== undefined).map((doc) => manifestSchema.parse(JSON.parse(JSON.stringify(doc))));
};

/** JSON with sorted keys, so two values compare by content. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

const of = (manifests: readonly Manifest[], kind: string): readonly Manifest[] => manifests.filter((manifest) => manifest.kind === kind);

const ruleSchema = z.looseObject({
  apiGroups: z.array(z.string()).optional(),
  resources: z.array(z.string()).optional(),
  verbs: z.array(z.string()),
  resourceNames: z.array(z.string()).optional(),
});
const roleSchema = z.looseObject({ rules: z.array(ruleSchema).optional() });
const bindingSchema = z.looseObject({
  roleRef: z.looseObject({ kind: z.string(), name: z.string() }),
  subjects: z.array(z.looseObject({ kind: z.string(), name: z.string(), namespace: z.string().optional() })).optional(),
});

const envVarSchema = z.looseObject({
  name: z.string(),
  value: z.string().optional(),
  valueFrom: z.looseObject({ secretKeyRef: z.looseObject({ name: z.string(), key: z.string() }).optional() }).optional(),
});
const containerSchema = z.looseObject({ name: z.string(), args: z.array(z.string()).optional(), env: z.array(envVarSchema).optional() });
const deploymentSchema = z.looseObject({
  spec: z.looseObject({
    replicas: z.number().optional(),
    template: z.looseObject({
      spec: z.looseObject({
        serviceAccountName: z.string().optional(),
        containers: z.array(containerSchema),
        volumes: z.array(z.looseObject({ name: z.string(), secret: z.looseObject({ secretName: z.string() }).optional() })).optional(),
      }),
    }),
  }),
});

/** The rights a role's rules grant, as `group/resource:verb`, with the resource names a rule narrows to. */
const grants = (rules: readonly z.infer<typeof ruleSchema>[]): readonly string[] =>
  rules.flatMap((rule) => (rule.apiGroups ?? [""]).flatMap((group) => (rule.resources ?? []).flatMap((resource) => rule.verbs.map((verb) => `${group}/${resource}:${verb}`))));

/** What the runner's release namespace and its service account are, as the checks read them. */
export type RunnerRelease = { readonly namespace: string; readonly serviceAccount: string };

const serverAddressOf = (values: RunnerValues): ServerAddress => {
  const egress = values.server.egress;
  return "cidr" in egress
    ? { kind: "cidr", cidr: egress.cidr, port: egress.port }
    : { kind: "in-cluster", namespaceLabels: { "kubernetes.io/metadata.name": egress.namespace }, podLabels: egress.podLabels, port: egress.port };
};

/** The runner chart's render against its values. Empty when it passes. */
export const checkRunnerRender = (manifests: readonly Manifest[], values: RunnerValues, release: RunnerRelease): readonly RenderProblem[] => {
  const problems: RenderProblem[] = [];
  const add = (rule: RenderRule, message: string): void => {
    problems.push({ rule, message });
  };
  const namespaces = [values.namespaces.boxes, values.namespaces.builds];

  for (const manifest of [...of(manifests, "ClusterRole"), ...of(manifests, "ClusterRoleBinding")]) {
    add("cluster-role", `${manifest.kind} ${manifest.metadata.name}: the runner's rights are namespaced, never cluster-wide`);
  }
  for (const kind of ["Role", "RoleBinding"]) {
    for (const manifest of of(manifests, kind)) {
      if (!namespaces.includes(manifest.metadata.namespace ?? "")) {
        add("role-scope", `${kind} ${manifest.metadata.name} is in ${manifest.metadata.namespace ?? "no namespace"}, not the box or build namespace`);
      }
    }
  }
  for (const namespace of namespaces) {
    const roles = of(manifests, "Role").filter((manifest) => manifest.metadata.namespace === namespace);
    const bindings = of(manifests, "RoleBinding").filter((manifest) => manifest.metadata.namespace === namespace);
    if (roles.length !== 1 || bindings.length !== 1) {
      add("role-scope", `${namespace} needs one Role and one RoleBinding, and has ${String(roles.length)} and ${String(bindings.length)}`);
      continue;
    }
    const role = roleSchema.parse(roles[0]);
    const binding = bindingSchema.parse(bindings[0]);
    const granted = grants(role.rules ?? []);
    for (const access of NEEDED_ACCESS) {
      if (!granted.includes(`${access.group}/${access.resource}:${access.verb}`)) {
        add("role-rights", `the role in ${namespace} doesn't let the runner ${access.verb} ${access.resource}`);
      }
    }
    for (const grant of granted) {
      if (grant.includes("*")) {
        add("role-rights", `the role in ${namespace} grants a wildcard: ${grant}`);
      }
      if (/\/networkpolicies:(?!get$|list$|watch$)/.test(grant)) {
        add("role-rights", `the role in ${namespace} may change network policies (${grant}), which is the right to remove the baseline`);
      }
      if (/\/(?:roles|rolebindings|clusterroles|clusterrolebindings|serviceaccounts\/token)(?::|$)/.test(grant) || /:(?:escalate|bind|impersonate)$/.test(grant)) {
        add("role-rights", `the role in ${namespace} grants ${grant}, which lets the runner widen its own rights`);
      }
    }
    for (const rule of role.rules ?? []) {
      if ((rule.resources ?? []).includes("namespaces") && JSON.stringify(rule.resourceNames ?? []) !== JSON.stringify([namespace])) {
        add("role-rights", `the role in ${namespace} reads namespaces other than its own`);
      }
    }
    const subject = binding.subjects?.[0];
    if (binding.roleRef.kind !== "Role" || binding.subjects?.length !== 1 || subject?.kind !== "ServiceAccount" || subject.name !== release.serviceAccount || subject.namespace !== release.namespace) {
      add("role-scope", `the RoleBinding in ${namespace} must bind its Role to the runner's service account only`);
    }
  }

  const policy = (name: string, namespace: string): Manifest | undefined =>
    of(manifests, "NetworkPolicy").find((manifest) => manifest.metadata.name === name && manifest.metadata.namespace === namespace);
  const baseline = policy(BASELINE_POLICY_NAME, values.namespaces.boxes);
  const expectedBaseline = baselineEgressPolicy({ namespace: values.namespaces.boxes, server: serverAddressOf(values), allow: values.egress.allow });
  if (baseline === undefined) {
    add("baseline-policy", `no ${BASELINE_POLICY_NAME} NetworkPolicy in ${values.namespaces.boxes}`);
  } else {
    if (canonical(Reflect.get(baseline, "spec")) !== canonical(expectedBaseline.spec)) {
      add("baseline-policy", "the baseline differs from baselineEgressPolicy's: its ranges, its exception for the server, or its selector");
    }
    if (baseline.metadata.labels?.[LABELS.partOf] !== "ostra") {
      add("baseline-policy", `the baseline needs the label ${LABELS.partOf}: ostra`);
    }
  }
  const build = policy(BUILD_POLICY_NAME, values.namespaces.builds);
  const expectedBuild = buildEgressPolicy({
    namespace: values.namespaces.builds,
    registry: values.build.registry,
    packageHosts: values.build.packageHosts,
    codeHosts: values.build.codeHosts,
  });
  if (build === undefined || canonical(Reflect.get(build, "spec")) !== canonical(expectedBuild.spec)) {
    add("build-policy", `the build namespace's ${BUILD_POLICY_NAME} is missing or differs from buildEgressPolicy's`);
  }

  const deployments = of(manifests, "Deployment");
  const deployment = deployments.length === 1 ? deploymentSchema.safeParse(deployments[0]) : null;
  if (deployment?.success !== true) {
    add("runner-deployment", "the chart needs exactly one Deployment, the runner's");
    return problems;
  }
  const pod = deployment.data.spec.template.spec;
  const runner = pod.containers[0];
  const args = runner?.args ?? [];
  const executor = args.indexOf("--executor");
  if (args[0] !== "runner" || executor < 0 || args[executor + 1] !== "kubernetes") {
    add("runner-deployment", "the runner runs as `ostra runner --executor kubernetes`");
  }
  if (deployment.data.spec.replicas !== 1) {
    add("runner-deployment", "one replica: a runner is one key pair");
  }
  if (pod.serviceAccountName !== release.serviceAccount) {
    add("runner-deployment", "the runner runs as the chart's service account");
  }
  const env = new Map((runner?.env ?? []).map((item) => [item.name, item]));
  if (env.get("OSTRA_K8S_NAMESPACE")?.value !== values.namespaces.boxes || env.get("OSTRA_K8S_BUILD_NAMESPACE")?.value !== values.namespaces.builds) {
    add("runner-deployment", "OSTRA_K8S_NAMESPACE and OSTRA_K8S_BUILD_NAMESPACE must be the chart's namespaces");
  }
  const tokenFile = env.get("OSTRA_JOIN_TOKEN_FILE")?.value ?? "";
  const tokenVolume = (pod.volumes ?? []).find((volume) => volume.secret?.secretName === values.joinToken.existingSecret);
  if (env.has("OSTRA_JOIN_TOKEN") || tokenVolume === undefined || !tokenFile.endsWith(`/${values.joinToken.key}`)) {
    add("join-token", "the join token is read from joinToken.existingSecret as a file, never from a value");
  }
  return problems;
};

const keyNames = ["OSTRA_SECRETS_KEY", "BETTER_AUTH_SECRET", "OSTRA_RUNNER_TOKEN_KEY"] as const;

/** The server chart's render against its values. Empty when it passes. */
export const checkServerRender = (manifests: readonly Manifest[], values: ServerValues, keysSecret: string): readonly RenderProblem[] => {
  const problems: RenderProblem[] = [];
  const add = (rule: RenderRule, message: string): void => {
    problems.push({ rule, message });
  };
  for (const manifest of [...of(manifests, "ClusterRole"), ...of(manifests, "ClusterRoleBinding")]) {
    add("cluster-role", `${manifest.kind} ${manifest.metadata.name}: the server needs no cluster-wide rights`);
  }
  const holding = of(manifests, "Secret").filter((manifest) => {
    const data = z.record(z.string(), z.string()).safeParse(Reflect.get(manifest, "data") ?? Reflect.get(manifest, "stringData") ?? {});
    return data.success && keyNames.some((key) => key in data.data);
  });
  if (values.secrets.existingSecret === "") {
    const [secret] = holding;
    if (holding.length !== 1 || secret === undefined) {
      add("shared-secret", `one secret holds the three keys, and the render has ${String(holding.length)}`);
    } else {
      const data = z.record(z.string(), z.string()).parse(Reflect.get(secret, "data"));
      if (secret.metadata.name !== keysSecret || !keyNames.every((key) => (data[key] ?? "") !== "")) {
        add("shared-secret", `the shared secret ${keysSecret} holds OSTRA_SECRETS_KEY, BETTER_AUTH_SECRET and OSTRA_RUNNER_TOKEN_KEY`);
      }
      if (secret.metadata.annotations?.["helm.sh/resource-policy"] !== "keep") {
        add("shared-secret", "the shared secret is kept on upgrade and uninstall (helm.sh/resource-policy: keep)");
      }
    }
  } else if (holding.length !== 0) {
    add("shared-secret", "with secrets.existingSecret the chart makes no secret of its own");
  }

  const deployments = new Map(
    of(manifests, "Deployment").map((manifest) => [manifest.metadata.labels?.["app.kubernetes.io/component"] ?? manifest.metadata.name, deploymentSchema.parse(manifest)]),
  );
  for (const role of ["web", "core"] as const) {
    const deployment = deployments.get(role);
    if (deployment === undefined) {
      add("server-deployments", `no ${role} deployment`);
      continue;
    }
    if (deployment.spec.replicas !== values[role].replicas) {
      add("server-deployments", `the ${role} deployment has ${String(deployment.spec.replicas)} replicas, not ${String(values[role].replicas)}`);
    }
    const container = deployment.spec.template.spec.containers[0];
    if (JSON.stringify(container?.args) !== JSON.stringify([role])) {
      add("server-deployments", `the ${role} deployment runs \`ostra-server ${role}\``);
    }
    const env = new Map((container?.env ?? []).map((item) => [item.name, item]));
    for (const key of keyNames) {
      const ref = env.get(key)?.valueFrom?.secretKeyRef;
      if (ref?.name !== keysSecret || ref.key !== key) {
        add("shared-secret", `the ${role} deployment reads ${key} from ${keysSecret}`);
      }
    }
    if (env.get("DATABASE_URL")?.valueFrom?.secretKeyRef === undefined) {
      add("server-deployments", `the ${role} deployment reads DATABASE_URL from a secret`);
    }
    // Each replica's data folder is its own emptyDir: a bootstrap join token there joins nothing.
    if (env.get("OSTRA_BOOTSTRAP_JOIN_TOKEN")?.value !== (values.env["OSTRA_BOOTSTRAP_JOIN_TOKEN"] ?? "false")) {
      add("server-deployments", `the ${role} deployment sets OSTRA_BOOTSTRAP_JOIN_TOKEN=false unless env names it`);
    }
  }
  if (deployments.size !== 2) {
    add("server-deployments", "the chart has two deployments, web and core");
  }

  const ingresses = of(manifests, "Ingress");
  if (values.ingress.enabled) {
    const timeout = ingresses[0]?.metadata.annotations?.["nginx.ingress.kubernetes.io/proxy-read-timeout"];
    if (ingresses.length !== 1 || timeout !== String(values.ingress.idleTimeoutSeconds)) {
      add("ingress", "the ingress raises the proxy's idle timeout to ingress.idleTimeoutSeconds, for WebSockets");
    }
  } else if (ingresses.length !== 0) {
    add("ingress", "no ingress unless ingress.enabled");
  }
  return problems;
};
