// The structured logger every adapter gets (ADR 0025, AGENTS.md "Logs carry IDs and structured
// fields, never content"). A log line is a message and a flat record of IDs and fields.
//
// Two guards:
// - By type: a field is a primitive or a list of primitives. An object, and so a
//   `TaskCredentials` value (or any of its parts but a bare string), is a type error.
// - At run time: any string that looks like a token is redacted, in the message and in every
//   field, and a value that isn't a primitive (smuggled past the types) is dropped.

export type LogPrimitive = string | number | boolean | null;
export type LogValue = LogPrimitive | readonly LogPrimitive[] | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  readonly debug: (message: string, fields?: LogFields) => void;
  readonly info: (message: string, fields?: LogFields) => void;
  readonly warn: (message: string, fields?: LogFields) => void;
  readonly error: (message: string, fields?: LogFields) => void;
  /** A logger whose every line also carries these fields, such as `{ adapter, taskId }`. */
  readonly child: (fields: LogFields) => Logger;
};

/** One line, after the guards ran: what a sink writes. */
export type LogRecord = {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, LogPrimitive | readonly LogPrimitive[]>>;
};

export type LogSink = (record: LogRecord) => void;

export const REDACTED = "[redacted]";

// Prefixes of tokens ostra handles: GitHub's, OpenAI-style keys, Anthropic's, Linear's, ostra's own
// fake keys and runner tokens, and JSON web tokens. A whole private key and a whole
// `Authorization` value go first, so a prefix inside them doesn't leave the rest behind.
const tokenPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}\b/g,
  /\bostra-(?:fake|runner|join|setup)-[A-Za-z0-9_-]+/g,
  // A task token (ADR 0034): its body and its MAC, joined by a dot.
  /\bostra-task-[A-Za-z0-9_.-]+/g,
  // A panel token (ticket 42): what the panel gives core to store a member's file; body and MAC, joined by a dot.
  /\bostra-panel-[A-Za-z0-9_.-]+/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// A long run of base64 or base64url characters. Pure hex (a git SHA) and UUIDs are IDs, kept.
const longRun = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const isHex = /^[0-9a-f]+$/i;

/** Redacts every part of `text` that looks like a token. */
export const redactTokens = (text: string): string => {
  let out = text;
  for (const pattern of tokenPatterns) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(longRun, (run) => (isHex.test(run) ? run : REDACTED));
};

const isPrimitive = (value: unknown): value is LogPrimitive =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const cleanPrimitive = (value: LogPrimitive): LogPrimitive => (typeof value === "string" ? redactTokens(value) : value);

/** Applies the run-time guard to one record of fields. */
export const sanitizeFields = (
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, LogPrimitive | readonly LogPrimitive[]>> => {
  const out: Record<string, LogPrimitive | readonly LogPrimitive[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (isPrimitive(value)) {
      out[key] = cleanPrimitive(value);
    } else if (Array.isArray(value) && value.every(isPrimitive)) {
      out[key] = value.map(cleanPrimitive);
    } else {
      out[key] = "[refused: not a primitive]";
    }
  }
  return out;
};

/** A logger that writes guarded records to `sink`. */
export const createLogger = (sink: LogSink, base: LogFields = {}): Logger => {
  const write =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink({ level, message: redactTokens(message), fields: sanitizeFields({ ...base, ...fields }) });
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (fields) => createLogger(sink, { ...base, ...fields }),
  };
};

/** A logger that writes nothing: the default in tests. */
export const silentLogger: Logger = createLogger(() => undefined);
