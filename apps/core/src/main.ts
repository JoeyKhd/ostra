// `node apps/core/src/main.ts`: core, from its settings (docs/configuration.md). `pnpm dev` runs it
// in watch mode. Logs are one JSON object per line, IDs and fields only.

import { createLogger } from "@ostra/adapter-sdk";
import { isSecretsKeyMismatch, parseServerSettings } from "@ostra/domain";

import { startCore } from "./core.ts";

const logger = createLogger((record) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level: record.level, msg: record.message, ...record.fields })}\n`);
});

const parsed = parseServerSettings(process.env);
if (!parsed.ok) {
  for (const error of parsed.errors) {
    process.stderr.write(`core: ${error}\n`);
  }
  process.exit(1);
}

const devBlockWebhooks = process.env["OSTRA_DEV_BLOCK_WEBHOOKS"];
const core = await startCore(parsed.settings, logger, devBlockWebhooks === undefined ? {} : { devBlockWebhooks }).catch((error: unknown) => {
  // A secrets key that can't read the database's secrets (Q136): say so, and the two fixes.
  if (isSecretsKeyMismatch(error)) {
    process.stderr.write(`core: ${error.message}
`);
    process.exit(1);
  }
  throw error;
});
process.stdout.write(`core is listening on http://localhost:${String(core.port)}\n`);

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info("core.stopping", { signal });
  core.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", () => {
  stop("SIGINT");
});
process.on("SIGTERM", () => {
  stop("SIGTERM");
});
