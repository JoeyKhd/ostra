// Entry point for the runner image's sidecar mode. The box's runner (or the
// harness) starts this with the box's environment. ADR 0046: the sidecar is
// the same binary in an internal mode; here it is its own small entry.

import { runSidecar, sidecarEnvSchema } from "./main.ts";

const parsed = sidecarEnvSchema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write(`${JSON.stringify({ component: "sidecar", event: "bad_env", issues: parsed.error.issues.map((i) => i.path.join(".")) })}\n`);
  process.exit(2);
}

await runSidecar(parsed.data);
