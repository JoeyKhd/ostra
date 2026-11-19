// A Dockerfile read into its instructions: comment lines dropped (parser directives included),
// continuation lines joined, and each instruction split into its keyword and the rest.

export type Instruction = {
  /** Upper-case: `FROM`, `RUN`, `ENV`, ... */
  readonly keyword: string;
  /** Everything after the keyword, continuation lines joined with a space. */
  readonly args: string;
  /** The 1-based line the instruction starts on. */
  readonly line: number;
};

export type Stage = {
  /** The image or earlier stage it starts `FROM`. */
  readonly from: string;
  /** Its `AS` name, if it has one. */
  readonly name: string | null;
  readonly instructions: readonly Instruction[];
};

export const parseDockerfile = (text: string): readonly Instruction[] => {
  const out: Instruction[] = [];
  let pending: { keyword: string; parts: string[]; line: number } | null = null;
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("#") || (trimmed === "" && pending === null)) {
      continue;
    }
    const continues = trimmed.endsWith("\\");
    const body = continues ? trimmed.slice(0, -1).trim() : trimmed;
    if (pending === null) {
      const match = /^(\S+)\s*(.*)$/.exec(body);
      pending = { keyword: (match?.[1] ?? "").toUpperCase(), parts: [match?.[2] ?? ""], line: index + 1 };
    } else if (body !== "") {
      pending.parts.push(body);
    }
    if (!continues) {
      out.push({ keyword: pending.keyword, args: pending.parts.join(" ").trim(), line: pending.line });
      pending = null;
    }
  }
  if (pending !== null) {
    out.push({ keyword: pending.keyword, args: pending.parts.join(" ").trim(), line: pending.line });
  }
  return out;
};

/** The instructions grouped by stage, in order. Instructions before the first `FROM` are dropped. */
export const stagesOf = (instructions: readonly Instruction[]): readonly Stage[] => {
  const stages: { from: string; name: string | null; instructions: Instruction[] }[] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === "FROM") {
      const words = instruction.args.split(/\s+/).filter((word) => !word.startsWith("--"));
      const as = words.findIndex((word) => word.toUpperCase() === "AS");
      stages.push({ from: words[0] ?? "", name: as >= 0 ? (words[as + 1] ?? null) : null, instructions: [] });
    } else {
      stages.at(-1)?.instructions.push(instruction);
    }
  }
  return stages;
};

/** The names an `ARG` or `ENV` instruction sets (`ENV A=1 B=2`, `ENV A 1`, `ARG A`, `ARG A=1`). */
export const namesSet = (instruction: Instruction): readonly string[] => {
  if (instruction.keyword === "ARG") {
    return [instruction.args.split("=")[0]?.trim() ?? ""];
  }
  if (instruction.keyword !== "ENV") {
    return [];
  }
  if (!/^\S+=/.test(instruction.args)) {
    return [instruction.args.split(/\s+/)[0] ?? ""];
  }
  return [...instruction.args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1] ?? "");
};

/** The value an `ENV` instruction gives a name, if it sets it. */
export const envValue = (instruction: Instruction, name: string): string | null => {
  if (instruction.keyword !== "ENV") {
    return null;
  }
  const match = new RegExp(String.raw`(?:^|\s)${name}=("[^"]*"|\S*)`).exec(instruction.args);
  return match?.[1]?.replace(/^"|"$/g, "") ?? null;
};

/** A JSON-array (exec form) argument list, or `null` for the shell form. */
export const execForm = (instruction: Instruction): readonly string[] | null => {
  if (!instruction.args.startsWith("[")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(instruction.args);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed.filter((item) => typeof item === "string") : null;
  } catch {
    return null;
  }
};
