// @ostra/task-view: the fold from a task's events to the AI SDK's UIMessage[] (ADR 0036). Pure,
// shared by the panel and its tests. It depends only on @ostra/protocol and `import type` from `ai`.
export * from "./ui-types.ts";
export * from "./live-text.ts";
export * from "./fold.ts";
export * from "./derive-state.ts";
export * from "./coverage.ts";
export * from "./message-files.ts";
