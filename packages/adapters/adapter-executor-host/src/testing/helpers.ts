// The processes ticket 42's cases start: an agent that detaches a helper, and a setup script that
// leaves a daemon running.

/**
 * What every process of the helper's chain runs first: it waits until its parent is gone, then
 * calls `then`. Gone means its stdin, a pipe the parent holds, ended (the parent exited), and on
 * POSIX that the kernel has reparented it as well (`/proc/self/stat` on Linux; elsewhere, the
 * parent's PID is no longer in use). Windows keeps a dead parent's PID as the parent's, so the end
 * of the pipe is all it has. The parent's PID is the program's first argument.
 */
const afterParentGone = [
  "const parent = Number(process.argv[1]);",
  "const reparented = () => {",
  "  if (process.platform === 'win32') return true;",
  "  try {",
  "    const stat = require('node:fs').readFileSync('/proc/self/stat', 'utf8');",
  "    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== parent;",
  "  } catch {",
  "    try { process.kill(parent, 0); return false; } catch (error) { return error.code === 'ESRCH'; }",
  "  }",
  "};",
  "const afterParentGone = (then) => {",
  "  process.stdin.on('error', () => {});",
  "  process.stdin.once('end', function poll() { if (reparented()) { then(); } else { setTimeout(poll, 10); } });",
  "  process.stdin.resume();",
  "};",
].join("\n");

/** Starts `program` detached (`setsid` on POSIX, a new process group and no console on Windows), its stdin a pipe this process holds. */
const spawnDetached = (program: string, env: string): string =>
  `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(program)}, String(process.pid)], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: ${env}, windowsHide: true }).unref();`;

/** A go-between: once its parent is gone, it starts `child` and exits. */
const goBetween = (child: string, env: string): string => `${afterParentGone}\nafterParentGone(() => { ${spawnDetached(child, env)} process.exit(0); });`;

/**
 * An agent whose helper ends up with no live parent, and was never seen with one the agent's tree
 * reaches: the agent starts a detached go-between and exits; it starts a second one and exits; that
 * one starts the helper, detached too, and exits. Each starts its child only once its own parent
 * is gone, and the helper writes its PID to `pidFile` only once its parent is gone too. So by the
 * time the PID is read, every process between the agent and the helper has exited, and the helper
 * was born after the last link from the agent's tree to it was cut: no walk of the tree, now or
 * from any snapshot, reaches it, on Windows either, whose processes keep the PID of a dead parent.
 * With `clearEnv`, the helper also starts with an empty environment: it carries no marker.
 */
export const detachedHelperScript = (pidFile: string, options: { readonly clearEnv?: boolean } = {}): string => {
  const helperEnv = options.clearEnv === true ? "process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}" : "process.env";
  const helper = `${afterParentGone}\nafterParentGone(() => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); });`;
  const second = goBetween(helper, helperEnv);
  const first = goBetween(second, "process.env");
  return `${spawnDetached(first, "process.env")}\nprocess.exit(0);`;
};

/** The daemon's program: it writes its own PID to `pidFile` and runs until it's ended. */
export const daemonProgram = (pidFile: string): string =>
  `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`;

/** A forward-slash path, as bash on every system reads it. */
const posix = (file: string): string => file.split("\\").join("/");

/**
 * A setup script that starts `node daemonFile` in the background and exits: the daemon's stdio goes
 * nowhere, as a daemon's does, so the script's own end isn't held by it.
 */
export const daemonSetupScript = (nodePath: string, daemonFile: string): string =>
  `"${posix(nodePath)}" "${posix(daemonFile)}" > /dev/null 2>&1 < /dev/null &\necho started\n`;
