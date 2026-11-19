// A small reader for the YAML deploy/compose.yaml uses: block maps, block lists, inline lists and
// quoted scalars. Moved from the docker executor's `deploy.test.ts` (milestone 1's ticket 22). It
// throws on anything else, so a compose file that grows past it fails the check loudly.

export type Yaml = string | readonly Yaml[] | { readonly [key: string]: Yaml };

export const isYamlList = (value: Yaml): value is readonly Yaml[] => Array.isArray(value);

const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || line[index - 1] === " ")) {
      return line.slice(0, index);
    }
  }
  return line;
};

const scalar = (text: string): Yaml => {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => scalar(item));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

/** Parses the subset of YAML deploy/compose.yaml uses. Throws on anything else. */
export const parseYaml = (text: string): Yaml => {
  const lines = text
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let position = 0;
  const block = (indent: number): Yaml => {
    const first = lines[position];
    if (first === undefined) {
      return "";
    }
    if (first.text.startsWith("- ")) {
      const items: Yaml[] = [];
      while (lines[position]?.indent === indent && lines[position]?.text.startsWith("- ") === true) {
        items.push(scalar(lines[position]?.text.slice(2) ?? ""));
        position += 1;
      }
      return items;
    }
    const map: Record<string, Yaml> = {};
    while (lines[position] !== undefined && lines[position]?.indent === indent) {
      const line = lines[position];
      if (line === undefined) {
        break;
      }
      const colon = line.text.indexOf(":");
      if (colon <= 0) {
        throw new Error(`not a key: ${line.text}`);
      }
      const key = line.text.slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const rest = line.text.slice(colon + 1).trim();
      position += 1;
      if (rest === "") {
        const next = lines[position];
        map[key] = next !== undefined && next.indent > indent ? block(next.indent) : "";
      } else {
        map[key] = scalar(rest);
      }
    }
    return map;
  };
  const parsed = block(0);
  if (position < lines.length) {
    throw new Error(`unread YAML from: ${lines[position]?.text ?? ""}`);
  }
  return parsed;
};

/** The value at a path of keys, or `undefined`. */
export const yamlAt = (value: Yaml, ...keys: string[]): Yaml | undefined => {
  let current: Yaml = value;
  for (const key of keys) {
    if (typeof current !== "object" || isYamlList(current)) {
      return undefined;
    }
    const next: Yaml | undefined = Object.entries(current).find(([name]) => name === key)?.[1];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return current;
};

/** Every scalar in a value, depth first. */
export const yamlScalars = (value: Yaml): readonly string[] =>
  typeof value === "string" ? [value] : isYamlList(value) ? value.flatMap(yamlScalars) : Object.values(value).flatMap(yamlScalars);

/** Every scalar with the nearest map key above it. */
export const yamlPairs = (value: Yaml, prefix = ""): readonly (readonly [string, string])[] =>
  typeof value === "string"
    ? [[prefix, value]]
    : isYamlList(value)
      ? value.flatMap((item) => yamlPairs(item, prefix))
      : Object.entries(value).flatMap(([key, item]: [string, Yaml]) => yamlPairs(item, key));
