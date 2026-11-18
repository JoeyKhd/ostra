// `pnpm db:generate`: writes Prisma's client to src/generated/ (gitignored), with Prisma's
// telemetry and update check off (ADR 0021). Turborepo runs it before typecheck, lint and test.

import { runPrisma } from "@ostra/db/dev";

const result = await runPrisma(["generate"]);
if (result.ok) {
  console.log("Prisma client generated.");
} else {
  console.error(result.output.trim());
  process.exitCode = 1;
}
