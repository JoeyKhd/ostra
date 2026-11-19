import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { startFakeSmtpServer } from "@ostra/adapter-sdk/testing";
import type { SmtpReceived } from "@ostra/adapter-sdk/testing";
import { devDataDir } from "@ostra/db/dev";

// The dev mail sink (milestone 4, ticket 40; spec section 8): milestone 3's fake SMTP server as a
// long-running process on loopback. It takes every message (`EHLO`, no `STARTTLS`, `AUTH PLAIN`
// when a user is set, `MAIL`, `RCPT`, `DATA`) and writes each one to
// `.ostra-dev/mail/<time>-<to>.eml`, so the demo and a person at the terminal can open the
// invitation, verification and reset mails the dev stack sends. Development only: nothing it
// stores leaves the machine, and it is never in the production build.

/** Where the sink writes its mail unless told otherwise: the dev stack's data folder, gitignored. */
export const defaultMailDir: string = path.join(devDataDir, "mail");

/** The sink's port unless `OSTRA_MAIL_SINK_PORT` says otherwise. */
export const MAIL_SINK_PORT_DEFAULT = 2525;

export type MailSink = {
  readonly host: string;
  readonly port: number;
  readonly dir: string;
  /** Resolves once every message taken so far is on disk. */
  readonly flushed: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/** A name part safe on every file system: the address with anything but letters, digits, `.`, `-` and `@` as `_`. */
const safe = (text: string): string => text.replaceAll(/[^A-Za-z0-9.@-]/g, "_").slice(0, 120);

/** The file a message is written to: its time (sortable, no colons) and its first recipient. */
export const mailFileName = (at: Date, to: string, sequence: number): string =>
  `${at.toISOString().replaceAll(":", "-").replace(".", "-")}-${String(sequence).padStart(4, "0")}-${safe(to)}.eml`;

export const startMailSink = async (options: {
  readonly dir?: string;
  readonly port?: number;
  readonly auth?: { readonly user: string; readonly pass: string } | null;
  /** Called with each file written, for the CLI's one line. Never the mail's content. */
  readonly onWritten?: (file: string, to: readonly string[]) => void;
}): Promise<MailSink> => {
  const dir = options.dir ?? defaultMailDir;
  await mkdir(dir, { recursive: true });
  let sequence = 0;
  const writes: Promise<void>[] = [];
  const write = async (message: SmtpReceived): Promise<void> => {
    sequence += 1;
    const file = path.join(dir, mailFileName(new Date(), message.to[0] ?? "nobody", sequence));
    await writeFile(file, `${message.data}\r\n`, "utf8");
    options.onWritten?.(file, message.to);
  };
  const server = await startFakeSmtpServer({
    starttls: "none",
    auth: options.auth ?? null,
    ...(options.port === undefined ? {} : { port: options.port }),
    onMessage: (message) => {
      writes.push(write(message));
    },
  });
  const flushed = async (): Promise<void> => {
    await Promise.all(writes);
  };
  return {
    host: server.host,
    port: server.port,
    dir,
    flushed,
    close: async () => {
      await server.close();
      await flushed();
    },
  };
};
