// @ostra/adapter-executor-docker: the `docker` executor (ADR 0029). The runner creates and removes
// boxes on the Engine API (`createDockerBoxes`); inside each box the sidecar runs the task with
// `DockerExecutor`, reaching the agent's container through the bridge to the box's init.
export { DockerExecutor } from "./docker-executor.ts";
export type { DockerExecutorOptions } from "./docker-executor.ts";
export { AGENT_UID, BRIDGE_PORT, boxResources, createDockerBoxes, DEFAULT_EGRESS_NETWORK, SIDECAR_DATA_DIR, SIDECAR_GID, SIDECAR_UID, TASK_ROOT, WAIT_POLL_MS } from "./boxes.ts";
export type { BoxImages, BoxInput, BoxOptions, BoxResources, ContainerSpec, CreatedDockerBox, DockerBoxes } from "./boxes.ts";
export { createEngine, engineAddressFrom, ENGINE_API_VERSION } from "./engine.ts";
export type { Engine, EngineAddress, EngineError, EngineResult } from "./engine.ts";
export { BLOCKED_V4, BLOCKED_V6, egressRules, METADATA_ADDRESS } from "./egress.ts";
export type { EgressInput } from "./egress.ts";
export { listenForInit } from "./bridge/bridge-server.ts";
export type { Bridge, BridgeListener, BridgeListenOptions } from "./bridge/bridge-server.ts";
export { bridgeProcesses } from "./bridge-processes.ts";
export { initEnvSchema, runInit } from "./init/init.ts";
// Milestone 3 (ticket 14): snapshots built and kept on the pool runner's Docker, and the services' health report.
export { SERVICES_HEALTHY_WITHIN_MS } from "./boxes.ts";
export type { BoxService } from "./boxes.ts";
export { awaitServicesFile, SERVICES_FILE, servicesFileSchema, servicesFileText, SIDECAR_SERVICES_FILE, writeServicesFile } from "./services-file.ts";
export { createDockerSnapshots, dockerCliBuilder } from "./snapshot/snapshots.ts";
export type { DockerSnapshots, DockerSnapshotsOptions, SnapshotBuilder, SnapshotGit } from "./snapshot/snapshots.ts";
export { planSnapshotBuild, snapshotTag } from "./snapshot/dockerfile.ts";
export { scanImageArchive } from "./snapshot/image-scan.ts";
