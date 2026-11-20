// @ostra/runner: the `ostra` CLI. `main.ts` is the program; these are its parts, for tests and
// for the sidecar image.
export { runCli, exitCodes } from "./cli/cli.ts";
export type { CliDeps, RunSignedIn, RunSidecar } from "./cli/cli.ts";
export { RUNNER_VERSION } from "./version.ts";
// Milestone 5 (ticket 18): the connection on its own, for core's tests of the HTTP fallback against
// the real gateway, and the load test's simulated runners (ticket 34).
export { startConnection } from "./connection/peer.ts";
export type { CommandHandlers, CommandOutcome, ConnectionOptions, ConnectionReport, PeerStatus, RunnerConnection, SessionChannel, TokenSource } from "./connection/peer.ts";
export type { Carrier, FallbackReason, NetworkOptions, Transport } from "./connection/http-carrier.ts";
