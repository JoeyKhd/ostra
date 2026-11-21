import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, type Browser } from "playwright-core";
import { z } from "zod";
import { startChild, stopAll } from "./procs.ts";

// Does a browser keep the preview's __Host- cookie (Secure) when the preview host is plain HTTP? On a name under
// .localhost (a secure context) and on a real-looking domain (mapped to loopback). Core alone is enough:
// /.ostra/enter sets the cookie and redirects to /.ostra/ok, which answers "ok" only with it.
// Usage: node src/harness/secure-cookie.ts <results folder>

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = process.argv[2] ?? path.join(root, "results");
const core = startChild("core", ["src/tunnel/core.ts", "--port", "8800"], { cwd: root, log: path.join(outDir, "secure-cookie-core.log"), readyText: "core listening" });
await core.ready;

const code = async () =>
  z.strictObject({ code: z.string() }).parse(await (await fetch("http://127.0.0.1:8800/control/code", { method: "POST", body: JSON.stringify({ port: 5173, previewId: "p1", layout: "cross-site" }) })).json()).code;

const launchers: [string, () => Promise<Browser>][] = [
  ["chrome", () => chromium.launch({ channel: "chromium", headless: true, args: ["--host-resolver-rules=MAP *.preview.example.test 127.0.0.1"] })],
  ["edge", () => chromium.launch({ channel: "msedge", headless: true, args: ["--host-resolver-rules=MAP *.preview.example.test 127.0.0.1"] })],
  ["firefox", () => firefox.launch({ headless: true, firefoxUserPrefs: { "network.dns.localDomains": "5173-p1.preview.example.test" } })],
];
try {
  for (const [name, launch] of launchers) {
    const browser = await launch();
    for (const host of ["5173-p1.preview.localhost:8800", "5173-p1.preview.example.test:8800"]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const outcome = await page
        .goto(`http://${host}/.ostra/enter?code=${await code()}&next=/.ostra/ok`, { timeout: 15_000 })
        .then(async () => ((await page.$("#ok")) !== null ? "kept: /.ostra/ok answered" : (await page.$("#no-cookie")) !== null ? "dropped: no preview cookie" : "other"))
        .catch((error: unknown) => `error: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : ""}`);
      const stored = (await context.cookies()).filter((cookie) => cookie.name === "__Host-ostra-preview").length;
      process.stdout.write(`${name} ${browser.version()} http://${host}: ${outcome}; cookies stored ${String(stored)}\n`);
      await context.close();
    }
    await browser.close();
  }
} finally {
  await stopAll();
}
