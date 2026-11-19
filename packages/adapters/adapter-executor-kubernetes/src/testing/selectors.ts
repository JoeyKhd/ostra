// The small parts of the API server's grammar the fake Kubernetes API needs (ticket 06): label and
// field selectors, quantities, and the names and labels it validates. Test-only.

type Requirement =
  | { readonly kind: "equals"; readonly key: string; readonly value: string }
  | { readonly kind: "not-equals"; readonly key: string; readonly value: string }
  | { readonly kind: "in"; readonly key: string; readonly values: readonly string[] }
  | { readonly kind: "not-in"; readonly key: string; readonly values: readonly string[] }
  | { readonly kind: "exists"; readonly key: string }
  | { readonly kind: "not-exists"; readonly key: string };

/** Splits on the commas outside parentheses: `a in (x,y),b=c` is two requirements. */
const splitTerms = (text: string): string[] => {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      terms.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  terms.push(current);
  return terms.map((term) => term.trim()).filter((term) => term !== "");
};

const parseTerm = (term: string): Requirement | null => {
  const set = /^([^\s!=]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(term);
  if (set !== null) {
    const [, key = "", op, list = ""] = set;
    const values = list.split(",").map((value) => value.trim());
    return op === "in" ? { kind: "in", key, values } : { kind: "not-in", key, values };
  }
  const notEquals = /^([^\s!=]+)\s*!=\s*(\S*)$/.exec(term);
  if (notEquals !== null) return { kind: "not-equals", key: notEquals[1] ?? "", value: notEquals[2] ?? "" };
  const equals = /^([^\s!=]+)\s*==?\s*(\S*)$/.exec(term);
  if (equals !== null) return { kind: "equals", key: equals[1] ?? "", value: equals[2] ?? "" };
  const notExists = /^!([^\s!=]+)$/.exec(term);
  if (notExists !== null) return { kind: "not-exists", key: notExists[1] ?? "" };
  if (/^[^\s!=()]+$/.test(term)) return { kind: "exists", key: term };
  return null;
};

/** A selector's test, or `null` when the selector doesn't parse (the API answers 400). */
export const parseSelector = (text: string | null): ((read: (key: string) => string | undefined) => boolean) | null => {
  if (text === null || text.trim() === "") return () => true;
  const requirements: Requirement[] = [];
  for (const term of splitTerms(text)) {
    const parsed = parseTerm(term);
    if (parsed === null) return null;
    requirements.push(parsed);
  }
  return (read) =>
    requirements.every((requirement) => {
      const value = read(requirement.key);
      switch (requirement.kind) {
        case "equals":
          return value === requirement.value;
        case "not-equals":
          return value !== requirement.value;
        case "in":
          return value !== undefined && requirement.values.includes(value);
        case "not-in":
          return value === undefined || !requirement.values.includes(value);
        case "exists":
          return value !== undefined;
        case "not-exists":
          return value === undefined;
        default:
          return requirement satisfies never;
      }
    });
};

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const QUALIFIED_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;

export const isDnsLabel = (name: string): boolean => name.length <= 63 && DNS_LABEL.test(name);
export const isDnsSubdomain = (name: string): boolean => name.length <= 253 && DNS_SUBDOMAIN.test(name);

/** A label's key, as the API server checks it: an optional DNS subdomain prefix, then a name of at most 63. */
export const labelKeyProblem = (key: string): string | null => {
  const slash = key.lastIndexOf("/");
  const prefix = slash === -1 ? null : key.slice(0, slash);
  const name = slash === -1 ? key : key.slice(slash + 1);
  if (prefix !== null && !isDnsSubdomain(prefix)) return `the prefix of "${key}" must be a DNS subdomain`;
  if (name.length === 0 || name.length > 63 || !QUALIFIED_NAME.test(name)) return `"${key}" must be a qualified name of at most 63 characters`;
  return null;
};

export const labelValueProblem = (value: string): string | null =>
  value === "" || (value.length <= 63 && QUALIFIED_NAME.test(value)) ? null : `"${value}" must be empty or at most 63 characters of [A-Za-z0-9._-], starting and ending with one of [A-Za-z0-9]`;

const SUFFIXES: Readonly<Record<string, number>> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** A quantity (`500m`, `2`, `4Gi`, `1e3`) as a number of its base unit, or `null` when it doesn't parse. */
export const parseQuantity = (text: string): number | null => {
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(n|u|m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(text.trim());
  if (match === null) return null;
  const factor = SUFFIXES[match[2] ?? ""];
  return factor === undefined ? null : Number(match[1]) * factor;
};

/** CPU in millicores, as the quota's `used` reports it. */
export const cpuText = (cores: number): string => `${String(Math.round(cores * 1000))}m`;
/** Memory in MiB when it divides, in bytes otherwise. */
export const memoryText = (bytes: number): string => (bytes % 1024 ** 2 === 0 ? `${String(bytes / 1024 ** 2)}Mi` : String(Math.round(bytes)));
