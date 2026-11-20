// A `CODEOWNERS` file (F-102, ADR 0058, Q226): ostra's own parser. Each line is a pattern and its
// owners: `@user`, `@org/team` or an address. For a path, the last matching line wins. Patterns
// follow GitHub's subset of gitignore: `*` and `**`, `?`, a leading `/` anchoring to the root, a
// trailing `/` for a directory, and a name with no `/` matching at any depth. Pure. The file's text
// is a repo's, so untrusted: it's parsed, never logged.

export type CodeOwner =
  | { readonly kind: "user"; readonly login: string }
  | { readonly kind: "team"; readonly org: string; readonly slug: string }
  /** An address: shown, never matched (reviewers are matched through the GitHub link). */
  | { readonly kind: "email"; readonly address: string };

export type CodeOwnersRule = { readonly pattern: string; readonly matcher: RegExp; readonly owners: readonly CodeOwner[] };

/** GitHub reads at most 3 MB of a CODEOWNERS file: ostra reads as many characters. */
export const CODEOWNERS_MAX_CHARS = 3 * 1024 * 1024;

const ownerOf = (token: string): CodeOwner | null => {
  const team = /^@([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/.exec(token);
  if (team !== null) {
    return { kind: "team", org: team[1] ?? "", slug: team[2] ?? "" };
  }
  const user = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/.exec(token);
  if (user !== null) {
    return { kind: "user", login: user[1] ?? "" };
  }
  if (/^[^@\s]+@[^@\s]+$/.test(token)) {
    return { kind: "email", address: token };
  }
  return null;
};

const escapeRegex = (text: string): string => text.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");

/** A pattern as a regular expression over a repo-relative path (no leading slash). */
export const patternMatcher = (pattern: string): RegExp => {
  const directory = pattern.endsWith("/");
  let body = directory ? pattern.slice(0, -1) : pattern;
  const anchored = body.startsWith("/") || body.includes("/");
  body = body.replace(/^\/+/, "");
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === "*") {
      if (body[index + 1] === "*") {
        // `**/` matches no folder or any; a trailing `**` matches everything below.
        if (body[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A pattern matches the path itself, or anything below it when it names a folder.
  const suffix = directory ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${source}${suffix}`);
};

/** The file's rules, in order. A line that isn't a rule (a comment, a blank, a bad owner) is skipped. */
export const parseCodeOwners = (text: string): readonly CodeOwnersRule[] => {
  const rules: CodeOwnersRule[] = [];
  for (const raw of text.slice(0, CODEOWNERS_MAX_CHARS).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") {
      continue;
    }
    const [pattern = "", ...tokens] = line.split(/\s+/);
    if (pattern === "" || pattern.startsWith("!") || pattern.includes("[")) {
      // GitHub doesn't support negation or character ranges in CODEOWNERS.
      continue;
    }
    const owners = tokens.map(ownerOf).filter((owner): owner is CodeOwner => owner !== null);
    rules.push({ pattern, matcher: patternMatcher(pattern), owners });
  }
  return rules;
};

/** The owners of one path: the last matching rule's, which may be none. */
export const ownersOf = (rules: readonly CodeOwnersRule[], path: string): readonly CodeOwner[] => {
  const relative = path.replace(/^\/+/, "");
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule?.matcher.test(relative) === true) {
      return rule.owners;
    }
  }
  return [];
};

/** The owners of a PR's changed paths, each once: the users by login and the teams by `org/slug`. */
export const ownersFor = (
  rules: readonly CodeOwnersRule[],
  paths: readonly string[],
): { readonly users: readonly string[]; readonly teams: readonly string[] } => {
  const users = new Map<string, string>();
  const teams = new Map<string, string>();
  for (const path of paths) {
    for (const owner of ownersOf(rules, path)) {
      switch (owner.kind) {
        case "user":
          users.set(owner.login.toLowerCase(), owner.login);
          break;
        case "team": {
          const name = `${owner.org}/${owner.slug}`;
          teams.set(name.toLowerCase(), name);
          break;
        }
        case "email":
          break;
        default:
          return owner satisfies never;
      }
    }
  }
  return { users: [...users.values()], teams: [...teams.values()] };
};
