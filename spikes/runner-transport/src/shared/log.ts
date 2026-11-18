// Logs carry IDs and structured fields, never content (AGENTS.md).
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;

export const makeLogger =
  (base: LogFields) =>
  (t: string, fields: LogFields = {}): void => {
    process.stdout.write(`${JSON.stringify({ t, ts: Date.now(), ...base, ...fields })}\n`);
  };
export type Logger = ReturnType<typeof makeLogger>;

/**
 * An error as log fields: its class name and its code, never its message.
 * Library messages (pg, TLS, the filesystem) can carry hosts, users and paths.
 */
export const errorFields = (err: unknown): LogFields => {
  const name = err instanceof Error ? err.name : "unknown";
  if (typeof err === "object" && err !== null && "code" in err && (typeof err.code === "string" || typeof err.code === "number")) {
    return { err: name, code: err.code };
  }
  return { err: name };
};
