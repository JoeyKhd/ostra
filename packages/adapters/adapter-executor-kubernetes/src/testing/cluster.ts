import { CoreV1Api } from "@kubernetes/client-node";

import { createKubeApi, kubeConfigFromString } from "../kube-api.ts";
import type { KubeApi } from "../kube-api.ts";
import { startFakeKubeApi } from "./fake-api.ts";
import type { FakeKubeApi, FakeKubeOptions } from "./fake-api.ts";

// A fake cluster for the executor's tests and the runner's (ticket 07): ticket 06's fake API with
// the box namespace (and any other) made, and the executor's `KubeApi` port over it through
// `@kubernetes/client-node`, unmodified. Test and dev only.

export type FakeCluster = {
  readonly fake: FakeKubeApi;
  /** The port, as the executor talks to the fake. */
  readonly kube: KubeApi;
  readonly kubeconfig: string;
  /** Makes a namespace, as the runner chart does. */
  readonly createNamespace: (name: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export const startFakeCluster = async (options: FakeKubeOptions & { readonly namespaces?: readonly string[] } = {}): Promise<FakeCluster> => {
  // Under a full machine's parallel test files, a fresh fake's first TLS handshake was seen to fail
  // its verification once (UNABLE_TO_VERIFY_LEAF_SIGNATURE): a fake that can't be reached is
  // replaced, up to three times, before the test sees it.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startOnce(options);
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
};

const startOnce = async (options: FakeKubeOptions & { readonly namespaces?: readonly string[] }): Promise<FakeCluster> => {
  const fake = await startFakeKubeApi(options);
  const kubeconfig = fake.kubeconfig(options.namespaces?.[0] ?? "default");
  const config = kubeConfigFromString(kubeconfig);
  const core = config.makeApiClient(CoreV1Api);
  const createNamespace = async (name: string): Promise<void> => {
    await core.createNamespace({ body: { metadata: { name, labels: { "kubernetes.io/metadata.name": name } } } });
  };
  try {
    for (const name of options.namespaces ?? []) await createNamespace(name);
  } catch (error) {
    await fake.close();
    throw error;
  }
  return { fake, kube: createKubeApi(config), kubeconfig, createNamespace, close: () => fake.close() };
};
