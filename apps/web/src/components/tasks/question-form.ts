import type { QuestionField } from "@ostra/protocol";

// Milestone 10 (F-151/c5, parts.md part 11, the targets' choice 5): the question's form as plain
// state, so what a press does is one function the block calls and a test calls the same way. A
// choice never sends; `Something else…` (when the agent takes words for a choice) opens its field
// and gives it the focus; `Send answer` wakes once every field holds a value, and sends the answers
// with `other` naming the fields answered in the member's own words.

/** `Something else…`'s value among a field's choices: no option the agent offers can be it (a NUL starts it). */
export const SOMETHING_ELSE = "\u0000something-else";

export type QuestionForm = {
  /** Each field's choice (an option, or `SOMETHING_ELSE`), or a text field's words, by field ID. */
  readonly chosen: Readonly<Record<string, string>>;
  /** The words typed under `Something else…`, by field ID. */
  readonly own: Readonly<Record<string, string>>;
};

export const emptyQuestionForm: QuestionForm = { chosen: {}, own: {} };

/** A field offered as choices: a select with options. Any other field is a text field. */
export const isChoice = (field: QuestionField): boolean => field.type === "select" && (field.options?.length ?? 0) > 0;

/** The field's choices as the block lists them: the enum's values, then `Something else…` when the agent takes words. */
export const choicesOf = (field: QuestionField, freeText: boolean): readonly string[] => (isChoice(field) ? [...(field.options ?? []), ...(freeText ? [SOMETHING_ELSE] : [])] : []);

/** What a press leaves: the form, and the control to focus (`Something else…`'s field), if any. */
export type Picked = { readonly form: QuestionForm; readonly focus: { readonly field: string } | null };

/** Choosing a value: never sends. `Something else…` asks for its field's focus. */
export const pick = (form: QuestionForm, fieldId: string, value: string): Picked => ({
  form: { ...form, chosen: { ...form.chosen, [fieldId]: value } },
  focus: value === SOMETHING_ELSE ? { field: fieldId } : null,
});

/** Typing under `Something else…`. */
export const typeOwn = (form: QuestionForm, fieldId: string, words: string): QuestionForm => ({ ...form, own: { ...form.own, [fieldId]: words } });

/** Typing a text field's answer. */
export const typeText = (form: QuestionForm, fieldId: string, words: string): QuestionForm => ({ ...form, chosen: { ...form.chosen, [fieldId]: words } });

/** Whether a field's `Something else…` is chosen, so its field shows. */
export const ownOpen = (form: QuestionForm, fieldId: string): boolean => form.chosen[fieldId] === SOMETHING_ELSE;

/** What `questions.answer` takes: each field's answer, and the fields answered in the member's own words. */
export type QuestionAnswer = { readonly answers: Readonly<Record<string, string>>; readonly other: readonly string[] };

/**
 * The answer the form holds, or `null` while a field has none: `Send answer` stays asleep until
 * every field holds a value (a choice, or words under `Something else…` or in a text field).
 */
export const answerOf = (fields: readonly QuestionField[], form: QuestionForm): QuestionAnswer | null => {
  const answers: Record<string, string> = {};
  const other: string[] = [];
  for (const field of fields) {
    const chosen = form.chosen[field.id];
    if (chosen === undefined) return null;
    if (isChoice(field) && chosen === SOMETHING_ELSE) {
      const words = (form.own[field.id] ?? "").trim();
      if (words === "") return null;
      answers[field.id] = words;
      other.push(field.id);
    } else {
      if (chosen.trim() === "") return null;
      answers[field.id] = chosen;
    }
  }
  return { answers, other };
};
