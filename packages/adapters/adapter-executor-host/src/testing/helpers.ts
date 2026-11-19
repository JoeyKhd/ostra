// The processes ticket 42's cases start: an agent that detaches a helper, and a setup script that
// leaves a daemon running.

/**
 * An agent whose helper ends up with no live parent: the agent starts a detached go-between
 * (`setsid` on POSIX, a new process group and no console on Windows), which starts the helper,
 * detached too, writes the helper's PID to `pidFile` and exits. With `exitAtOnce` the agent exits at
 * once as well. The helper's parent and grandparent are then gone, so no walk of the agent's tree
 * reaches it, on Windows either, whose processes keep the PID of a dead parent. With `clearEnv`,
 * the helper also starts with an empty environment: it carries no marker.
 */
export const detachedHelperScript = (pidFile: string, options: { readonly exitAtOnce: boolean; readonly clearEnv?: boolean }): string => {
  const helperEnv = options.clearEnv === true ? "process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}" : "process.env";
  const goBetween = [
    "const { spawn } = require('node:child_process');",
    `const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: ${helperEnv}, windowsHide: true });`,
    "helper.unref();",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));`,
    "process.exit(0);",
  ].join("\n");
  return [
    "const { spawn } = require('node:child_process');",
    `const goBetween = spawn(process.execPath, ['-e', ${JSON.stringify(goBetween)}], { detached: true, stdio: 'ignore', windowsHide: true });`,
    "goBetween.unref();",
    options.exitAtOnce ? "process.exit(0);" : "setInterval(() => {}, 1000);",
  ].join("\n");
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
