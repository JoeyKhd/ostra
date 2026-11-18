// Structured logs: IDs, codes and counts only. Never a token, a ref's content,
// a ticket's text or an agent's output (AGENTS.md, "Logs carry IDs").

export type LogField = string | number | boolean | null | readonly string[];
export type LogRecord = { readonly ts: string; readonly event: string } & Readonly<Record<string, LogField>>;
export type Logger = {
  readonly info: (event: string, fields?: Readonly<Record<string, LogField>>) => void;
  readonly records: () => readonly LogRecord[];
};

export const createLogger = (options: { readonly echo: boolean }): Logger => {
  const kept: LogRecord[] = [];
  return {
    info: (event, fields = {}) => {
      const record: LogRecord = { ts: new Date().toISOString(), event, ...fields };
      kept.push(record);
      if (options.echo) process.stderr.write(`${JSON.stringify(record)}\n`);
    },
    records: () => kept,
  };
};
