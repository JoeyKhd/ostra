// Seeded faults for the two "add tests" tickets. A good test suite for a module
// fails when the module is quietly broken in one of these ways. Each `find`
// occurs exactly once in the pristine sample (test/tickets.test.ts checks it),
// and none of them is caught by the sample's own tests.

import type { Mutant } from "./schema.ts";

export const TOKENIZER_MUTANTS: readonly Mutant[] = [
  {
    id: "tab-is-not-whitespace",
    what: "a tab is no longer skipped",
    find: 'if (c === " " || c === "\\t") {',
    replace: 'if (c === " ") {',
  },
  {
    id: "number-position",
    what: "a number's pos is where it ends, not where it starts",
    find: 'tokens.push({ kind: "number", value: Number(input.slice(start, i)), pos: start });',
    replace: 'tokens.push({ kind: "number", value: Number(input.slice(start, i)), pos: i });',
  },
  {
    id: "name-position",
    what: "a name's pos is where it ends, not where it starts",
    find: 'tokens.push({ kind: "name", name: input.slice(start, i), pos: start });',
    replace: 'tokens.push({ kind: "name", name: input.slice(start, i), pos: i });',
  },
  {
    id: "names-have-no-digits",
    what: "a digit ends a name, so x1 becomes x and 1",
    find: "/^[A-Za-z0-9_]$/",
    replace: "/^[A-Za-z_]$/",
  },
  {
    id: "end-position",
    what: "the end token's pos is 0 instead of the input length",
    find: 'tokens.push({ kind: "end", pos: input.length });',
    replace: 'tokens.push({ kind: "end", pos: 0 });',
  },
  {
    id: "comma-is-a-paren",
    what: "a comma becomes a closing parenthesis",
    find: 'tokens.push({ kind: "comma", pos: i });',
    replace: 'tokens.push({ kind: "rparen", pos: i });',
  },
  {
    id: "error-position-off-by-one",
    what: "the error for an unknown character names the wrong position",
    find: "at position ${String(i)}`);",
    replace: "at position ${String(i + 1)}`);",
  },
];

export const HISTORY_MUTANTS: readonly Mutant[] = [
  {
    id: "evicts-one-too-many",
    what: "past the limit it keeps one entry fewer than the limit",
    find: "while (entries.length > limit) entries.shift();",
    replace: "while (entries.length >= limit) entries.shift();",
  },
  {
    id: "list-is-not-a-copy",
    what: "list() hands out the internal array, so a later add changes it",
    find: "list: () => [...entries],",
    replace: "list: () => entries,",
  },
  {
    id: "last-is-the-first",
    what: "last() returns the oldest entry",
    find: "last: () => entries.at(-1),",
    replace: "last: () => entries.at(0),",
  },
  {
    id: "clear-does-nothing",
    what: "clear() leaves the entries in place",
    find: "entries.length = 0;",
    replace: "entries.length = entries.length;",
  },
  {
    id: "evicts-the-newest",
    what: "past the limit it drops the newest entry, not the oldest",
    find: "entries.shift()",
    replace: "entries.pop()",
  },
  {
    id: "zero-limit-allowed",
    what: "a limit of 0 is accepted",
    find: "limit < 1",
    replace: "limit < 0",
  },
  {
    id: "default-limit-is-50",
    what: "the default limit is 50, not 100",
    find: "DEFAULT_HISTORY_LIMIT = 100",
    replace: "DEFAULT_HISTORY_LIMIT = 50",
  },
];
