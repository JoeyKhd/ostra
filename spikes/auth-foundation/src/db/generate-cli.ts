import { generateClient } from "./migrate.ts";

// `pnpm db:generate`, and the first half of `pnpm typecheck`: the Prisma client is generated code
// (src/generated/, gitignored), so a fresh checkout has none until this has run. Going through
// `generateClient` keeps the update check and telemetry off, as in every other command here.
const result = await generateClient();
console.log(result.ok ? "prisma client generated" : `prisma generate failed: ${result.detail}`);
process.exitCode = result.ok ? 0 : 1;
