import { z } from "zod";

/** Parse `--key=value` and bare `--flag` arguments into a record, then validate them. */
export const parseArgs = <T extends z.ZodType>(schema: T, argv: readonly string[] = process.argv.slice(2)): z.infer<T> => {
  const raw: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) raw[arg.slice(2)] = "true";
    else raw[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(`bad arguments: ${z.prettifyError(parsed.error)}\n`);
    process.exit(2);
  }
  return parsed.data;
};

export const boolArg = z.enum(["true", "false"]).transform((v) => v === "true");

/** Exit when the parent process is gone, so no child outlives a crashed harness. */
export const exitWithParent = (parentPid: number | undefined): void => {
  if (parentPid === undefined) return;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(3);
    }
  }, 2_000);
  timer.unref();
};
