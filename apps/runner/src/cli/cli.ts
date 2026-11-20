import { readFile } from "node:fs/promises";
import { parseRunnerConfig, runnerConfigFields } from "@ostra/protocol";
import type { RunnerConfig, RunnerInstall } from "@ostra/protocol";
import { fallbackReasonWords } from "../connection/http-carrier.ts";
import { checkOwnerOnly } from "../identity/owner-only.ts";
import { dataPaths, defaultDataDir, loadIdentity, loadStatus } from "../identity/store.ts";
import { applyPin, PIN_REEXEC_ENV } from "../pin.ts";
import type { PinInput } from "../pin.ts";
import { poolStatusLine } from "../pool-approval.ts";
import { detectInstall, programPath, reservedLabelsMessage, reservedLabelsOf } from "../reports.ts";
import { fetchInfo } from "../server/info.ts";
import { signIn } from "../sign-in.ts";
import type { SignInInput, SignedIn } from "../sign-in.ts";
import { RUNNER_VERSION } from "../version.ts";
import { parseArgv } from "./argv.ts";
import { runCheckout } from "./checkout.ts";
import { helpText } from "./help.ts";
import { runLogin, runLogout } from "./login.ts";
import type { CliOutcome } from "./login.ts";
import type { Terminal } from "./terminal.ts";

// The `ostra` CLI (ADR 0046): one program that is the runner, the sidecar, and a member's `login`,
// `checkout` and `logout` (F-103, ADR 0051). `runCli` returns the exit code; `main.ts` wires it to
// the process.

export const exitCodes = {
  ok: 0,
  failed: 1,
  usage: 2,
  /**
   * The server refused this runner for good: revoked, or a key it doesn't know. Restarting won't
   * help; signing in again with a new identity will. A refusal that can pass, such as clocks that
   * disagree, never ends the runner.
   */
  refused: 3,
} as const;

/** What `ostra runner` does once it's signed in: connect and take tasks (ticket 16, ticket 21). */
export type RunSignedIn = (input: {
  readonly signedIn: SignedIn;
  readonly config: RunnerConfig;
  readonly dataDir: string;
  readonly terminal: Terminal;
  readonly signal: AbortSignal;
  /** How this CLI was installed (milestone 5): reported in `hello` and `status`. */
  readonly install: RunnerInstall;
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
  /** How this CLI was installed; detected from its program's path by default. */
  readonly install?: RunnerInstall;
  /** For tests: the pin's npm, its re-run and its fetch. */
  readonly pin?: Pick<PinInput, "npm" | "reexec" | "fetch">;
  /** For tests: `login`'s waits, the machine's name, and where `checkout` looks without `--dir`. */
  readonly local?: {
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly machineName?: string;
    readonly cwd?: string;
  };
};

const exitOf = (outcome: CliOutcome): number => {
  if (outcome.ok) {
    return exitCodes.ok;
  }
  return outcome.usage === true ? exitCodes.usage : exitCodes.failed;
};

const dataDirOf = (flags: Readonly<Record<string, string>>, env: CliDeps["env"]): string =>
  flags[runnerConfigFields.dataDir.flag] ?? env[runnerConfigFields.dataDir.env] ?? defaultDataDir();

const formatTime = (ms: number): string => new Date(ms).toISOString();

const runnerStatus = async (dataDir: string, terminal: Terminal, install: RunnerInstall): Promise<number> => {
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
  terminal.say(`This runner     ostra ${RUNNER_VERSION} (from ${install})`);
  terminal.say(
    window === null
      ? "Version window  unknown (no contact yet)"
      : `Version window  protocol ${String(window.protocolMajor)}.${String(window.min)} to ${String(window.protocolMajor)}.${String(window.max)} (server ostra ${window.serverVersion})`,
  );
  terminal.say(`Last connected  ${status.lastConnectedAt === null ? "never" : formatTime(status.lastConnectedAt)}`);
  const carrier = status.carrier ?? null;
  terminal.say(
    carrier === null
      ? "Carrier         unknown (no connection yet)"
      : carrier.carrier === "websocket"
        ? "Carrier         WebSocket"
        : `Carrier         HTTP${carrier.fallback === null ? " (--transport http)" : `, fell back because ${fallbackReasonWords[carrier.fallback]}`}`,
  );
  // Milestone 5 (ticket 19, F-091): a pool runner's pool, and whether it waits for an admin.
  const poolLine = poolStatusLine(status.pool ?? null);
  if (poolLine !== null) {
    terminal.say(poolLine);
  }
  terminal.say(
    status.lastRefusal === null
      ? "Last refusal    none"
      : `Last refusal    ${formatTime(status.lastRefusal.at)} ${status.lastRefusal.reason}: ${status.lastRefusal.message}`,
  );
  return exitCodes.ok;
};

/**
 * A pool runner's join token from a file (`OSTRA_JOIN_TOKEN_FILE`), as the compose file's runner
 * reads the bootstrap token core writes at first start. `--join-token` wins.
 */
const withJoinTokenFile = async (config: RunnerConfig): Promise<RunnerConfig | string> => {
  if (config.joinToken !== undefined || config.joinTokenFile === undefined) {
    return config;
  }
  try {
    const token = (await readFile(config.joinTokenFile, "utf8")).trim();
    return token.length > 0 ? { ...config, joinToken: token } : `OSTRA_JOIN_TOKEN_FILE (${config.joinTokenFile}) is empty`;
  } catch {
    return `can't read OSTRA_JOIN_TOKEN_FILE (${config.joinTokenFile})`;
  }
};

const startRunner = async (flags: Readonly<Record<string, string>>, deps: CliDeps, args: readonly string[]): Promise<number> => {
  const parsed = parseRunnerConfig({ flags, env: deps.env });
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      deps.terminal.warn(`ostra runner: ${error}`);
    }
    return exitCodes.usage;
  }
  const withToken = await withJoinTokenFile(parsed.config);
  if (typeof withToken === "string") {
    deps.terminal.warn(`ostra runner: ${withToken}`);
    return exitCodes.usage;
  }
  const config = withToken;
  // Milestone 5 (ticket 19): ostra sets `executor:`, `os:` and `arch:` itself.
  const reserved = reservedLabelsOf(config.labels);
  if (reserved.length > 0) {
    deps.terminal.warn(`ostra runner: ${reservedLabelsMessage(reserved)}`);
    return exitCodes.usage;
  }
  const dataDir = config.dataDir ?? defaultDataDir();
  // The pin (ticket 19, F-061): an npm install runs the server's version when it differs.
  const install = deps.install ?? detectInstall(programPath(), deps.env);
  if (install === "npm" && config.pin && deps.env[PIN_REEXEC_ENV] === undefined) {
    const info = await fetchInfo(config.serverUrl, deps.signal);
    const known = info.ok ? info.info : info.reason === "version" ? info.info : null;
    if (known !== null) {
      const pinned = await applyPin({
        info: known,
        install,
        version: RUNNER_VERSION,
        enabled: config.pin,
        registryOverride: flags[runnerConfigFields.npmRegistry.flag] ?? deps.env[runnerConfigFields.npmRegistry.env] ?? null,
        dataDir,
        args,
        env: deps.env,
        logger: deps.terminal.logger,
        ...deps.pin,
      });
      if (pinned.kind === "ran") {
        return pinned.exitCode;
      }
      if (pinned.reason === "integrity") {
        deps.terminal.warn(`The server's version ${known.serverVersion} failed its integrity check and wasn't run. This version starts instead.`);
      }
    }
  }
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
    const reason = signedIn.failure.reason;
    return reason === "revoked" || reason === "unknown-key" ? exitCodes.refused : exitCodes.failed;
  }
  return deps.runSignedIn({ signedIn: signedIn.value, config, dataDir, terminal: deps.terminal, signal: deps.signal, install });
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
        return startRunner(flags, deps, args);
      }
      if (sub === "status" && rest.length === 0) {
        return runnerStatus(dataDirOf(flags, deps.env), deps.terminal, deps.install ?? detectInstall(programPath(), deps.env));
      }
      deps.terminal.warn(`ostra runner: unknown command "${sub}". Try \`ostra --help\`.`);
      return exitCodes.usage;
    case "sidecar":
      return deps.runSidecar({ env: deps.env, terminal: deps.terminal, signal: deps.signal });
    case "login":
    case "logout":
    case "checkout": {
      const local = {
        env: deps.env,
        terminal: deps.terminal,
        signal: deps.signal,
        ...(deps.local?.sleep === undefined ? {} : { sleep: deps.local.sleep }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.local?.machineName === undefined ? {} : { machineName: deps.local.machineName }),
        ...(deps.local?.cwd === undefined ? {} : { cwd: deps.local.cwd }),
      };
      if (command === "checkout") {
        if (rest.length > 0) {
          deps.terminal.warn("ostra checkout: one task at a time: `ostra checkout <task> [--dir <folder>]`.");
          return exitCodes.usage;
        }
        return exitOf(await runCheckout(sub, flags, local));
      }
      if (sub !== undefined) {
        deps.terminal.warn(`ostra ${command}: unexpected "${sub}". Try \`ostra --help\`.`);
        return exitCodes.usage;
      }
      return exitOf(command === "login" ? await runLogin(flags, local) : await runLogout(local));
    }
    default:
      deps.terminal.warn(`ostra: unknown command "${command}". Try \`ostra --help\`.`);
      return exitCodes.usage;
  }
};
