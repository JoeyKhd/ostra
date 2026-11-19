import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

// A stand-in for `sudo` in the agent user's tests (ticket 10), on a machine without a second user:
// it checks the arguments are `-n -u <user> [--preserve-env=<names>] -- <command> <args...>`, writes
// what it was asked to a log (the user, the preserved names, the command and its arguments, never
// a variable's value), then runs the command as this user with the environment it was given. A
// call in any other shape exits 64 and runs nothing.
//
//   node fake-sudo.ts <log file> -n -u <user> [--preserve-env=A,B] -- <command> [args...]

const [log, ...argv] = process.argv.slice(2);
const refuse = (why: string): never => {
  process.stderr.write(`fake sudo: ${why}\n`);
  process.exit(64);
};
if (log === undefined) refuse("no log file");
if (argv[0] !== "-n" || argv[1] !== "-u" || argv[2] === undefined) refuse("not -n -u <user>");
const user = argv[2] ?? "";
let at = 3;
let preserve: readonly string[] = [];
if (argv[at]?.startsWith("--preserve-env=") === true) {
  preserve = (argv[at] ?? "").slice("--preserve-env=".length).split(",");
  at += 1;
}
if (argv[at] !== "--") refuse("no -- before the command");
const command = argv[at + 1];
if (command === undefined) refuse("no command");
const args = argv.slice(at + 2);
await appendFile(log ?? "", `${JSON.stringify({ user, preserve, command, args })}\n`);
const child = spawn(command ?? "", args, { stdio: "inherit", env: process.env, windowsHide: true });
child.once("error", () => process.exit(127));
child.once("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
