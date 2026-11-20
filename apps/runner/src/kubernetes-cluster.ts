import { readFile } from "node:fs/promises";
import { createKubeApi, inClusterKubeConfig, kubeConfigFromString } from "@ostra/adapter-executor-kubernetes";
import type { KubeApi } from "@ostra/adapter-executor-kubernetes";

// Where a `kubernetes` pool runner's cluster is (milestone 5, ticket 20, ADR 0060). In the cluster,
// the runner's pod has its service account's token and CA; for development (`pnpm dev:fake-kube`)
// and a runner outside the cluster, `KUBECONFIG` names a kubeconfig file. Its namespace is
// `OSTRA_K8S_NAMESPACE`, else the service account's, else the kubeconfig's context's.

/** The service account's own namespace, inside a pod. */
const SERVICE_ACCOUNT_NAMESPACE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export type KubernetesCluster = { readonly kube: KubeApi; readonly namespace: string };

export const kubernetesCluster = async (
  setting: { readonly namespace: string | undefined },
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly ok: true; readonly value: KubernetesCluster } | { readonly ok: false; readonly reason: string }> => {
  const file = env["KUBECONFIG"];
  try {
    const config = file === undefined || file === "" ? inClusterKubeConfig() : kubeConfigFromString(await readFile(file, "utf8"));
    let namespace = setting.namespace;
    if (namespace === undefined && (file === undefined || file === "")) {
      namespace = (await readFile(SERVICE_ACCOUNT_NAMESPACE, "utf8").catch(() => "")).trim() || undefined;
    }
    namespace ??= config.getContextObject(config.getCurrentContext())?.namespace ?? undefined;
    if (namespace === undefined || namespace === "") {
      return { ok: false, reason: "The kubernetes executor needs a namespace for its boxes: set OSTRA_K8S_NAMESPACE." };
    }
    return { ok: true, value: { kube: createKubeApi(config), namespace } };
  } catch {
    return {
      ok: false,
      reason:
        file === undefined || file === ""
          ? "The kubernetes executor runs in the cluster, with its pod's service account, or with KUBECONFIG naming a kubeconfig file; neither is here."
          : "The kubeconfig KUBECONFIG names can't be read.",
    };
  }
};
