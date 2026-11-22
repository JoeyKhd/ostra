import { z } from "zod";

import { ostraToolOf } from "@ostra/protocol";
import type { AttachmentKind, OstraToolKind } from "@ostra/protocol";

import { CANCELLED_TOOL_ERROR } from "../fold.ts";
import { approvalMetadataSchema, thoughtTimeKey } from "../ui-types.ts";
import type {
  AppProcessData,
  ApprovalStatus,
  AttachmentSkippedData,
  AttachmentsData,
  NoBrowserData,
  SetupOutputLine,
  StepTime,
  SubagentNode,
  TaskToolPart,
  TaskUIMessage,
  TaskUIPart,
} from "../ui-types.ts";
import { workspaceCommand, workspacePath } from "./workspace-path.ts";
import type { WorkspaceContext } from "./workspace-path.ts";

// Milestone 10 (F-151, spec section 5.3): a turn's parts as the column's steps. Each tool call,
// thought, capture and the like is one `RunStep`, with what its row needs (its subject relative to
// the workspace, its exit, duration and size) and its full value for the row's `title`. No words:
// ticket 04 words them. Pure.

/** What the thread needs to read a turn: the workspace's rule (`workspacePath`) and the task's MCP servers' names. */
export type ThreadContext = WorkspaceContext & {
  /** The MCP servers the task's agent was given, by the names its tools start with (`github` in `github_get_pull_request`). */
  readonly mcpServers: readonly string[];
};

/**
 * Where a step is: running (or waiting on an approval), done, failed (a command's exit other than
 * 0, `killed`, or a tool's error), or cancelled (its turn was cancelled, its approval was denied or
 * closed: it never ran). A cancelled step isn't a failure.
 */
export type StepState = "running" | "done" | "failed" | "cancelled";

type StepBase = {
  /** Stable in the thread: the call's ID, or its part's. */
  readonly id: string;
  /** The call it is; `null` for a step no call made (a thought, a capture, the setup script). */
  readonly toolCallId: string | null;
  /** When it started and ended, in ms since the epoch (`meta.stepTimes`); `endedAt` is `null` while it runs. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly state: StepState;
  /** The step's full subject (the raw paths, the whole command line): the row's `title`, never shortened. */
  readonly fullSubject: string;
  /** Its approval when one asked: pending, answered (by whom, and whether a deny gave a reason), automatic or closed. */
  readonly approval: ApprovalStatus | null;
  /** A failed call's error, in its tool's own words (data, never markup, never logged); `null` otherwise. */
  readonly error: string | null;
};

/** A file an edit changed, its path relative to the workspace. */
export type EditedFile = { readonly path: string; readonly added: number; readonly removed: number; readonly patch: string | null };

/** What a step shows beside the agent's own: milestone 8's app process, a capture ostra skipped, a box with no browser. */
export type StepInfo =
  | { readonly about: "app-process"; readonly appProcess: AppProcessData }
  | { readonly about: "capture-skipped"; readonly skipped: AttachmentSkippedData }
  | { readonly about: "no-browser"; readonly noBrowser: NoBrowserData };

/** How one of ostra's own tools came out: done, or a review handed in again for a round already in (it stands as it was). */
export type OstraOutcome = "done" | "already-in";

/** An HTTP status a fetch answered, as its error names it (`403 Forbidden`). */
export type FetchStatus = { readonly code: number; readonly text: string | null };

export type ReadStep = StepBase & {
  readonly kind: "read";
  /** Every file the run read, each once, relative, in the order it was first read. */
  readonly paths: readonly string[];
  /** Every read call the step stands for. */
  readonly toolCallIds: readonly string[];
};
export type EditStep = StepBase & {
  readonly kind: "edit";
  /** The first file it changed, relative. */
  readonly path: string;
  readonly files: readonly EditedFile[];
  readonly added: number;
  readonly removed: number;
};
export type CommandStep = StepBase & {
  readonly kind: "command";
  /** The command line, its paths relative. */
  readonly line: string;
  /** Its exit code; `killed` when it ended with no code (a signal); `null` while it runs, or when it never ran or the tool failed. */
  readonly exit: number | "killed" | null;
  /** How long it ran; `null` while it runs. */
  readonly ms: number | null;
  /** Its output so far, as the agent reported it (data, never markup). */
  readonly output: string | null;
  readonly truncated: boolean;
};
export type ThoughtStep = StepBase & {
  readonly kind: "thought";
  /** Its first sentence, 120 characters at most. */
  readonly excerpt: string;
  readonly text: string;
  readonly ms: number | null;
};
export type SearchStep = StepBase & {
  readonly kind: "search";
  readonly query: string;
  /** The folder it searched in, relative; `null` when it named none. */
  readonly folder: string | null;
  readonly matches: number | null;
};
export type WebSearchStep = StepBase & { readonly kind: "web-search"; readonly query: string | null };
export type FetchStep = StepBase & {
  readonly kind: "fetch";
  readonly url: string;
  readonly host: string | null;
  /** The URL's path and query; `null` when the URL doesn't parse. */
  readonly path: string | null;
  readonly status: FetchStatus | null;
};
export type CaptureStep = StepBase & {
  readonly kind: "capture";
  readonly media: AttachmentKind;
  /** The route it captured, the attachment's own (`/history`). */
  readonly route: string;
  /** How many pictures: a run of screenshots one after another, or one recording. */
  readonly count: number;
  readonly width: number;
  /** The preview it captured: its process's or service's label, and its port when it was a port. */
  readonly preview: { readonly label: string | null; readonly port: number | null };
  /** Milestone 8's attachments, for the strip under the run's line. */
  readonly attachments: AttachmentsData;
};
export type SubagentStep = StepBase & { readonly kind: "subagent"; readonly node: SubagentNode };
export type SetupStep = StepBase & {
  readonly kind: "setup";
  readonly ms: number | null;
  readonly cache: "warm" | "cold" | null;
  readonly exitCode: number | null;
  readonly output: readonly SetupOutputLine[];
};
export type PrTextStep = StepBase & { readonly kind: "pr-text"; readonly title: string | null; readonly body: string | null };
export type OstraStep = StepBase & {
  readonly kind: "ostra";
  readonly tool: OstraToolKind;
  /** `null` while it runs, or when it failed or was cancelled (`state` says which). */
  readonly outcome: OstraOutcome | null;
  /** What the agent asked of it (a screenshot's route while it's taken). */
  readonly input: unknown;
};
export type ToolStep = StepBase & {
  readonly kind: "tool";
  /** The tool's name, its MCP server's prefix taken off; never the kind word `other`. */
  readonly name: string;
  readonly server: string | null;
  readonly input: unknown;
  readonly output: unknown;
};
export type CompactionStep = StepBase & { readonly kind: "compaction"; readonly summary: string | null };
export type InfoStep = StepBase & { readonly kind: "info"; readonly info: StepInfo };

/** One step of a run, by its kind. */
export type RunStep =
  | ReadStep
  | EditStep
  | CommandStep
  | ThoughtStep
  | SearchStep
  | WebSearchStep
  | FetchStep
  | CaptureStep
  | SubagentStep
  | SetupStep
  | PrTextStep
  | OstraStep
  | ToolStep
  | CompactionStep
  | InfoStep;

export type RunStepKind = RunStep["kind"];

/**
 * What a run's line counts, by kind: reads and edits count their distinct files, captures their
 * pictures, every other kind its steps. ostra's own tools and the PR's text count as tools.
 */
export const runCountKinds = ["read", "edit", "command", "search", "web-search", "fetch", "screenshot", "recording", "subagent", "setup", "compaction", "tool"] as const;
export type RunCountKind = (typeof runCountKinds)[number];

/** The kind a step counts as on its run's line, or `null` for one it doesn't count (a thought, an info line). */
export const countKindOf = (step: RunStep): RunCountKind | null => {
  switch (step.kind) {
    case "read":
    case "edit":
    case "command":
    case "search":
    case "web-search":
    case "fetch":
    case "subagent":
    case "setup":
    case "compaction":
      return step.kind;
    case "capture":
      return step.media;
    case "pr-text":
    case "ostra":
    case "tool":
      return "tool";
    case "thought":
    case "info":
      return null;
    default:
      return step satisfies never;
  }
};

/** How many steps a step is in a run's total: a capture is a picture each, a thought or an info line none. */
export const stepWeight = (step: RunStep): number => {
  if (countKindOf(step) === null) return 0;
  return step.kind === "capture" ? step.count : 1;
};

// ---- pieces ------------------------------------------------------------------------------

/** A text, an image or a link the agent sent: its prose. */
export type ProsePart = Extract<TaskUIPart, { type: "text" | "file" | "source-url" }>;
type QuestionPart = Extract<TaskUIPart, { type: "data-question" }>;
type AttachmentsPart = Extract<TaskUIPart, { type: "data-attachments" }>;
type ResultPart = Extract<TaskUIPart, { type: "data-pushed" | "data-pr" | "data-review" | "data-draft" | "data-memory-proposed" }>;
type SystemPart = Extract<TaskUIPart, { type: "data-system" | "data-limit" | "data-held" }>;

/** The preview a turn showed (`show_preview`): its label, port and path, as the agent named them. */
export type PreviewShown = { readonly label: string | null; readonly port: number | null; readonly path: string | null };

/**
 * A message's parts in the column's terms, in its order: a step, prose, a question, captures ostra
 * took after the turn, a result, a preview shown, or a row's failure or notice. Bookkeeping
 * (`step-start`, the plan's progress, the PR's text the PR card carries) is no piece.
 */
export type Piece =
  | { readonly t: "step"; readonly step: RunStep }
  | { readonly t: "prose"; readonly id: string; readonly part: ProsePart }
  | { readonly t: "question"; readonly part: QuestionPart }
  | { readonly t: "captures"; readonly part: AttachmentsPart }
  | { readonly t: "result"; readonly part: ResultPart }
  | { readonly t: "preview"; readonly toolCallId: string; readonly preview: PreviewShown }
  | { readonly t: "row"; readonly part: SystemPart };

// Agents' tool input and output are theirs: read leniently, unknown fields kept out of the way.
const pathInputSchema = z.object({ path: z.string().optional(), filePath: z.string().optional(), paths: z.array(z.string()).optional() });
const commandInputSchema = z.object({ command: z.string().optional() });
const searchInputSchema = z.object({ pattern: z.string().optional(), query: z.string().optional(), path: z.string().optional() });
const searchOutputSchema = z.object({ matches: z.number().optional() });
const queryInputSchema = z.object({ query: z.string().optional() });
const urlInputSchema = z.object({ url: z.string().optional() });
const prTextInputSchema = z.object({ title: z.string().optional(), body: z.string().optional() });
const previewInputSchema = z.object({ label: z.string().optional(), port: z.number().optional(), path: z.string().optional() });

/** The tool ostra's sidecar serves for the PR's text (milestone 1, F-030). */
const PR_TEXT_TOOL = "set_pull_request_text";

/** Whether a call is ostra's PR text tool, bare or with an agent's prefix (`ostra_`, `ostra.`, `ostra/`), as `ostraToolOf` reads ostra's other tools. */
const isPrTextTool = (title: string): boolean => title === PR_TEXT_TOOL || ["_", ".", "/"].some((separator) => title.endsWith(`${separator}${PR_TEXT_TOOL}`));

/** Whether a generic tool is a web search, by its name (`websearch`, `web_search`, `WebSearch`, `brave_web_search`). */
const isWebSearch = (title: string): boolean => title.toLowerCase().replace(/[^a-z]/g, "").endsWith("websearch");

/** A tool's name and its MCP server, when its title starts with one of the task's servers and `_` (OpenCode's naming); the longest server wins. */
export const toolNameOf = (title: string, mcpServers: readonly string[]): { readonly name: string; readonly server: string | null } => {
  const server = [...mcpServers].sort((a, b) => b.length - a.length).find((name) => name !== "" && title.startsWith(`${name}_`) && title.length > name.length + 1);
  return server === undefined ? { name: title, server: null } : { name: title.slice(server.length + 1), server };
};

/** A thought's first sentence, on one line, 120 characters at most. */
export const thoughtExcerpt = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length <= 120 ? sentence : `${sentence.slice(0, 119).trimEnd()}…`;
};

/** An HTTP status in a fetch's error (`Request failed with status code: 403 Forbidden`). */
const fetchStatusOf = (error: string | null): FetchStatus | null => {
  if (error === null) return null;
  const found = /\b([1-5]\d{2})\b(?:\s+([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*))?/.exec(error);
  if (found?.[1] === undefined) return null;
  return { code: Number(found[1]), text: found[2] ?? null };
};

const urlParts = (url: string): { readonly host: string | null; readonly path: string | null } => {
  try {
    const parsed = new URL(url);
    return { host: parsed.host === "" ? null : parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: null, path: null };
  }
};

const isToolPart = (part: TaskUIPart): part is TaskToolPart =>
  part.type === "dynamic-tool" || part.type === "tool-read" || part.type === "tool-edit" || part.type === "tool-execute";

/** A call's approval as its part carries it: the receipt once settled, pending until then. */
const approvalOf = (part: TaskToolPart): ApprovalStatus | null => {
  const metadata = approvalMetadataSchema.safeParse(part.toolMetadata);
  if (!metadata.success) return null;
  return metadata.data.approval.descriptor.receipt ?? { state: "pending" };
};

/** A call's state: a denied, closed or cancelled call never ran; a command that exited other than 0, or with no code, failed. */
const callState = (part: TaskToolPart, approval: ApprovalStatus | null): StepState => {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return "running";
    case "output-available": {
      if (part.preliminary === true) return "running";
      if (part.type === "tool-execute" && part.output.exitCode !== 0) return "failed";
      return "done";
    }
    case "output-denied":
      return "cancelled";
    case "output-error": {
      if (part.errorText === CANCELLED_TOOL_ERROR) return "cancelled";
      if (approval?.state === "closed" || (approval?.state === "answered" && approval.decision === "deny")) return "cancelled";
      return "failed";
    }
    default:
      return part satisfies never;
  }
};

/** How long a step took, from its times; `null` while it runs. */
const msOf = (time: StepTime | undefined): number | null => (time === undefined || time.endedAt === null ? null : Math.max(0, time.endedAt - (time.answeredAt ?? time.startedAt)));

const outputOf = (part: TaskToolPart): unknown => (part.state === "output-available" ? part.output : null);
const errorOf = (part: TaskToolPart): string | null => (part.state === "output-error" ? part.errorText : null);

/** The context `piecesOf` reads of a whole message, before its parts. */
type MessageFacts = {
  readonly times: Readonly<Record<string, StepTime>>;
  /** Each subagent by the calls that asked it (its first round's and each follow-up's). */
  readonly subagentByCall: ReadonlyMap<string, SubagentNode>;
  /** The turn's PR texts, in order, for its calls to the PR text tool. */
  readonly prTexts: readonly { readonly title: string; readonly body: string }[];
  /** The turn's review hand-ins, in order: whether each was a repeat. */
  readonly reviewRepeats: readonly boolean[];
};

const factsOf = (message: TaskUIMessage): MessageFacts => {
  const subagentByCall = new Map<string, SubagentNode>();
  for (const node of message.metadata?.subagents?.nodes ?? []) {
    for (const round of node.rounds) if (round.toolCallId !== null) subagentByCall.set(round.toolCallId, node);
    if (node.startedBy !== null) subagentByCall.set(node.startedBy, node);
  }
  return {
    times: message.metadata?.stepTimes ?? {},
    subagentByCall,
    prTexts: message.parts.flatMap((part) => (part.type === "data-pr-text" ? [{ title: part.data.title, body: part.data.body }] : [])),
    reviewRepeats: message.parts.flatMap((part) => (part.type === "data-review" ? [part.data.repeat] : [])),
  };
};

/** The pieces of one message, in its order (spec section 5.3). */
export const piecesOf = (message: TaskUIMessage, context: ThreadContext): Piece[] => {
  const facts = factsOf(message);
  const pieces: Piece[] = [];
  let thoughts = 0;
  let texts = 0;
  let prTextCalls = 0;
  let reviewCalls = 0;
  const path = (raw: string): string => workspacePath(raw, context);

  const dynamicStep = (part: Extract<TaskToolPart, { type: "dynamic-tool" }>, base: Omit<StepBase, "fullSubject">, title: string): RunStep => {
    const generic = (): RunStep => ({ ...base, kind: "tool", fullSubject: title, ...toolNameOf(title, context.mcpServers), input: part.input, output: outputOf(part) });
    const node = facts.subagentByCall.get(part.toolCallId);
    if (node !== undefined) {
      const state: StepState = node.state === "running" || node.state === "needs-approval" ? "running" : node.state === "failed" ? "failed" : node.state === "stopped" ? "cancelled" : "done";
      return { ...base, kind: "subagent", state, error: state === "failed" ? (node.error ?? base.error) : null, fullSubject: node.description === "" ? title : node.description, node };
    }
    const ostra = ostraToolOf(title);
    if (ostra !== null) {
      let outcome: OstraOutcome | null = base.state === "done" ? "done" : null;
      if (ostra === "submit_review" && base.state === "done") {
        outcome = facts.reviewRepeats[reviewCalls] === true ? "already-in" : "done";
        reviewCalls += 1;
      }
      return { ...base, kind: "ostra", fullSubject: title, tool: ostra, outcome, input: part.input };
    }
    if (isPrTextTool(title)) {
      const input = prTextInputSchema.safeParse(part.input);
      const set = base.state === "done" ? facts.prTexts[prTextCalls] : undefined;
      if (base.state === "done") prTextCalls += 1;
      return { ...base, kind: "pr-text", fullSubject: title, title: set?.title ?? (input.success ? (input.data.title ?? null) : null), body: set?.body ?? (input.success ? (input.data.body ?? null) : null) };
    }
    switch (part.toolName) {
      case "read": {
        const input = pathInputSchema.safeParse(part.input);
        const raw = (input.success ? (input.data.path ?? input.data.filePath) : undefined) ?? title;
        return { ...base, kind: "read", fullSubject: raw, paths: [path(raw)], toolCallIds: [part.toolCallId] };
      }
      case "edit": {
        const input = pathInputSchema.safeParse(part.input);
        const raws = input.success ? (input.data.paths ?? [input.data.path ?? input.data.filePath ?? title]) : [title];
        const files = raws.map((raw) => ({ path: path(raw), added: 0, removed: 0, patch: null }));
        return { ...base, kind: "edit", fullSubject: raws.join(", "), path: files[0]?.path ?? "", files, added: 0, removed: 0 };
      }
      case "execute": {
        const input = commandInputSchema.safeParse(part.input);
        const raw = (input.success ? input.data.command : undefined) ?? title;
        return { ...base, kind: "command", fullSubject: raw, line: workspaceCommand(raw, context), exit: null, ms: msOf(facts.times[part.toolCallId]), output: null, truncated: false };
      }
      case "search": {
        const input = searchInputSchema.safeParse(part.input);
        const output = searchOutputSchema.safeParse(outputOf(part));
        const query = (input.success ? (input.data.pattern ?? input.data.query) : undefined) ?? title;
        const folder = input.success && input.data.path !== undefined ? path(input.data.path) : null;
        return { ...base, kind: "search", fullSubject: input.success && input.data.path !== undefined ? `${query} in ${input.data.path}` : query, query, folder, matches: output.success ? (output.data.matches ?? null) : null };
      }
      case "fetch": {
        const input = urlInputSchema.safeParse(part.input);
        const url = (input.success ? input.data.url : undefined) ?? title;
        return { ...base, kind: "fetch", fullSubject: url, url, ...urlParts(url), status: fetchStatusOf(errorOf(part)) };
      }
      case "other": {
        if (!isWebSearch(title)) return generic();
        const input = queryInputSchema.safeParse(part.input);
        const query = input.success ? (input.data.query ?? null) : null;
        return { ...base, kind: "web-search", fullSubject: query ?? title, query };
      }
      case "delete":
      case "move":
      case "think":
      case "switch_mode":
        return generic();
      default:
        return generic();
    }
  };

  const call = (part: TaskToolPart): RunStep => {
    const approval = approvalOf(part);
    const state = callState(part, approval);
    const time = facts.times[part.toolCallId];
    const base = { id: `step:${part.toolCallId}`, toolCallId: part.toolCallId, startedAt: time?.startedAt ?? null, endedAt: time?.endedAt ?? null, state, approval, error: state === "failed" ? errorOf(part) : null };
    const title = part.title ?? "";
    switch (part.type) {
      case "tool-read": {
        // A typed part's input is whole once its call came (the fold makes no streaming input); read leniently all the same.
        const input = pathInputSchema.safeParse(part.input);
        const raw = (input.success ? input.data.path : undefined) ?? title;
        return { ...base, kind: "read", fullSubject: raw, paths: [path(raw)], toolCallIds: [part.toolCallId] };
      }
      case "tool-edit": {
        const input = pathInputSchema.safeParse(part.input);
        const asked = input.success ? (input.data.paths ?? []) : [];
        const changed = part.state === "output-available" ? part.output.files : [];
        const files: EditedFile[] = changed.length > 0 ? changed.map((file) => ({ path: path(file.path), added: file.added, removed: file.removed, patch: file.patch ?? null })) : asked.map((raw) => ({ path: path(raw), added: 0, removed: 0, patch: null }));
        return {
          ...base,
          kind: "edit",
          fullSubject: (changed.length > 0 ? changed.map((file) => file.path) : asked).join(", "),
          path: files[0]?.path ?? "",
          files,
          added: files.reduce((sum, file) => sum + file.added, 0),
          removed: files.reduce((sum, file) => sum + file.removed, 0),
        };
      }
      case "tool-execute": {
        const input = commandInputSchema.safeParse(part.input);
        const raw = (input.success ? input.data.command : undefined) ?? title;
        const output = part.state === "output-available" ? { ...part.output, ended: part.preliminary !== true } : null;
        return {
          ...base,
          kind: "command",
          fullSubject: raw,
          line: workspaceCommand(raw, context),
          exit: output?.ended === true ? (output.exitCode ?? "killed") : null,
          ms: msOf(time),
          output: output?.output ?? null,
          truncated: output?.truncated ?? false,
        };
      }
      case "dynamic-tool":
        return dynamicStep(part, base, title);
      default:
        return part satisfies never;
    }
  };

  for (const [index, part] of message.parts.entries()) {
    if (isToolPart(part)) {
      const step = call(part);
      pieces.push({ t: "step", step });
      // Milestone 8: a preview shown is also what the turn made: a result line after its prose.
      if (step.kind === "ostra" && step.tool === "show_preview" && step.state === "done") {
        const input = previewInputSchema.safeParse(part.input);
        pieces.push({ t: "preview", toolCallId: part.toolCallId, preview: input.success ? { label: input.data.label ?? null, port: input.data.port ?? null, path: input.data.path ?? null } : { label: null, port: null, path: null } });
      }
      continue;
    }
    switch (part.type) {
      case "text":
        if (part.text.trim() !== "") pieces.push({ t: "prose", id: `prose:${String(texts)}`, part });
        texts += 1;
        break;
      case "file":
      case "source-url":
        pieces.push({ t: "prose", id: `prose:${String(index)}`, part });
        break;
      case "reasoning": {
        const key = thoughtTimeKey(thoughts);
        thoughts += 1;
        const time = facts.times[key];
        const endedAt = part.state === "streaming" ? null : (time?.endedAt ?? null);
        pieces.push({
          t: "step",
          step: {
            id: `step:${key}`,
            kind: "thought",
            toolCallId: null,
            startedAt: time?.startedAt ?? null,
            endedAt,
            state: part.state === "streaming" ? "running" : "done",
            fullSubject: part.text,
            approval: null,
            error: null,
            excerpt: thoughtExcerpt(part.text),
            text: part.text,
            ms: endedAt === null || time === undefined ? null : Math.max(0, endedAt - time.startedAt),
          },
        });
        break;
      }
      case "data-attachments": {
        if (part.data.source !== "agent") {
          pieces.push({ t: "captures", part });
          break;
        }
        const [first] = part.data.items;
        if (first === undefined) break;
        const target = first.target;
        pieces.push({
          t: "step",
          step: {
            id: `step:${part.id ?? `attachments:${String(index)}`}`,
            kind: "capture",
            toolCallId: null,
            startedAt: first.at,
            endedAt: part.data.items.at(-1)?.at ?? first.at,
            state: "done",
            fullSubject: first.path,
            approval: null,
            error: null,
            media: part.data.kind,
            route: first.path,
            count: part.data.items.length,
            width: first.width,
            preview: "process" in target ? { label: target.process, port: null } : "port" in target ? { label: null, port: target.port } : { label: target.service, port: null },
            attachments: part.data,
          },
        });
        break;
      }
      case "data-setup": {
        const { data } = part;
        pieces.push({
          t: "step",
          step: {
            id: `step:${part.id ?? `setup:${data.sessionId}`}`,
            kind: "setup",
            toolCallId: null,
            startedAt: null,
            endedAt: null,
            state: data.state === "running" ? "running" : data.state === "succeeded" ? "done" : "failed",
            fullSubject: "setup",
            approval: null,
            error: null,
            ms: data.durationMs ?? null,
            cache: data.dependencyCache ?? null,
            exitCode: data.exitCode ?? null,
            output: data.output,
          },
        });
        break;
      }
      case "data-compaction":
        pieces.push({ t: "step", step: { id: `step:${part.id ?? `compaction:${String(index)}`}`, kind: "compaction", toolCallId: null, startedAt: null, endedAt: null, state: part.data.status === "running" ? "running" : "done", fullSubject: "compaction", approval: null, error: null, summary: part.data.summary ?? null } });
        break;
      case "data-app-process":
        pieces.push({ t: "step", step: infoStep(`step:${part.id ?? `app:${String(index)}`}`, { about: "app-process", appProcess: part.data }, part.data.state === "starting" ? "running" : "done", part.data.name) });
        break;
      case "data-attachment-skipped":
        pieces.push({ t: "step", step: infoStep(`step:${part.id ?? `skipped:${String(index)}`}`, { about: "capture-skipped", skipped: part.data }, "done", part.data.reason) });
        break;
      case "data-no-browser":
        pieces.push({ t: "step", step: infoStep(`step:${part.id ?? `no-browser:${String(index)}`}`, { about: "no-browser", noBrowser: part.data }, "done", part.data.reason) });
        break;
      case "data-question":
        pieces.push({ t: "question", part });
        break;
      case "data-pushed":
      case "data-pr":
      case "data-review":
      case "data-draft":
      case "data-memory-proposed":
        pieces.push({ t: "result", part });
        break;
      case "data-system":
      case "data-limit":
      case "data-held":
        pieces.push({ t: "row", part });
        break;
      case "step-start":
      case "source-document":
      case "reasoning-file":
      case "custom":
      case "steering-message":
      case "data-plan":
      case "data-pr-text":
      case "data-session-end":
      case "data-saved":
      case "data-driver":
      case "data-effort":
      case "data-files-outside":
      case "data-released":
      case "data-pr-comment":
      case "data-ticket-files":
      case "data-message-files":
      case "data-unsupported":
      case "data-problem":
        // Not a step: the plan's progress is the live step's; the PR's text is its card's and its
        // call's; the rest are a member's message's, a divider's, or a row the panel draws from
        // its message. Bookkeeping left the parts in ticket 02.
        break;
      default:
        part satisfies never;
    }
  }
  return pieces;
};

const infoStep = (id: string, info: StepInfo, state: StepState, fullSubject: string): InfoStep => ({ id, kind: "info", toolCallId: null, startedAt: null, endedAt: null, state, fullSubject, approval: null, error: null, info });

/** A message's steps, in its order: each call, thought and capture once (the turn's atoms, before reads share a row). */
export const stepsOf = (message: TaskUIMessage, context: ThreadContext): RunStep[] =>
  piecesOf(message, context).flatMap((piece) => (piece.t === "step" ? [piece.step] : []));
