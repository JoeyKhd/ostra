"use client";

import { TextMessagePartProvider } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  AppWindowIcon,
  ArchiveIcon,
  BrainIcon,
  HistoryIcon,
  LayersIcon,
  LightbulbIcon,
  PauseIcon,
  PlayIcon,
  SquarePlayIcon,
  CheckIcon,
  CircleDotIcon,
  CircleIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  InfoIcon,
  PencilIcon,
  SquareTerminalIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ImgHTMLAttributes, ReactNode } from "react";

import { SHOW_PREVIEW_TOOL, showPreviewInputSchema } from "@ostra/protocol";
import type { ShowPreviewInput } from "@ostra/protocol";

import { approvalMetadataSchema } from "@ostra/task-view";
import type { QuestionData, SubagentNode, TaskDataPart } from "@ostra/task-view";

import { AppProcessLine, AttachmentsRow, NoBrowserLine, SkippedLine } from "@/components/tasks/attachments/attachment-strip";
import { monthWord } from "@/components/tasks/budget-reason";
import { RowState } from "@/components/tasks/subagent-marks";
import { TicketFilesRow } from "@/components/tasks/attachments/thread-files";
import { callCount, nodeDurationMs, shortDuration, stateWord, subagentLabel } from "@/components/tasks/subagent-words";
import { NeedsYou } from "@/components/ui/needs-you";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/messages";

import { filesOutsideText } from "./files-outside-words";
import { restoredDetail, savedDetail } from "./marker-words";
import { useDataPart, useSubagentOwner, useSubagentStartedBy, useTaskContext, useToolPart } from "./task-context";
import type { ToolLikePart } from "./task-context";
import { Divider } from "./thread/divider";
import { DiffBlock, OutputBlock } from "./thread/step-output";

// Renderers keyed by ACP `kind`, never by an agent's tool name, so every agent renders alike
// (ADR 0036). Agent text, diffs and command output are untrusted (AGENTS.md): markdown with no raw
// HTML, safe links only, command output as plain text, and nothing here loads a remote resource.
// Ported from spikes/live-stream-and-task-view/src/web/renderers.tsx.

/** An http(s) link, or `null`: never `javascript:`, `data:` or a relative path the agent made up. */
export const safeHref = (href: string | undefined): string | null => {
  if (href === undefined) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export const SafeLink = ({ href, children }: { readonly href?: string | undefined; readonly children?: ReactNode }) => {
  const safe = safeHref(href);
  return safe === null ? (
    <span>{children}</span>
  ) : (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-teal hover:underline">
      {children}
    </a>
  );
};

const markdownComponents = {
  a: SafeLink,
  // A remote image would be a request to a third party: it shows as text.
  img: ({ alt }: { readonly alt?: string | undefined }) => <span className="text-faint">[{alt ?? t("task.image")}]</span>,
};

export const AssistantText = ({ streaming }: { readonly streaming: boolean }) => (
  <div data-part="text" data-streaming={streaming ? "true" : "false"} className="agent-md">
    <MarkdownTextPrimitive smooth={false} components={markdownComponents} />
  </div>
);

/**
 * F-138: an agent's text outside the thread's parts (a subagent's prompt and answer, in its
 * window), with the thread's own rules: markdown, no raw HTML, safe links, no remote image.
 */
export const AgentMarkdown = ({ text, className, image, streaming, "data-part": dataPart }: {
  readonly text: string;
  readonly className?: string;
  /** Milestone 9 (ticket 16): how a picture in it shows, in place of `[alt]` (a ticket's stored file opens the viewer). */
  readonly image?: (props: ImgHTMLAttributes<HTMLImageElement>) => ReactNode;
  /** Milestone 10 (F-151): the agent's prose in the thread, while it streams. */
  readonly streaming?: boolean;
  readonly "data-part"?: string;
}) => (
  <TextMessagePartProvider text={text} isRunning={streaming === true}>
    <div className={cn("agent-md", className)} data-part={dataPart} data-streaming={streaming === undefined ? undefined : streaming ? "true" : "false"}>
      <MarkdownTextPrimitive smooth={false} components={image === undefined ? markdownComponents : { ...markdownComponents, img: image }} />
    </div>
  </TextMessagePartProvider>
);

export const Reasoning = ({ text, streaming }: { readonly text: string; readonly streaming: boolean }) => (
  <details data-part="reasoning" data-streaming={streaming ? "true" : "false"} open={streaming} className="group text-muted">
    <summary className="flex min-h-7 cursor-pointer list-none items-center text-body hover:text-text">
      <span className="flex w-8 shrink-0 pl-1.5 text-faint"><BrainIcon className="size-[14px] stroke-[1.75]" /></span>
      {streaming ? t("task.thinking") : t("task.thought")}
    </summary>
    <p className="mb-1 ml-8 whitespace-pre-wrap border-l border-line pl-3 text-sm">{text}</p>
  </details>
);

/**
 * One activity line (task.md, "Tool rows"): a 32px icon column, the verb in a fixed 72px column so
 * every path starts at the same x, the subject, then its result inline after it (never pushed to the
 * far edge). A line without a verb (a system line) runs its text from the verb's column.
 */
const Line = ({ icon, verb, children, end, tone }: {
  readonly icon: ReactNode;
  readonly verb?: ReactNode;
  readonly children: ReactNode;
  readonly end?: ReactNode;
  readonly tone?: "red" | "muted" | undefined;
}) => (
  <div className={cn("flex min-h-7 min-w-0 items-center text-body", tone === "red" && "text-red", tone === "muted" && "text-muted")}>
    <span className="flex w-8 shrink-0 pl-1.5 text-faint [&_svg]:size-[14px] [&_svg]:stroke-[1.75]">{icon}</span>
    {verb === undefined ? null : <span data-verb className="w-[72px] shrink-0 text-muted">{verb}</span>}
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      {children}
      {end === undefined ? null : <span className="ml-1 shrink-0 font-mono text-sm">{end}</span>}
    </span>
  </div>
);

/** The teal "Show the output" under a line, at the path column; underlined on hover only. */
const Disclosure = ({ open, onToggle, children }: { readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode }) => (
  <button type="button" className="ml-[104px] block text-sm text-teal hover:underline" aria-expanded={open} onClick={onToggle}>
    {children}
  </button>
);

const Mono = ({ children }: { readonly children: ReactNode }) => <span className="min-w-0 break-all font-mono text-ui text-text">{children}</span>;

/** A tool's verb while it runs ("Running", "Editing") and after ("Ran", "Edited"). */
const runningVerb = (running: boolean, now: string, then: string): string => (running ? now : then);

const running = (part: ToolLikePart): boolean =>
  part.state === "input-available" || part.state === "input-streaming" || (part.state === "output-available" && part.preliminary === true);

const ToolStatus = ({ part }: { readonly part: ToolLikePart }) => {
  if (part.state === "output-error") return <span className="font-sans text-red">{part.errorText === "cancelled" ? t("task.tool.cancelled") : t("task.tool.failed")}</span>;
  if (part.state === "output-denied") return <span className="font-sans text-red">{t("task.tool.denied")}</span>;
  if (part.state === "approval-requested") return <span className="font-sans text-amber-text">{t("task.tool.needsApproval")}</span>;
  if (running(part)) return <span className="font-sans text-faint">{t("task.tool.running")}</span>;
  return null;
};

/** What a pending approval asks to run: the command, the paths, or the tool's title. */
const approvalSubject = (part: ToolLikePart): string | null => {
  switch (part.type) {
    case "tool-execute":
      return part.input?.command ?? null;
    case "tool-read":
      return part.input?.path ?? null;
    case "tool-edit":
      return part.input?.paths?.join(", ") ?? null;
    case "dynamic-tool":
      return part.title ?? null;
    default:
      return part satisfies never;
  }
};

/**
 * The approval (task.md, "Approval block"): pending, the shared amber-ruled `NeedsYou` block with the
 * descriptor's summary and the command; answered, one muted line. Read-only in milestone 1:
 * answering comes with F-026 in milestone 3, so the buttons' place holds the read-only line.
 */
/** F-138: what a subagent's call that asks says first, by its kind (`explore · Find the version source asks before running this command:`). */
const subagentAsks = (part: ToolLikePart, asker: string): string => {
  switch (part.type) {
    case "tool-execute":
      return t("task.subagents.asks.command", { subagent: asker });
    case "tool-edit":
      return t("task.subagents.asks.path", { subagent: asker });
    case "tool-read":
    case "dynamic-tool":
      return t("task.subagents.asks.other", { subagent: asker });
    default:
      return part satisfies never;
  }
};

/**
 * The approval of a call. F-138: `asker` names the subagent whose call it is, in the card's first
 * line and before its receipt, so the thread says which subagent asks.
 */
export const ApprovalNote = ({ part, asker, className }: { readonly part: ToolLikePart; readonly asker?: string; readonly className?: string }) => {
  const { memberName, approvalSummary, approvalCard, approvalReceipt, approvalLostRace } = useTaskContext();
  const metadata = approvalMetadataSchema.safeParse(part.toolMetadata);
  if (!metadata.success) return null;
  const approvalId = metadata.data.approval.id;
  const receipt = metadata.data.approval.descriptor.receipt;
  const named = (text: string): string => (asker === undefined ? text : t("task.subagents.receipt", { subagent: asker, receipt: text }));
  // Milestone 3 (ticket 43): the task page answers it, and words its receipt with the rule and the reason.
  const card = receipt === undefined ? approvalCard?.(approvalId, asker) : undefined;
  if (card !== undefined && card !== null) return <>{card}</>;
  // Lost the race (task-approval.md, "Lost the race"): a line under the winner's receipt, for this member only.
  const lost = approvalLostRace?.(approvalId) === true ? <p data-part="lost-race" className={cn("ml-[104px] text-xs text-muted", className)}>{t("taskAnswers.answeredFirst")}</p> : null;
  // `tasks.get` can know the answer before the stream brings its event: its receipt shows from then.
  const worded = approvalReceipt?.(approvalId) ?? null;
  if (worded !== null) return <><div data-part="approval" data-state={receipt?.state} className={cn("ml-[104px] text-sm text-muted", className)}>{named(worded)}</div>{lost}</>;
  if (receipt === undefined) {
    const summary = approvalSummary(metadata.data.approval.id);
    const subject = approvalSubject(part);
    return (
      <NeedsYou data-testid="approval" title={t("task.approval.title")} footer={t("task.approval.readOnly")}>
        <div data-part="approval" data-state="pending">
          {asker === undefined ? null : <p data-part="asker">{subagentAsks(part, asker)}</p>}
          {summary === null ? null : <p className="whitespace-pre-wrap">{summary}</p>}
          {subject === null ? null : (
            <code className="mt-2 inline-block max-w-full break-all rounded-sm border border-line bg-surface px-2.5 py-1.5 font-mono text-ui leading-[1.4] text-text">{subject}</code>
          )}
        </div>
      </NeedsYou>
    );
  }
  let text: string;
  switch (receipt.state) {
    case "answered":
      text =
        receipt.decision === "allow_once"
          ? t("task.approval.once", { name: memberName(receipt.by) })
          : receipt.decision === "allow_task"
            ? t("task.approval.task", { name: memberName(receipt.by) })
            : t("task.approval.denied", { name: memberName(receipt.by) });
      break;
    case "auto":
      text = t("task.approval.auto", { rule: receipt.ruleId });
      break;
    case "closed":
      text = receipt.reason === "expired" ? t("task.approval.expired") : t("task.approval.cancelled");
      break;
    default:
      return receipt satisfies never;
  }
  return <><div data-part="approval" data-state={receipt.state} className={cn("ml-[104px] text-sm text-muted", className)}>{named(text)}</div>{lost}</>;
};

/** `show_preview`, whatever prefix its agent names it with (`ostra_show_preview`). */
const isShowPreview = (name: string): boolean => name === SHOW_PREVIEW_TOOL || [`_${SHOW_PREVIEW_TOOL}`, `.${SHOW_PREVIEW_TOOL}`, `/${SHOW_PREVIEW_TOOL}`].some((end) => name.endsWith(end));

/**
 * The agent's `show_preview` as milestone 1's tool row (task-preview.md, "The thread's Preview row"):
 * `app-window`, `Preview`, the label and port in mono, the path in `--faint`, and a teal `Show` that
 * opens the pane on it. A port the agent opened is the preview `port-<port>`; the pane falls back to
 * the primary when the task has no such preview.
 */
const PreviewShownRow = ({ input }: { readonly input: ShowPreviewInput }) => {
  const query = new URLSearchParams({ pane: "preview", preview: `port-${String(input.port)}`, ...(input.path === undefined ? {} : { path: input.path }) });
  return (
    <Line
      icon={<AppWindowIcon />}
      verb={t("task.preview.row.verb")}
      end={<Link href={`?${query.toString()}`} className="font-sans text-teal hover:underline" data-action="show-preview">{t("task.preview.row.show")}</Link>}
    >
      <span className="font-mono">{input.label} <span className="text-faint">:{input.port}</span></span>
      {input.path === undefined ? null : <span className="font-mono text-faint">{input.path}</span>}
    </Line>
  );
};

export const ToolBody = ({ part }: { readonly part: ToolLikePart }) => {
  const [open, setOpen] = useState(false);
  switch (part.type) {
    case "tool-read":
      return (
        <Line icon={<FileTextIcon />} verb={t("task.tool.read")} end={<ToolStatus part={part} />} tone={part.state === "output-error" ? "red" : undefined}>
          <Mono>{part.input?.path ?? ""}</Mono>
          {part.state === "output-error" ? <span className="text-sm text-red">{part.errorText}</span> : null}
        </Line>
      );
    case "tool-edit": {
      const done = part.state === "output-available";
      // An edit whose output names no file (a new file its tool reported no diff for) still shows its paths.
      const files = done && part.output.files.length > 0 ? part.output.files : null;
      const patch = files?.map((file) => file.patch ?? "").join("\n").trim() ?? "";
      return (
        <div>
          {(files ?? (part.input?.paths ?? []).map((path) => ({ path, added: null, removed: null }))).map((file) => (
            <Line
              key={file.path}
              icon={<PencilIcon />}
              verb={runningVerb(!done, t("task.tool.editing"), t("task.tool.edited"))}
              end={<ToolStatus part={part} />}
            >
              <Mono>{file.path}</Mono>
              {file.added === null ? null : <span className="ml-1 font-mono text-sm text-green">+{file.added}</span>}
              {file.removed === null || file.removed === 0 ? null : <span className="font-mono text-sm text-red">−{file.removed}</span>}
            </Line>
          ))}
          {patch === "" ? null : (
            <>
              <Disclosure open={open} onToggle={() => { setOpen((v) => !v); }}>
                {open ? t("task.tool.hideDiff") : t("task.tool.showDiff")}
              </Disclosure>
              {open ? <DiffBlock patch={patch} className="my-1 ml-[104px]" /> : null}
            </>
          )}
        </div>
      );
    }
    case "tool-execute": {
      const output = part.state === "output-available" ? part.output : null;
      const exit = part.state === "output-available" && part.preliminary !== true ? part.output.exitCode : undefined;
      return (
        <div>
          <Line
            icon={<TerminalIcon />}
            verb={runningVerb(running(part), t("task.tool.runningVerb"), t("task.tool.ran"))}
            tone={part.state === "output-error" ? "red" : undefined}
            end={
              exit === undefined ? <ToolStatus part={part} /> : exit === 0 ? (
                <span className="inline-flex items-center gap-1 text-green"><CheckIcon className="size-3" /> {t("task.tool.exit", { code: 0 })}</span>
              ) : (
                <span className="text-red">{exit === null ? t("task.tool.killed") : t("task.tool.exit", { code: exit })}</span>
              )
            }
          >
            <Mono>{part.input?.command ?? ""}</Mono>
          </Line>
          {output === null ? null : (
            <>
              <Disclosure open={open} onToggle={() => { setOpen((v) => !v); }}>
                {open ? t("task.tool.hideOutput") : t("task.tool.showOutput")}
              </Disclosure>
              {open ? <OutputBlock text={output.output} truncated={output.truncated} className="my-1 ml-[104px]" /> : null}
            </>
          )}
          {part.state === "output-error" ? <p className="ml-[104px] text-sm text-red">{part.errorText}</p> : null}
        </div>
      );
    }
    case "dynamic-tool": {
      // The agent opened a port for the pane (`show_preview`): the thread's Preview row (task-preview.md).
      const shown = isShowPreview(part.toolName) ? showPreviewInputSchema.safeParse(part.input) : null;
      if (shown?.success === true) return <PreviewShownRow input={shown.data} />;
      return (
        <Line icon={part.toolName === "execute" ? <SquareTerminalIcon /> : <WrenchIcon />} verb={<span className="block truncate pr-2">{part.toolName}</span>} end={<ToolStatus part={part} />} tone={part.state === "output-error" ? "red" : undefined}>
          <span className="min-w-0 truncate">{part.title ?? ""}</span>
          {part.state === "output-error" ? <span className="text-sm text-red">{part.errorText}</span> : null}
        </Line>
      );
    }
    default:
      return part satisfies never;
  }
};

/**
 * F-138: the call that started a subagent, as one line (task-subagents-tree.md, "The thread"): Lucide
 * `layers`, `Subagent`, its type in mono and its description, then its calls, its time once it
 * ended, and its state. A button: the thread's opens the window on it, the window's selects it.
 */
export const SubagentRow = ({ node, onOpen, popup, compact = false }: { readonly node: SubagentNode; readonly onOpen: () => void; readonly popup: boolean; readonly compact?: boolean }) => {
  const ended = node.endedAt === null ? null : nodeDurationMs(node, node.endedAt);
  const word = stateWord(node.state);
  return (
    <button
      type="button"
      data-part="subagent-row"
      data-subagent={node.id}
      data-state={node.state}
      aria-haspopup={popup ? "dialog" : undefined}
      onClick={onOpen}
      className="block w-full min-w-0 rounded-md text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-text"
    >
      <Line
        icon={<LayersIcon />}
        verb={t("task.subagents.verb")}
        end={
          <span className="inline-flex items-center gap-2 text-xs text-faint">
            {/* In the window's narrow pane, the state alone: its node has the rest. */}
            {compact ? null : <span>{ended === null ? callCount(node.callCount) : `${callCount(node.callCount)} · ${shortDuration(ended)}`}</span>}
            <RowState state={node.state} word={word} />
          </span>
        }
      >
        {node.type === null ? null : <span className="font-mono text-ui text-text">{node.type}</span>}
        {node.type === null || node.description === "" ? null : <span aria-hidden className="text-faint">·</span>}
        <span className="min-w-0 truncate text-muted">{node.description}</span>
      </Line>
    </button>
  );
};

export const ToolRow = ({ toolCallId }: { readonly toolCallId: string }) => {
  const part = useToolPart(toolCallId);
  const started = useSubagentStartedBy(toolCallId);
  const owner = useSubagentOwner(toolCallId);
  const { openSubagents } = useTaskContext();
  if (part === undefined) return null;
  if (started !== undefined && openSubagents !== undefined) {
    // F-138: the main agent's call that started a subagent opens the window on it. Nothing is nested under it.
    return (
      <div data-part="tool" data-tool-kind="subagent" data-state={part.state}>
        <SubagentRow node={started.node} popup onOpen={() => { openSubagents(started.messageId, started.node.id); }} />
      </div>
    );
  }
  if (owner !== undefined) {
    // F-138: a subagent's call is in the thread for its approval only, which names the subagent.
    return (
      <div data-part="tool" data-subagent={owner.node.id} data-state={part.state}>
        <ApprovalNote part={part} asker={subagentLabel(owner.node)} className="ml-8" />
      </div>
    );
  }
  return (
    <div data-part="tool" data-tool-kind={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} data-state={part.state}>
      <ToolBody part={part} />
      <ApprovalNote part={part} />
    </div>
  );
};

const PlanStatus = ({ status }: { readonly status: "pending" | "in_progress" | "completed" }) =>
  status === "completed" ? <CheckIcon className="size-3 text-green" /> : status === "in_progress" ? <CircleDotIcon className="size-3 text-teal" /> : <CircleIcon className="size-3 text-faint" />;

/** Done and pending steps are muted (no line-through: it reads as deleted); the current one is `--text`. */
const planTone = (status: "pending" | "in_progress" | "completed"): string => (status === "in_progress" ? "text-text" : "text-muted");

/**
 * The agent's question (milestone 3): open, the page's answerable card, or the read-only block;
 * answered or closed, its words and who answered. Milestone 10 (F-151): the compact thread draws it
 * at its place in the turn (ticket 13 restyles it; an answered one is ticket 12's receipt there).
 */
export const QuestionBlock = ({ data }: { readonly data: QuestionData }) => {
  const { memberName, questionCard } = useTaskContext();
  const status = data.status;
  const card = status.state === "open" ? questionCard?.(data.questionId) : undefined;
  if (card !== undefined && card !== null) return <div data-part="question">{card}</div>;
  return (
    <div data-part="question">
      {status.state === "open" ? (
        <NeedsYou data-testid="question" title={t("task.question.title")} footer={t("task.question.readOnly")}>
          <AgentMarkdown text={data.message} />
        </NeedsYou>
      ) : (
        <div className="my-1">
          <AgentMarkdown text={data.message} />
          <p className="text-sm text-muted">
            {status.state === "answered" ? t("task.question.answered", { name: memberName(status.answeredBy) }) : t("task.question.closed", { reason: status.closedReason })}
          </p>
        </div>
      )}
    </div>
  );
};

const DataBody = ({ part }: { readonly part: TaskDataPart }) => {
  const { memberName } = useTaskContext();
  const [open, setOpen] = useState(false);
  switch (part.type) {
    case "data-plan":
      return (
        <div data-part="plan" className="my-2">
          <div className="mb-0.5 text-sm text-faint">{t("task.plan")}</div>
          <ul>
            {part.data.entries.map((entry, i) => (
              <li key={i} data-status={entry.status} className={cn("flex min-h-6 items-center text-body", planTone(entry.status))}>
                <span className="flex w-8 shrink-0 pl-1.5"><PlanStatus status={entry.status} /></span>
                {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "data-question":
      return <QuestionBlock data={part.data} />;
    case "data-compaction":
      return (
        <Line icon={<InfoIcon />} tone="muted">
          {part.data.status === "running" ? t("task.compacting") : t("task.compacted")}
        </Line>
      );
    case "data-setup": {
      const setup = part.data;
      const text = setup.output.map((line) => line.text).join("");
      return (
        <div data-part="setup" data-state={setup.state}>
          <Line
            icon={<SquareTerminalIcon />}
            tone={setup.state === "failed" ? "red" : undefined}
            end={
              setup.state === "running" ? <span className="font-sans text-faint">{t("task.tool.running")}</span> : (
                <span className={setup.state === "succeeded" ? "text-green" : "text-red"}>
                  {setup.state === "succeeded" ? t("task.setup.ok") : setup.exitCode === null || setup.exitCode === undefined ? t("task.tool.killed") : t("task.tool.exit", { code: setup.exitCode })}
                  {setup.durationMs === undefined ? "" : ` · ${formatDuration(setup.durationMs)}`}
                  {setup.dependencyCache === undefined ? null : <span className="text-faint" data-dependency-cache={setup.dependencyCache}> · {t(`task.setup.cache.${setup.dependencyCache}`)}</span>}
                </span>
              )
            }
          >
            <span className="text-muted">{t("task.setup.title")}</span>
          </Line>
          {text === "" ? null : (
            <>
              <Disclosure open={open || setup.state === "failed"} onToggle={() => { setOpen((v) => !v); }}>
                {open ? t("task.setup.hide") : t("task.setup.show")}
              </Disclosure>
              {open || setup.state === "failed" ? <OutputBlock text={text} className="my-1 ml-[104px]" /> : null}
            </>
          )}
        </div>
      );
    }
    case "data-pushed":
      return (
        <Line icon={<GitBranchIcon />} tone="muted">
          {part.data.hidden ? t("task.pushedHidden") : t("task.pushed")}
          <Mono>{part.data.hidden ? part.data.ref : part.data.branch}</Mono>
          <span className="font-mono text-sm text-faint">{part.data.headSha.slice(0, 7)}</span>
        </Line>
      );
    case "data-pr-text":
      return (
        <div data-part="pr-text">
          <Line icon={<GitPullRequestIcon />} tone="muted">
            {t("task.prText")} <span className="text-text">{part.data.title}</span>
          </Line>
          <Disclosure open={open} onToggle={() => { setOpen((v) => !v); }}>
            {open ? t("task.prBodyHide") : t("task.prBodyShow")}
          </Disclosure>
          {open ? <OutputBlock text={part.data.body} className="my-1 ml-[104px]" /> : null}
        </div>
      );
    case "data-pr":
      return (
        <div data-part="pr">
          <Line icon={<GitPullRequestIcon />}>
            <span className="text-green">{t("task.prOpened")}</span>
            <SafeLink href={part.data.url}>#{part.data.number}{part.data.title === undefined ? "" : ` ${part.data.title}`}</SafeLink>
          </Line>
        </div>
      );
    case "data-session-end":
      return (
        <div data-part="session-end" data-outcome={part.data.outcome}>
          <Line icon={<InfoIcon />} tone="muted">
            {part.data.outcome === "with-changes" ? t("task.endedWithChanges") : t("task.endedWithoutChanges")}
          </Line>
        </div>
      );
    case "data-files-outside":
      // Q133: the names the agent left beside the repos. The item itself is on Home and the task's needs-you list.
      return (
        <div data-part="files-outside">
          <Line icon={<FileTextIcon />} tone="muted">
            {filesOutsideText(part.data)}
          </Line>
        </div>
      );
    case "data-saved":
      return (
        <div data-part="saved">
          <Line icon={<ArchiveIcon />} tone="muted">
            {t("task.saved", { n: part.data.turnOrdinal })}
            <span className="font-mono text-sm text-faint">{savedDetail(part.data)}</span>
          </Line>
        </div>
      );
    case "data-limit":
      return (
        <div data-part="limit" data-limit={part.data.limit}>
          <Line icon={<TriangleAlertIcon />} tone="muted">
            {t(`task.limit.${part.data.limit}`, { n: Math.round(part.data.observed) })}
          </Line>
        </div>
      );
    case "data-held":
      return <HeldRow at={part.data.at} scope={part.data.scope} />;
    case "data-released":
      return (
        <div data-part="released">
          <Line icon={<PlayIcon />} tone="muted">
            {t("task.released")}
          </Line>
        </div>
      );
    case "data-memory-proposed":
      return (
        <div data-part="memory-proposed">
          <Line icon={<LightbulbIcon />} tone="muted">
            {t("task.memoryProposed", { title: part.data.title })}
          </Line>
        </div>
      );
    case "data-pr-comment":
      // Milestone 10 (F-151, ticket 12): an `@ostra` comment is its message's outlined bubble (`thread/pr-comment.tsx`).
      return null;
    case "data-ticket-files":
      // Milestone 9 (ticket 16): gone once the ticket's files came as message files ("What the agent got").
      return <TicketFilesRow paths={part.data.paths} line={(icon, children) => <Line icon={icon} tone="muted">{children}</Line>} />;
    case "data-attachments":
      return <AttachmentsRow data={part.data} />;
    case "data-attachment-skipped":
      return <SkippedLine data={part.data} />;
    case "data-app-process":
      return <AppProcessLine data={part.data} />;
    case "data-no-browser":
      return <NoBrowserLine data={part.data} />;
    case "data-driver":
      return (
        <Line icon={<InfoIcon />} tone="muted">
          {part.data.memberId === null
            ? t("task.driverDropped", { by: memberName(part.data.byMemberId) })
            : part.data.memberId === part.data.byMemberId
              ? t("task.tookOver", { name: memberName(part.data.memberId) })
              : t("task.driverChanged", { name: memberName(part.data.memberId), by: memberName(part.data.byMemberId) })}
        </Line>
      );
    case "data-effort":
      return <Divider divider={{ kind: "effort", change: part.data }} now={part.data.at} />;
    case "data-system": {
      const event = part.data.event;
      let text: string;
      switch (event.kind) {
        case "runner.connected":
          text = t("task.system.runnerConnected");
          break;
        case "runner.lost":
          text = t("task.system.runnerLost");
          break;
        case "session.restored": {
          // Protocol minor 1 says how it came back (ADR 0039); a minor-0 event keeps milestone 1's line.
          if (event.origin === undefined) {
            text = t("task.system.restored");
            break;
          }
          const title = event.origin === "resumed" ? t("task.system.resumed") : event.origin === "restored" ? t("task.system.restoredArchive") : t("task.system.rebuilt");
          const glyph = event.origin === "resumed" ? <SquarePlayIcon /> : event.origin === "restored" ? <HistoryIcon /> : <LayersIcon />;
          const detail = restoredDetail(event);
          return (
            <div data-part="restored" data-origin={event.origin}>
              <Line icon={glyph} tone="muted">
                <span className="text-text">{title}</span>
                {detail === "" ? null : <span className="font-mono text-sm text-faint">{detail}</span>}
              </Line>
            </div>
          );
        }
        case "session.crashed":
          text = event.cause === "box_lost" ? t("task.system.boxLost") : t("task.system.crashed", { error: event.error });
          break;
        case "session.config_changed":
          text = t("task.system.config", { key: event.key, value: event.value });
          break;
        case "turn.cancel_requested":
          text = t("task.system.stopRequested", { name: memberName(event.memberId) });
          break;
        default:
          return event satisfies never;
      }
      return (
        <Line icon={event.kind === "session.crashed" || event.kind === "runner.lost" ? <TriangleAlertIcon /> : <InfoIcon />} tone={event.kind === "session.crashed" ? "red" : "muted"}>
          {text}
        </Line>
      );
    }
    case "data-unsupported":
      return (
        <div data-part="unsupported">
          <Line icon={<InfoIcon />} tone="muted">
            {t("task.unsupported")} <Mono>{part.data.rawKind}</Mono>
          </Line>
        </div>
      );
    case "data-problem":
      return (
        <Line icon={<TriangleAlertIcon />} tone="red">
          {part.data.text}
        </Line>
      );
    case "data-message-files":
      // Milestone 9 (ticket 14): a member's message's files are drawn under the message (ticket 16), never as a row.
      return null;
    case "data-review":
    case "data-draft":
      // Milestone 10 (F-151): a review's and a draft's results in their turn; their lines are ticket 14's. They drew nothing before.
      return null;
    default:
      return part satisfies never;
  }
};

/** F-037: "Held: test1's budget for November is reached", the month the gate held the turn in (UTC). */
const HeldRow = ({ at, scope }: { readonly at: number; readonly scope: "organization" | "project" }) => {
  const { projectName } = useTaskContext();
  const month = monthWord(at);
  return (
    <div data-part="held" data-scope={scope}>
      <Line icon={<PauseIcon />} tone="muted">
        {scope === "project" && projectName !== undefined ? t("task.heldProject", { project: projectName, month }) : t("task.heldOrganization", { month })}
      </Line>
    </div>
  );
};

export const DataRow = ({ id }: { readonly id: string }) => {
  const part = useDataPart(id);
  return part === undefined ? null : <DataBody part={part} />;
};
