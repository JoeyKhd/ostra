import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import type { BoxRef, ExecutorAdapter } from "@ostra/adapter-sdk";

// A stdio MCP server's command (ticket 29, ADR 0049, Q170): the agent starts it as its own child,
// with the spec's command and variables, so it must already be in the box. The runner refuses a
// server whose command isn't on the box's `PATH` before the agent starts, naming the server. On
// `host` the box is this machine, and the launch's own `PATH` is searched here; in a container the
// agent's container answers, through the executor, with `command -v` given the command as an
// argument, never inside a shell line.

/** The launch environment's `PATH`, whatever its case (Windows writes `Path`). */
const pathOf = (env: Readonly<Record<string, string>>): string => {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
};

const isFile = async (file: string, windows: boolean): Promise<boolean> => {
  try {
    const found = await stat(file);
    if (!found.isFile()) {
      return false;
    }
    if (!windows) {
      await access(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
};

/** Whether `command` names a program the launch's `PATH` finds on this machine, or an absolute path to one. */
export const commandOnLocalPath = async (command: string, env: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): Promise<boolean> => {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const extensions = windows
    ? ["", ...(Object.entries(env).find(([name]) => name.toUpperCase() === "PATHEXT")?.[1] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")]
    : [""];
  const candidates = (base: string): readonly string[] =>
    windows && paths.extname(base) === "" ? extensions.map((ext) => `${base}${ext}`) : [base];
  if (paths.isAbsolute(command)) {
    for (const candidate of candidates(command)) {
      if (await isFile(candidate, windows)) {
        return true;
      }
    }
    return false;
  }
  // A relative path names a file in some folder the agent happens to be in: never a program on PATH.
  if (command.includes("/") || (windows && command.includes("\\"))) {
    return false;
  }
  for (const dir of pathOf(env).split(windows ? ";" : ":").filter((entry) => entry !== "")) {
    for (const candidate of candidates(paths.join(dir, command))) {
      if (await isFile(candidate, windows)) {
        return true;
      }
    }
  }
  return false;
};

/** Whether the box can run `command`: here on `host`, in the agent's container elsewhere. */
export const commandInBox = async (input: {
  readonly executor: ExecutorAdapter;
  readonly box: BoxRef;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}): Promise<boolean> => {
  if (input.executor.name === "host") {
    return commandOnLocalPath(input.command, input.env);
  }
  const checked = await input.executor.runAgentCommand({
    box: input.box,
    command: { command: "sh", args: ["-c", 'command -v -- "$1" >/dev/null', "ostra-path-check", input.command], env: { PATH: pathOf(input.env) }, cwd: input.cwd },
    timeoutMs: 15_000,
  });
  return checked.ok && checked.value.exitCode === 0;
};
