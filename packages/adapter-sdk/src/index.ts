// @ostra/adapter-sdk: the eight adapter base classes (ADR 0025), their capabilities, the registry
// and the shared plumbing. The contract suites are in `@ostra/adapter-sdk/testing`.
export * from "./common/result.ts";
export * from "./common/context.ts";

export * from "./plumbing/logger.ts";
export * from "./plumbing/stores.ts";
export * from "./plumbing/retry.ts";
export * from "./plumbing/rate-budget.ts";
export * from "./plumbing/idempotency.ts";
export * from "./plumbing/vendor.ts";
export * from "./plumbing/signature.ts";
export * from "./plumbing/web-socket-duplex.ts";

export * from "./tracker/capabilities.ts";
export * from "./tracker/base.ts";
export * from "./code-host/capabilities.ts";
export * from "./code-host/base.ts";
export * from "./code-host/tree.ts";
export * from "./code-host/tar.ts";
export * from "./agent/capabilities.ts";
export * from "./agent/base.ts";
export * from "./agent/permission-subject.ts";
export * from "./agent/plan-mode.ts";
export * from "./agent/repo-config.ts";
export * from "./agent/repo-skills.ts";
export { createAcpDriver } from "./agent/acp/driver.ts";
export type { AcpDriverOptions } from "./agent/acp/driver.ts";
export { createAcpMapper, toApprovalOptions } from "./agent/acp/map.ts";
export type { AcpMapper, LiveTextDelta } from "./agent/acp/map.ts";
export { descendantsOf, isAlive, killTree, listProcesses, sameProcess, watchProcessTree } from "./agent/acp/process-tree.ts";
export type { ProcessInfo, ProcessKey, TreeWatch } from "./agent/acp/process-tree.ts";
export * from "./executor/capabilities.ts";
export * from "./executor/base.ts";
export * from "./executor/app.ts";
export * from "./executor/checks.ts";
export * from "./executor/work-in-progress.ts";
export * from "./executor/box-files.ts";
export * from "./executor/commit-paths.ts";
export * from "./executor/task-token.ts";
export * from "./executor/egress-baseline.ts";
export * from "./model-provider/capabilities.ts";
export * from "./model-provider/base.ts";
export * from "./notification/capabilities.ts";
export * from "./notification/base.ts";
export * from "./secret-store/capabilities.ts";
export * from "./secret-store/base.ts";
export * from "./blob-store/capabilities.ts";
export * from "./blob-store/base.ts";

export * from "./model/sse.ts";
export * from "./model/usage.ts";
export * from "./model/auth.ts";

export * from "./registry.ts";
