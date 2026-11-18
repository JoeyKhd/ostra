import { hardeningChecks, streamChecks, watcherAndApprovalChecks } from "./checks-api.ts";
import { startContext } from "./context.ts";
import { printCriteria } from "./report.ts";

// Just the checks that need no browser: `pnpm check:api`.
const ctx = await startContext();
try {
  printCriteria([...(await watcherAndApprovalChecks(ctx)), ...(await streamChecks(ctx)), ...(await hardeningChecks(ctx))]);
} finally {
  await ctx.stop();
}
