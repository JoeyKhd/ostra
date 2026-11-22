import type { TaskId } from "@ostra/protocol";

// Milestone 10 (F-151, spec section 5.3, content fix 7): a step's paths read relative to the
// workspace, as a member thinks of them: `src/history/store.ts`, not the runner's
// `…\.ostra\runner\tasks\{taskId}\agent\calculator-web\src\history\store.ts` or the box's
// `/workspace/calculator-web/src/history/store.ts`. The full value stays the step's `fullSubject`
// (the row's `title`) and the Event log's. Pure: the panel and every test read the same rule.
//
// - `host`: everything up to and including `tasks/{taskId}/agent/`, with either separator.
// - `docker` and `kubernetes`: `/workspace/` (and nothing that only looks like it: `/workspaces/`).
// - Then, for a task with one repo, its checkout folder (`calculator-web/`).
// - A home folder (`/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`, `/root/`) is `~/`.

/** What the rule needs of the task: its ID (the `host` folder's name) and its repos' checkout folders in the workspace. */
export type WorkspaceContext = {
  readonly taskId: TaskId;
  /** Each repo's folder in the workspace (`calculator-web`); a task with one repo shows paths inside it. */
  readonly checkoutDirs: readonly string[];
};

/** The quotes and the shell's operators: with a space, what a path in a command line ends at, or starts after, when it isn't quoted. */
const MARKS = String.raw`"'\x60;|&<>()=,`;
const BOUNDARY = String.raw`\s${MARKS}`;
const PATH_CHAR = `[^${BOUNDARY}]`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** The `host` executor's workspace folder in a path: `…/tasks/{taskId}/agent`, then a separator or the end. */
const hostAnchor = (taskId: TaskId): string => String.raw`tasks[\\/]${escapeRegExp(taskId)}[\\/]agent(?:[\\/]|$)`;

/** A home folder at a path's start, with the separator after it or the end. */
const HOME = String.raw`(?:/home/[^/\\]+|/Users/[^/\\]+|[A-Za-z]:[\\/]Users[\\/][^/\\]+|/root)(?=[\\/]|$)`;

/**
 * A home folder in a command line: its user's name ends at a separator, a `:`
 * (`PATH=/home/sam:/usr/bin`) or its word's end (`ls /home/sam && …`), never in the next word. A
 * Windows name may hold a space (`C:\Users\Sam Rivera`): in a quoted value it runs to its separator;
 * unquoted, a space after it ends no home folder, and the path stays whole.
 */
const USER = String.raw`[^/\\:${BOUNDARY}]+`;
const POSIX_HOME = String.raw`(?:/home/${USER}|/Users/${USER}|/root)(?=[\\/:${BOUNDARY}]|$)`;
const LINE_HOME = String.raw`(?:${POSIX_HOME}|[A-Za-z]:[\\/]Users[\\/]${USER}(?=[\\/:${MARKS}]|$))`;
const QUOTED_HOME = new RegExp(String.raw`^(?:${POSIX_HOME}|[A-Za-z]:[\\/]Users[\\/][^/\\:]+(?=[\\/]|$))`);

/** Takes the one repo's checkout folder off a path inside the workspace (`calculator-web/src` → `src`). */
const insideRepo = (rest: string, checkoutDirs: readonly string[]): string => {
  const [only, ...others] = checkoutDirs;
  if (only === undefined || others.length > 0) return rest;
  if (rest === only) return ".";
  for (const separator of ["/", "\\"]) {
    if (rest.startsWith(`${only}${separator}`)) return rest.slice(only.length + 1);
  }
  return rest;
};

/** A path inside the workspace (what follows its prefix), relative, its separators as written or as `/`. */
const relativeRest = (rest: string, context: WorkspaceContext, slashes: boolean): string => {
  const relative = insideRepo(slashes ? rest.replaceAll("\\", "/") : rest, context.checkoutDirs);
  return relative === "" ? "." : relative;
};

/**
 * A path as a member reads it: relative to the workspace (the one repo's folder too, for a task with
 * one repo), or with its home folder as `~/`; any other path as it was. A path the rule shortens is
 * written with `/`, as git writes a repo's paths.
 */
export const workspacePath = (raw: string, context: WorkspaceContext): string => {
  const host = new RegExp(hostAnchor(context.taskId)).exec(raw);
  if (host !== null) return relativeRest(raw.slice(host.index + host[0].length), context, true);
  if (raw === "/workspace" || raw === "/workspace/") return ".";
  if (raw.startsWith("/workspace/")) return relativeRest(raw.slice("/workspace/".length), context, true);
  const home = new RegExp(`^${HOME}`).exec(raw);
  if (home !== null) {
    const rest = raw.slice(home[0].length).replaceAll("\\", "/");
    return rest === "" || rest === "/" ? "~" : `~${rest}`;
  }
  return raw;
};

/**
 * A command line as a member reads it: each path in it shortened as `workspacePath` does, quoted or
 * not, its separators as the agent wrote them. Everything else in the line stays as it was: it's the
 * agent's command, data, never run or parsed further.
 */
export const workspaceCommand = (line: string, context: WorkspaceContext): string => {
  const anchor = new RegExp(hostAnchor(context.taskId));
  /** What follows the task's folder in a path, relative; `null` when the folder isn't in it. */
  const hostRest = (path: string): string | null => {
    const found = anchor.exec(path);
    return found === null ? null : relativeRest(path.slice(found.index + found[0].length), context, false);
  };
  /** A quoted value, under the task's folder or starting with a home folder (`"C:\Users\Sam Rivera\…"`). */
  const quotedRest = (value: string): string => {
    const inTask = hostRest(value);
    if (inTask !== null) return inTask;
    const home = QUOTED_HOME.exec(value);
    return home === null ? value : `~${value.slice(home[0].length)}`;
  };
  // The line is the agent's, as long as it likes (a base64 blob in one word), so each pattern here
  // reads it in one pass: a quoted value or a word is taken whole, then searched for the `host`
  // folder; no pattern tries the folder at every start inside a word (that took minutes on a 1 MiB word).
  // A quoted path may hold spaces (`"C:\Users\Sam Rivera\…\agent\src"`); an unquoted one ends at a boundary.
  const quoted = /(["'])([^"']*)\1/g;
  const word = new RegExp(`${PATH_CHAR}+`, "g");
  const box = new RegExp(String.raw`(^|[${BOUNDARY}:])/workspace((?:/${PATH_CHAR}*)?)(?=$|[${BOUNDARY}])`, "g");
  const home = new RegExp(String.raw`(^|[${BOUNDARY}:])${LINE_HOME}`, "g");
  return line
    .replace(quoted, (_match, quote: string, value: string) => `${quote}${quotedRest(value)}${quote}`)
    .replace(word, (path) => hostRest(path) ?? path)
    .replace(box, (_match, before: string, rest: string) => `${before}${relativeRest(rest.replace(/^\//, ""), context, false)}`)
    .replace(home, (_match, before: string) => `${before}~`);
};
