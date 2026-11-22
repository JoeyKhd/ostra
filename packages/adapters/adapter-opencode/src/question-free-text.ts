// Whether OpenCode takes a member's own words for an enum field of a question (F-151, ticket 07),
// without the adapter's process code: the adapter's `questionFreeText` capability reads this, and
// so does the panel's API, which offers "Something else…" from it (`capabilities.questionFreeText`
// on `tasks.get`, `@ostra/adapter-opencode/question-free-text`). OpenCode's question tool asks each
// question as a `oneOf` field and a `<key>_custom` text field; its reply reads the custom field when
// it holds words, and the enum field's value as it is otherwise, and the words reach the model in
// the tool's result (the agent contract suite's free-text case, on the pinned binary).

export const OPENCODE_QUESTION_FREE_TEXT = true;
