import { z } from "zod";

// Normalized tool input and output per ACP `kind` (research/agent-ui-stream.md section 7).
// Renderers are keyed by these kinds, never by an agent's own tool name.
const fileChange = z.strictObject({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

export const toolSchemas = {
  read: {
    input: z.strictObject({ path: z.string(), startLine: z.number().int().optional() }),
    output: z.strictObject({ lineCount: z.number().int().optional() }),
  },
  edit: {
    input: z.strictObject({ paths: z.array(z.string()) }),
    output: z.strictObject({ files: z.array(fileChange) }),
  },
  execute: {
    input: z.strictObject({ command: z.string(), cwd: z.string().optional() }),
    output: z.strictObject({
      output: z.string(),
      truncated: z.boolean(),
      exitCode: z.number().int().nullable(),
    }),
  },
} as const;

export type FileChange = z.infer<typeof fileChange>;

// Kinds that have a typed tool part. Every other ACP kind renders as a `dynamic-tool` part.
export const typedToolKinds = ["read", "edit", "execute"] as const;
export type TypedToolKind = (typeof typedToolKinds)[number];

export const toolKinds = [
  ...typedToolKinds,
  "delete",
  "move",
  "search",
  "fetch",
  "think",
  "switch_mode",
  "other",
] as const;
export const ToolKind = z.enum(toolKinds);
export type ToolKind = z.infer<typeof ToolKind>;

export type ToolInput<K extends TypedToolKind> = z.infer<(typeof toolSchemas)[K]["input"]>;
export type ToolOutput<K extends TypedToolKind> = z.infer<(typeof toolSchemas)[K]["output"]>;
