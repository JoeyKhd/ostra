import { parseRunnerConfig, runnerConfigFields } from "@ostra/protocol";
import type { RunnerConfig } from "@ostra/protocol";
import { checkOwnerOnly } from "../identity/owner-only.ts";
import { dataPaths, defaultDataDir, loadIdentity, loadStatus } from "../identity/store.ts";
import { signIn } from "../sign-in.ts";
import type { SignInInput, SignedIn } from "../sign-in.ts";
import { RUNNER_VERSION } from "../version.ts";
import { parseArgv } from "./argv.ts";
import { helpText } from "./help.ts";
import type { Terminal } from "./terminal.ts";

// The `ostra` CLI (ADR 0046): one program that is the runner, the sidecar, and later `login` and
// `checkout`. `runCli` returns the exit code; `main.ts` wires it to the process.

export const exitCodes = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** The server refused this runner for good (revoked): restarting won't help. */
  refused: 3,
} as const;

/** What `ostra runner` does once it's signed in: connect and take tasks (ticket 16, ticket 21). */
export type RunSignedIn = (input: {
  readonly signedIn: SignedIn;
  readonly config: RunnerConfig;
  readonly dataDir: string;
  readonly terminal: Terminal;
  readonly signal: AbortSignal;
}) => Promise<number>;

/** What `ostra sidecar` does (ticket 22). */
export type RunSidecar = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly terminal: Terminal;
  readonly signal: AbortSignal;
}) => Promise<number>;

export type CliDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly terminal: Terminal;
  /** Aborted when the person presses Ctrl-C. */
  readonly signal: AbortSignal;
  readonly runSignedIn: RunSignedIn;
  readonly runSidecar: RunSidecar;
  /** For tests: the device flow's waits. */
  readonly deviceFlow?: SignInInput["deviceFlow"];
  readonly now?: () => number;
};

const dataDirOf = (flags: Readonly<Record<string, string>>, env: CliDeps["env"]): string =>
  flags[runnerConfigFields.dataDir.flag] ?? env[runnerConfigFields.dataDir.env] ?? defaultDataDir();

const formatTime = (ms: number): string => new Date(ms).toISOString();

const runnerStatus = async (dataDir: string, terminal: Terminal): Promise<number> => {
  const identity = await loadIdentity(dataDir);
  const status = await loadStatus(dataDir);
  terminal.say(`Data folder     ${dataDir}`);
  switch (identity.kind) {
    case "none":
      terminal.say("Runner          not signed in (start `ostra runner` to sign in)");
      break;
    case "broken":
      terminal.say(`Runner          damaged identity: ${identity.message}`);
      break;
    case "found": {
      const { record } = identity.identity;
      const key = await checkOwnerOnly(dataPaths(dataDir).privateKey);
      terminal.say(`Runner          ${record.runnerId} (${record.kind}, ${record.name})`);
      terminal.say(`Server          ${record.serverUrl}`);
      terminal.say(`Registered      ${formatTime(record.registeredAt)}`);
      terminal.say(`Key file        ${key.ownerOnly ? "owner-only" : `NOT owner-only: ${key.reason}`}`);
      break;
    }
    default:
      return identity satisfies never;
  }
  const window = status.versionWindow;
  terminal.say(`This runner     ostra ${RUNNER_VERSION}`);
  terminal.say(
    window === null
      ? "Version window  unknown (no contact yet)"
      : `Version window  protocol ${String(window.protocolMajor)}.${String(window.min)} to ${String(window.protocolMajor)}.${String(window.max)} (server ostra ${window.serverVersion})`,
  );
  terminal.say(`Last connected  ${status.lastConnectedAt === null ? "never" : formatTime(status.lastConnectedAt)}`);
  terminal.say(
    status.lastRefusal === null
      ? "Last refusal    none"
      : `Last refusal    ${formatTime(status.lastRefusal.at)} ${status.lastRefusal.reason}: ${status.lastRefusal.message}`,
  );
  return exitCodes.ok;
};

const startRunner = async (flags: Readonly<Record<string, string>>, deps: CliDeps): Promise<number> => {
  const parsed = parseRunnerConfig({ flags, env: deps.env });
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      deps.terminal.warn(`ostra runner: ${error}`);
    }
    return exitCodes.usage;
  }
  const config = parsed.config;
  const dataDir = config.dataDir ?? defaultDataDir();
  const signedIn = await signIn({
    config,
    dataDir,
    terminal: deps.terminal,
    signal: deps.signal,
    ...(deps.deviceFlow === undefined ? {} : { deviceFlow: deps.deviceFlow }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (!signedIn.ok) {
    deps.terminal.warn(signedIn.failure.message);
    return signedIn.failure.reason === "revoked" ? exitCodes.refused : exitCodes.failed;
  }
  return deps.runSignedIn({ signedIn: signedIn.value, config, dataDir, terminal: deps.terminal, signal: deps.signal });
};

export const runCli = async (args: readonly string[], deps: CliDeps): Promise<number> => {
  const parsed = parseArgv(args);
  if (!parsed.ok) {
    deps.terminal.warn(`ostra: ${parsed.error}`);
    return exitCodes.usage;
  }
  const { words, flags, switches } = parsed.argv;
  if (switches.has("version")) {
    deps.terminal.say(RUNNER_VERSION);
    return exitCodes.ok;
  }
  const [command, sub, ...rest] = words;
  if (switches.has("help") || command === undefined || command === "help") {
    deps.terminal.say(helpText());
    return command === undefined && !switches.has("help") ? exitCodes.usage : exitCodes.ok;
  }
  switch (command) {
    case "runner":
      if (sub === undefined) {
        return startRunner(flags, deps);
      }
      if (sub === "status" && rest.length === 0) {
        return runnerStatus(dataDirOf(flags, deps.env), deps.terminal);
      }
      deps.terminal.warn(`ostra runner: unknown command "${sub}". Try \`ostra --help\`.`);
      return exitCodes.usage;
    case "sidecar":
      return deps.runSidecar({ env: deps.env, terminal: deps.terminal, signal: deps.signal });
    case "login":
    case "checkout":
      deps.terminal.warn(`ostra ${command} isn't available yet: it comes with local checkout (F-103).`);
      return exitCodes.usage;
    default:
      deps.terminal.warn(`ostra: unknown command "${command}". Try \`ostra --help\`.`);
      return exitCodes.usage;
  }
};
