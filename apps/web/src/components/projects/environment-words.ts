import { plural } from "@/lib/messages";

// The environment page's counts, in words (environment.md).

/** "2 variables · 2 secrets · 1 file", leaving out a kind that has none. */
export const entriesText = (kinds: readonly ("variable" | "secret" | "file")[]): string => {
  const count = (kind: "variable" | "secret" | "file") => kinds.filter((item) => item === kind).length;
  const variables = count("variable");
  const secrets = count("secret");
  const files = count("file");
  return [
    ...(variables > 0 ? [plural(variables, "environment.count.variable", "environment.count.variables")] : []),
    ...(secrets > 0 ? [plural(secrets, "environment.count.secret", "environment.count.secrets")] : []),
    ...(files > 0 ? [plural(files, "environment.count.file", "environment.count.files")] : []),
  ].join(" · ");
};

/** How many lines a file's content has: a final newline doesn't start another. */
export const lineCount = (content: string): number => (content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length);

/** A script as edited: a final newline isn't a line of its own. */
export const withoutFinalNewline = (script: string): string => script.replace(/\r?\n$/, "");
