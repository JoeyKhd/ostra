// Runs the attack checklist from inside the agent's container and prints a
// line per check (or, with --json, the report the harness parses). Exits 1 if
// anything is EXPOSED or a service is UNREACHABLE, so the harness and CI gate
// on it. The base image has this as `/opt/ostra/bin/attack`.
//
//   attack --json --config-stdin < config.json
//
// With --config-stdin the config (markers included) is read from stdin, so no
// secret marker is ever in this process's environment or argv. Without it,
// the non-secret config comes from OSTRA_ATTACK_* env vars and the markers
// fall back to their known prefixes.

import { attackConfigSchema, configFromEnv, runChecklist, type AttackConfig, type CheckResult, type ServiceResult } from "./checklist.ts";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 256 * 1024) throw new Error("config too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const config: AttackConfig = process.argv.includes("--config-stdin") ? attackConfigSchema.parse(JSON.parse(await readStdin())) : configFromEnv(process.env);
const report = await runChecklist(config);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  const rows: (CheckResult | ServiceResult)[] = [...report.results, ...report.services];
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) process.stdout.write(`${r.outcome.padEnd(11)} ${r.id.padEnd(width)}  ${r.title} — ${r.detail}\n`);
}

const exposed = report.results.filter((r) => r.outcome === "EXPOSED").map((r) => r.id);
const unreachable = report.services.filter((s) => s.outcome === "UNREACHABLE").map((s) => s.id);
if (exposed.length + unreachable.length > 0) {
  process.stderr.write(`\nEXPOSED: ${exposed.join(", ") || "none"}; UNREACHABLE: ${unreachable.join(", ") || "none"}\n`);
  process.exitCode = 1;
}
