// `pnpm dev:mail-sink`: the dev mail sink (milestone 4, ticket 40) until Ctrl+C. Point the dev stack
// at it with `OSTRA_EMAIL_PROVIDER=smtp`, `OSTRA_SMTP_HOST=127.0.0.1`, `OSTRA_SMTP_PORT=2525`,
// `OSTRA_SMTP_SECURE=none` and `OSTRA_EMAIL_FROM=ostra@mail.localhost` (docs/development.md). Each mail
// lands in `.ostra-dev/mail/`. Development and test only: it refuses to run otherwise.

import { seedingAllowed } from "@ostra/domain";

import { MAIL_SINK_PORT_DEFAULT, startMailSink } from "./mail-sink.ts";

const main = async (): Promise<number> => {
  if (!seedingAllowed(process.env)) {
    process.stderr.write("The mail sink runs only when NODE_ENV is development or test.\n");
    return 1;
  }
  const rawPort = process.env["OSTRA_MAIL_SINK_PORT"];
  const port = rawPort === undefined || rawPort === "" ? MAIL_SINK_PORT_DEFAULT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    process.stderr.write("OSTRA_MAIL_SINK_PORT is a port number.\n");
    return 2;
  }
  const dir = process.env["OSTRA_MAIL_SINK_DIR"];
  const sink = await startMailSink({
    port,
    ...(dir === undefined || dir === "" ? {} : { dir }),
    // The file's name and its recipient count only: a mail's links are bearer links.
    onWritten: (file, to) => {
      process.stdout.write(`mail for ${String(to.length)} recipient(s): ${file}\n`);
    },
  });
  process.stdout.write(`Mail sink on smtp://${sink.host}:${String(sink.port)}, writing to ${sink.dir}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await sink.close();
  return 0;
};

process.exitCode = await main();
