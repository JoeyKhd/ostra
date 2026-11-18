// The shapes of a ticket, its hidden acceptance check and its reference
// solution. A ticket is what a teammate would file in the tracker; everything
// else here is the harness's own knowledge, which the agent never sees.

import { z } from "zod";

export const TicketKindSchema = z.enum(["bug", "feature", "refactor", "tests"]);
export type TicketKind = z.infer<typeof TicketKindSchema>;

export const TicketIdSchema = z.string().regex(/^calc-\d{1,3}$/).brand<"TicketId">();
export type TicketId = z.infer<typeof TicketIdSchema>;
export const ticketId = (value: string): TicketId => TicketIdSchema.parse(value);

/** A tracker key such as `CALC-7`. */
export const TicketKeySchema = z.string().regex(/^CALC-\d{1,3}$/).brand<"TicketKey">();
export type TicketKey = z.infer<typeof TicketKeySchema>;
export const ticketKey = (id: TicketId): TicketKey => TicketKeySchema.parse(id.toUpperCase());

/** One seeded change to a module, applied to the pristine sample to test a ticket's new tests. */
export type Mutant = {
  readonly id: string;
  readonly what: string;
  /** Exactly one occurrence in the file. */
  readonly find: string;
  readonly replace: string;
};

export type Acceptance =
  /** A hidden test file, run against the agent's result. */
  | { readonly kind: "behavior"; readonly file: string }
  /** The agent's tests, run against the pristine code (green) and against seeded mutants (red). */
  | { readonly kind: "mutation"; readonly target: string; readonly mutants: readonly Mutant[] };

export type Ticket = {
  readonly id: TicketId;
  readonly kind: TicketKind;
  readonly title: string;
  /** Markdown, as it would stand in the tracker. */
  readonly body: string;
  readonly acceptance: Acceptance;
};

export type Step =
  | { readonly tool: "read"; readonly path: string }
  /** A shell command. Not applied by the oracle: it changes no file the checks look at. */
  | { readonly tool: "shell"; readonly command: string }
  /** A question put to the member, who in this spike never answers. */
  | { readonly tool: "question"; readonly question: string; readonly options: readonly string[] }
  | { readonly tool: "edit"; readonly path: string; readonly oldString: string; readonly newString: string }
  | { readonly tool: "write"; readonly path: string; readonly content: string };

/** What a scripted stub model does for a ticket: the steps, then a summary as its last message. */
export type Solution = {
  readonly steps: readonly Step[];
  readonly summary: string;
};

/**
 * How a scripted run goes, for the dry-run. `good` is the reference solution;
 * the others are the ways a real run goes wrong, so the checkers are proven on
 * failures too. `escape` is a good run that first tries to write a file outside
 * its workspace and to read one, to prove the permission rule that forbids both.
 */
export const VariantSchema = z.enum(["good", "noop", "partial", "breaks", "weak", "escape"]);
export type Variant = z.infer<typeof VariantSchema>;

/** What the checkers must conclude about a scripted run. */
export type Expectation = {
  readonly acceptance: "pass" | "fail";
  readonly ci: "green" | "red";
};
