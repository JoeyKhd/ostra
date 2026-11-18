// Structured logs carry IDs and numbers, never content, tokens or prompts (AGENTS.md).
type Fields = Readonly<Record<string, string | number | boolean | null>>;

export type Logger = {
  info: (event: string, fields?: Fields) => void;
  warn: (event: string, fields?: Fields) => void;
  error: (event: string, fields?: Fields) => void;
};

export const createLogger = (replica: string, quiet: boolean): Logger => {
  const write = (level: string, event: string, fields: Fields | undefined): void => {
    if (quiet && level === "info") return;
    process.stdout.write(`${JSON.stringify({ t: Date.now(), level, replica, event, ...fields })}\n`);
  };
  return {
    info: (event, fields) => {
      write("info", event, fields);
    },
    warn: (event, fields) => {
      write("warn", event, fields);
    },
    error: (event, fields) => {
      write("error", event, fields);
    },
  };
};
