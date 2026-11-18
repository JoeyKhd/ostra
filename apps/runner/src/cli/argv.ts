// The CLI's arguments: command words first, then `--name value` or `--name=value` flags. Values
// are kept as strings; the runner's config schema checks them (ADR 0046, ticket 15).

export type ParsedArgv = {
  readonly words: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
  /** Flags that take no value. */
  readonly switches: ReadonlySet<string>;
};

export type ArgvResult = { readonly ok: true; readonly argv: ParsedArgv } | { readonly ok: false; readonly error: string };

/** Flags that take no value. Every other flag takes one. */
const SWITCHES: ReadonlySet<string> = new Set(["help", "version", "verbose"]);

export const parseArgv = (args: readonly string[]): ArgvResult => {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-h") {
      switches.add("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      if (Object.keys(flags).length > 0 || switches.size > 0) {
        return { ok: false, error: `unexpected "${arg}" after the flags` };
      }
      words.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return { ok: false, error: `"${arg}" is not a flag` };
    }
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    if (equals !== -1) {
      flags[name] = body.slice(equals + 1);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `--${name} needs a value` };
    }
    flags[name] = value;
    index += 1;
  }
  return { ok: true, argv: { words, flags, switches } };
};
