// @ostra/runner: the `ostra` CLI. `main.ts` is the program; these are its parts, for tests and
// for the sidecar image.
export { runCli, exitCodes } from "./cli/cli.ts";
export type { CliDeps, RunSignedIn, RunSidecar } from "./cli/cli.ts";
export { RUNNER_VERSION } from "./version.ts";
// Milestone 5 (ticket 18): the connection on its own, for core's tests of the HTTP fallback against
// the real gateway, and the load test's simulated runners (ticket 34).
export { startConnection } from "./connection/peer.ts";
export type { CommandHandlers, CommandOutcome, ConnectionHooks, ConnectionOptions, ConnectionReport, PeerStatus, RunnerConnection, SessionChannel, SessionRef, TokenSource } from "./connection/peer.ts";
export type { Carrier, FallbackReason, NetworkOptions, Transport } from "./connection/http-carrier.ts";
// Milestone 5 (ticket 19): the whole `ostra runner` start, for core's test of a pool runner's join,
// approval and reports against the real gateway.
export { runSignedInRunner } from "./run-runner.ts";
export { createCapturingTerminal } from "./cli/terminal.ts";
export type { Terminal } from "./cli/terminal.ts";
// Ticket 34: what a simulated runner needs to join like a real one: its key pair, `register` with a
// join token, and its access tokens. No behaviour changes; the load test's runners are these.
export { generateRunnerKeyPair } from "./identity/key-pair.ts";
export type { RunnerKeyPair } from "./identity/key-pair.ts";
export { register } from "./server/register.ts";
export type { RegisterInput, RegisterProof } from "./server/register.ts";
export { createAccessTokens } from "./server/access-token.ts";
export type { AccessTokens, AccessTokensInput } from "./server/access-token.ts";
export type { CallFailure, CallResult } from "./server/http.ts";
