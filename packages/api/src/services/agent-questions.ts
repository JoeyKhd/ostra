import { OPENCODE_QUESTION_FREE_TEXT } from "@ostra/adapter-opencode/question-free-text";

// Milestone 10 (F-151/c5, the targets' choice 5, ticket 08): whether each shipped agent takes a
// member's own words for an enum field of a question, as its adapter declares it
// (`questionFreeText`, read without the adapter's process code). The task page offers "Something
// else…" on a question's choices from it (`capabilities.questionFreeText`); an agent no adapter
// declares takes none, and its questions keep milestone 3's form.

/** Each shipped agent adapter's `questionFreeText`, by its registered name. */
const shippedQuestionFreeText: ReadonlyMap<string, boolean> = new Map([["opencode", OPENCODE_QUESTION_FREE_TEXT]]);

/** Whether the agent adapter by this name takes words for an enum field (`Something else…`). */
export const agentTakesQuestionFreeText = (adapter: string): boolean => shippedQuestionFreeText.get(adapter) === true;
