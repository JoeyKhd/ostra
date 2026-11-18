// Logs carry IDs and structured fields, never content (AGENTS.md). Fields are scalars only:
// ticket text, prompts, tokens and secrets have no way in except by being passed as a string,
// and the scenarios scan every captured line for a hostile ticket marker to catch that.
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
export type LogLevel = "info" | "warn" | "error";

export type Logger = {
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

export type LogLine = { readonly level: LogLevel; readonly event: string; readonly fields: LogFields };

export const createLogger = (write: (line: LogLine) => void): Logger => ({
  info: (event, fields = {}) => {
    write({ level: "info", event, fields });
  },
  warn: (event, fields = {}) => {
    write({ level: "warn", event, fields });
  },
  error: (event, fields = {}) => {
    write({ level: "error", event, fields });
  },
});

export const createStderrLogger = (): Logger =>
  createLogger((line) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`);
  });

export const createCapturingLogger = (): { logger: Logger; lines: LogLine[] } => {
  const lines: LogLine[] = [];
  return {
    logger: createLogger((line) => {
      lines.push(line);
    }),
    lines,
  };
};

export const silentLogger: Logger = createLogger(() => undefined);
