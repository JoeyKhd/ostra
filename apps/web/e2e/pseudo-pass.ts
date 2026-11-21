// F-083 (ticket 20): the pseudo-locale pass as one command on every platform,
// `pnpm --filter @ostra/web test:e2e:pseudo`: the pseudo-locale build (`.next-pseudo`), then
// `e2e/pseudo-locale.spec.ts` on it (playwright.pseudo.config.ts). Arguments go to Playwright.
// A package script can't set OSTRA_PSEUDO_LOCALE itself, since Windows runs scripts in cmd.

import { spawn } from "node:child_process";
import path from "node:path";

const webDir = path.resolve(import.meta.dirname, "..");
const env = { ...process.env, OSTRA_PSEUDO_LOCALE: "1" };

const run = (command: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: webDir, env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });

const built = await run("pnpm", ["exec", "next", "build"]);
process.exitCode = built === 0 ? await run("pnpm", ["exec", "playwright", "test", "-c", "playwright.pseudo.config.ts", ...process.argv.slice(2)]) : built;
