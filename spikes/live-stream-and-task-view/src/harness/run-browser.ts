import { parseArgs } from "node:util";
import { z } from "zod";
import { browserChecks, sessionNames } from "./checks-browser.ts";
import { startContext } from "./context.ts";
import { printCriteria } from "./report.ts";

// Just the browser checks: `pnpm check:browser` (build the page first: `pnpm build:web`).
// `--only latency,render` runs some of the sessions: ui, live, drop-cut, drop-blackhole, render, latency, recordings.
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { only: { type: "string" } } });
const only = values.only === undefined ? null : new Set(z.array(z.enum(sessionNames)).parse(values.only.split(",")));

const ctx = await startContext();
try {
  const result = await browserChecks(ctx, only);
  printCriteria(result.criteria);
  for (const f of result.findings) process.stdout.write(`
finding: ${f.topic}
  ${f.text}
`);
} finally {
  await ctx.stop();
}
