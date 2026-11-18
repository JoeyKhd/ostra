import { z } from "zod";

// Tool calls by ACP's tool `kind` (ADR 0036, research/agent-ui-stream.md section 7). The panel
// renders a tool call by its kind, never by an agent's own tool name. Ported from
// spikes/live-stream-and-task-view/src/shared/tools.ts.

/** The tool kinds ACP defines. An agent's tool that fits none is `other`. */
export const toolKinds = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export const toolKindSchema = z.enum(toolKinds);
export type ToolKind = z.infer<typeof toolKindSchema>;

/** One file a tool call changed, with its line counts. */
export const fileChangeSchema = z.strictObject({
  path: z.string().min(1),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** A unified diff of the change, when the agent sent one. */
  patch: z.string().optional(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

/**
 * The normalised input and output of the kinds the panel draws with their own part. The ACP
 * mapping (ticket 09) fills these; a call whose payload doesn't fit is stored as raw JSON and
 * drawn as a generic tool part.
 */
export const typedToolSchemas = {
  read: {
    input: z.strictObject({ path: z.string(), startLine: z.number().int().optional() }),
    output: z.strictObject({ lineCount: z.number().int().optional() }),
  },
  edit: {
    input: z.strictObject({ paths: z.array(z.string()) }),
    output: z.strictObject({ files: z.array(fileChangeSchema) }),
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

/** The kinds that have a typed part in the panel. Every other kind renders generically. */
export const typedToolKinds = ["read", "edit", "execute"] as const;
export type TypedToolKind = (typeof typedToolKinds)[number];

export type ToolInput<K extends TypedToolKind> = z.infer<(typeof typedToolSchemas)[K]["input"]>;
export type ToolOutput<K extends TypedToolKind> = z.infer<(typeof typedToolSchemas)[K]["output"]>;
