import { createLogger } from "@ostra/adapter-sdk";
import type { LogPrimitive, LogRecord, Logger } from "@ostra/adapter-sdk";

// What the CLI prints. Two channels, kept apart:
// - `say` and `warn`: sentences for the person at the terminal (stdout and stderr).
// - the logger: structured lines of IDs and fields (stderr), through the adapter SDK's logger, so
//   anything that looks like a token is redacted before it's written (AGENTS.md, Code).
// Neither ever receives a token, a key, a prompt or agent output.

export type Terminal = {
  readonly say: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly logger: Logger;
};

const formatValue = (value: LogPrimitive | readonly LogPrimitive[]): string => {
  if (Array.isArray(value)) {
    return value.map((item: LogPrimitive) => String(item)).join(",");
  }
  return typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : String(value);
};

/** One log record as `level message key=value ...`. */
export const formatLogRecord = (record: LogRecord): string => {
  const fields = Object.entries(record.fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  return `${record.level} ${record.message}${fields.length > 0 ? ` ${fields}` : ""}`;
};

export type TerminalStreams = {
  readonly stdout: { readonly write: (text: string) => unknown };
  readonly stderr: { readonly write: (text: string) => unknown };
  /** Write debug lines too. */
  readonly verbose?: boolean;
};

export const createTerminal = (streams: TerminalStreams): Terminal => ({
  say: (line) => {
    streams.stdout.write(`${line}\n`);
  },
  warn: (line) => {
    streams.stderr.write(`${line}\n`);
  },
  logger: createLogger((record) => {
    if (record.level === "debug" && streams.verbose !== true) {
      return;
    }
    streams.stderr.write(`${formatLogRecord(record)}\n`);
  }),
});

/** A terminal that keeps every line, for tests that check what was printed. */
export const createCapturingTerminal = (): Terminal & { readonly lines: () => readonly string[] } => {
  const lines: string[] = [];
  const terminal = createTerminal({
    stdout: { write: (text: string) => lines.push(text) },
    stderr: { write: (text: string) => lines.push(text) },
    verbose: true,
  });
  return { ...terminal, lines: () => lines };
};
