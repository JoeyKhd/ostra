// @ostra/adapter-executor-kubernetes: the `kubernetes` executor (ADR 0029, ADR 0060). A box is one
// pod (`pod.ts`), made and deleted by `KubernetesExecutor` through the `KubeApi` port; ticket 06 made
// the package and its test seams (`./testing`).
export { KUBERNETES_MIN_MINOR, KubernetesExecutor, NEEDED_ACCESS } from "./kubernetes-executor.ts";
export type { BoxWaitFailure, Clock, InBox, KubernetesExecutorOptions } from "./kubernetes-executor.ts";
export { createKubeApi, inClusterKubeConfig, kubeConfigFromString, kubeErr, kubeOk, podView, policyView } from "./kube-api.ts";
export type { AccessAttributes, ContainerView, EventView, KubeApi, KubeResult, NetworkPolicyView, PodPhase, PodView, QuotaView } from "./kube-api.ts";
export {
  agentImageOf,
  AGENT_UID,
  BOX_ROLE,
  boxLabels,
  boxNames,
  boxObjects,
  boxSelector,
  BRIDGE_PORT,
  dnsPart,
  LABELS,
  labelValue,
  NONCE_KEY,
  registryHostOf,
  resourcesOf,
  SIDECAR_DATA_DIR,
  SIDECAR_UID,
  TASK_ROOT,
  TOKEN_DIR,
  TOKEN_FILE,
  TOKEN_KEY,
} from "./pod.ts";
export type { BoxObjects, BoxPodInput, PodImages, PodSettings } from "./pod.ts";
export { cpuMillisOf, cpuQuantity, memoryMiBOf, memoryQuantity } from "./quantity.ts";
