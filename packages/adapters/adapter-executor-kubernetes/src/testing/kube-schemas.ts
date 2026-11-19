import { z } from "zod";

// What the fake Kubernetes API reads of the objects it's sent (ticket 06). Kubernetes owns the
// format, so every schema tolerates fields it doesn't name (AGENTS.md, Code). Test-only.

const quantitySchema = z.union([z.string(), z.number()]).transform((value) => String(value));

export const ownerReferenceSchema = z.looseObject({
  apiVersion: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  uid: z.string().min(1),
  controller: z.boolean().optional(),
  blockOwnerDeletion: z.boolean().optional(),
});
export type OwnerReference = z.infer<typeof ownerReferenceSchema>;

export const metadataInSchema = z.looseObject({
  name: z.string().optional(),
  generateName: z.string().optional(),
  namespace: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  ownerReferences: z.array(ownerReferenceSchema).optional(),
});

export const objectInSchema = z.looseObject({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  metadata: metadataInSchema.optional(),
});

const envVarSchema = z.looseObject({
  name: z.string().min(1),
  value: z.string().optional(),
  valueFrom: z
    .looseObject({
      secretKeyRef: z.looseObject({ name: z.string(), key: z.string(), optional: z.boolean().optional() }).optional(),
      fieldRef: z.looseObject({ fieldPath: z.string() }).optional(),
    })
    .optional(),
});

const resourcesSchema = z.looseObject({
  limits: z.record(z.string(), quantitySchema).optional(),
  requests: z.record(z.string(), quantitySchema).optional(),
});

export const containerSchema = z.looseObject({
  name: z.string(),
  image: z.string().optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  env: z.array(envVarSchema).optional(),
  envFrom: z.array(z.looseObject({ secretRef: z.looseObject({ name: z.string(), optional: z.boolean().optional() }).optional() })).optional(),
  volumeMounts: z.array(z.looseObject({ name: z.string(), mountPath: z.string(), subPath: z.string().optional(), readOnly: z.boolean().optional() })).optional(),
  /** Only `Always`, and only on an init container: a native sidecar (Kubernetes 1.29). */
  restartPolicy: z.string().optional(),
  resources: resourcesSchema.optional(),
});
export type FakeContainerSpec = z.infer<typeof containerSchema>;

export const volumeSchema = z.looseObject({
  name: z.string(),
  secret: z
    .looseObject({
      secretName: z.string(),
      items: z.array(z.looseObject({ key: z.string(), path: z.string() })).optional(),
      optional: z.boolean().optional(),
    })
    .optional(),
  emptyDir: z.looseObject({}).optional(),
});
export type FakeVolume = z.infer<typeof volumeSchema>;

export const podSpecSchema = z.looseObject({
  containers: z.array(containerSchema),
  initContainers: z.array(containerSchema).optional(),
  volumes: z.array(volumeSchema).optional(),
  restartPolicy: z.string().optional(),
  imagePullSecrets: z.array(z.looseObject({ name: z.string() })).optional(),
  serviceAccountName: z.string().optional(),
  automountServiceAccountToken: z.boolean().optional(),
  nodeName: z.string().optional(),
});
export type FakePodSpec = z.infer<typeof podSpecSchema>;

export const secretInSchema = z.looseObject({
  type: z.string().optional(),
  data: z.record(z.string(), z.string()).optional(),
  stringData: z.record(z.string(), z.string()).optional(),
});

/** A `kubernetes.io/dockerconfigjson` secret's one key, as kubelets read it. */
export const dockerConfigSchema = z.looseObject({
  auths: z.record(z.string(), z.looseObject({ username: z.string().optional(), password: z.string().optional(), auth: z.string().optional() })),
});

export const quotaSpecSchema = z.looseObject({ hard: z.record(z.string(), quantitySchema).optional() });

export const accessReviewSchema = z.looseObject({
  spec: z.looseObject({
    resourceAttributes: z
      .looseObject({
        namespace: z.string().optional(),
        verb: z.string().optional(),
        group: z.string().optional(),
        resource: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
  }),
});
