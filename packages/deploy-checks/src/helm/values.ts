// The Helm charts' values, as Zod schemas (ADR 0060, F-118). They're the source of each chart's
// `values.schema.json` (`z.toJSONSchema`, `schema-files.ts`), so Helm checks a user's values at
// install, and ostra's tests check `values.yaml` and every example without Helm.
//
// Helm validates the merged values (`values.yaml` with the user's), so every key is required here
// and `values.yaml` holds the defaults. The required values are the keys `values.yaml` leaves out:
// `requiredPaths` names them, and a test checks that `values.yaml` alone fails on exactly those.
// Objects are strict: ostra owns this format, so a mistyped key is refused.

import { z } from "zod";

const port = z.int().min(1).max(65_535);
const dnsName = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63);
const quantities = z.record(z.string().min(1), z.union([z.string().min(1), z.number().positive()]));
/** A container's requests and limits, as Kubernetes writes them: one value in the reference. */
const resources = z.strictObject({ requests: quantities, limits: quantities });
const image = z.strictObject({
  repository: z.string().min(1),
  /** Empty: the chart's `appVersion`, the release the chart ships with. */
  tag: z.string(),
  pullPolicy: z.enum(["Always", "IfNotPresent", "Never"]),
});
/** The settings a deployment passes on as they are: `OSTRA_*` names and the like. */
const env = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string());
const labelMap = z.record(z.string().min(1), z.string());

/** `deploy/helm/ostra-server`: the panel and core, against a Postgres the admin provides. */
export const serverValuesSchema = z.strictObject({
  image,
  imagePullSecrets: z.array(z.string().min(1)),
  /** `OSTRA_PUBLIC_URL`; empty: the server's default. */
  publicUrl: z.string(),
  /** `OSTRA_CORE_PUBLIC_URL`; empty: the server's default. */
  corePublicUrl: z.string(),
  /** Required: the database's URL, or a secret that holds it. */
  database: z.union([
    z.strictObject({ url: z.string().min(1), existingSecretKey: z.string().min(1) }),
    z.strictObject({ existingSecret: z.string().min(1), existingSecretKey: z.string().min(1) }),
  ]),
  /** Empty: the chart makes the shared secret once, on install. */
  secrets: z.strictObject({ existingSecret: z.string() }),
  web: z.strictObject({ replicas: z.int().min(1), port, resources }),
  core: z.strictObject({ replicas: z.int().min(1), port, resources }),
  service: z.strictObject({ type: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]) }),
  ingress: z.strictObject({
    enabled: z.boolean(),
    className: z.string(),
    webHost: z.string(),
    coreHost: z.string(),
    tlsSecretName: z.string(),
    idleTimeoutSeconds: z.int().min(60),
    annotations: z.record(z.string().min(1), z.string()),
  }),
  env,
});

export type ServerValues = z.infer<typeof serverValuesSchema>;

/** Where the ostra server is, for the box namespace's egress baseline: an address, or pods in this cluster. */
const serverEgress = z.union([
  z.strictObject({ cidr: z.string().min(1), port }),
  z.strictObject({ namespace: dnsName, podLabels: labelMap, port }),
]);

/** `deploy/helm/ostra-runner`: a `kubernetes` pool runner with its namespaces, role and policies. */
export const runnerValuesSchema = z.strictObject({
  image,
  imagePullSecrets: z.array(z.string().min(1)),
  /** The base image a box's agent runs in, for an environment that names none. */
  boxImage: z.strictObject({ repository: z.string().min(1), tag: z.string() }),
  server: z.strictObject({
    /** Required: `OSTRA_SERVER_URL`, core's address as the runner reaches it. */
    url: z.string().regex(/^https?:\/\/\S+$/),
    /** `OSTRA_BOX_SERVER_URL`; empty: `server.url`. */
    boxUrl: z.string(),
    /** Required: the baseline's one exception (ADR 0060). */
    egress: serverEgress,
  }),
  joinToken: z.strictObject({
    /** Required: the secret holding the pool's join token. */
    existingSecret: z.string().min(1),
    key: z.string().min(1),
  }),
  runner: z.strictObject({
    name: z.string(),
    labels: z.array(z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/)),
    slots: z.int().min(1),
    nodeWaitMinutes: z.int().min(1),
    runtimeClass: z.string(),
    resources,
  }),
  namespaces: z.strictObject({ create: z.boolean(), boxes: dnsName, builds: dnsName }),
  /** `OSTRA_EGRESS_ALLOW`: private addresses a box may reach besides the server's. */
  egress: z.strictObject({ allow: z.array(z.string().min(1)) }),
  /** The build namespace's policy: the registry, and the package and code hosts, by address. */
  build: z.strictObject({
    registry: z.strictObject({ addresses: z.array(z.string().min(1)), port }),
    packageHosts: z.array(z.string().min(1)),
    codeHosts: z.array(z.string().min(1)),
  }),
  persistence: z.strictObject({ enabled: z.boolean(), size: z.string().min(1), storageClassName: z.string() }),
});

export type RunnerValues = z.infer<typeof runnerValuesSchema>;

export const chartNames = ["ostra-server", "ostra-runner"] as const;
export type ChartName = (typeof chartNames)[number];

export const valuesSchemaOf = (chart: ChartName): z.ZodType => {
  switch (chart) {
    case "ostra-server":
      return serverValuesSchema;
    case "ostra-runner":
      return runnerValuesSchema;
    default:
      return chart satisfies never;
  }
};

/** The values with no default: `values.yaml` leaves them out, and an install must give them. */
export const requiredPaths: Readonly<Record<ChartName, readonly string[]>> = {
  "ostra-server": ["database"],
  "ostra-runner": ["server.url", "server.egress", "joinToken.existingSecret"],
};

/**
 * Every value's path, as the configuration reference lists it: an object's keys, and each option of
 * a union under the same path. Maps, lists and a container's resources are one value each.
 */
export const valuePaths = (schema: z.ZodType, prefix = ""): readonly string[] => {
  if (schema instanceof z.ZodObject && schema !== resources) {
    return Object.entries(schema.shape).flatMap(([key, value]: [string, z.ZodType]) => valuePaths(value, prefix === "" ? key : `${prefix}.${key}`));
  }
  if (schema instanceof z.ZodUnion) {
    return [...new Set(schema.options.flatMap((option) => (option instanceof z.ZodType ? valuePaths(option, prefix) : [prefix])))];
  }
  return [prefix];
};
