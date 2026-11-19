"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArchiveIcon,
  BrainIcon,
  HistoryIcon,
  LayersIcon,
  PaperclipIcon,
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
import { useState } from "react";
import type { ReactNode } from "react";

import { approvalMetadataSchema } from "@ostra/task-view";
import type { TaskDataPart } from "@ostra/task-view";

import { NeedsYou } from "@/components/ui/needs-you";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/messages";

import { EffortMarker } from "./effort-marks";
import { filesOutsideText } from "./files-outside-words";
import { restoredDetail, savedDetail } from "./marker-words";
import { useDataPart, useTaskContext, useToolPart } from "./task-context";
import type { ToolLikePart } from "./task-context";

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
    {verb === undefined ? null : <span className="w-[72px] shrink-0 text-muted">{verb}</span>}
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
  if (part.state === "approval-requested") return <span className="font-sans text-amber">{t("task.tool.needsApproval")}</span>;
  if (running(part)) return <span className="font-sans text-faint">{t("task.tool.running")}</span>;
  return null;
};

/** A unified diff, as text: additions green, deletions red, never HTML. */
const Diff = ({ patch }: { readonly patch: string }) => (
  <pre className="my-1 ml-[104px] max-h-80 overflow-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm leading-[1.6]">
    {patch.split("\n").map((line, i) => (
      <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "text-green" : line.startsWith("-") && !line.startsWith("---") ? "text-red" : "text-muted"}>
        {line === "" ? " " : line}
      </div>
    ))}
  </pre>
);

const Output = ({ text, truncated }: { readonly text: string; readonly truncated: boolean }) => (
  <pre data-part="command-output" className="my-1 ml-[104px] max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm leading-[1.6] text-muted">
    {text === "" ? t("task.tool.noOutput") : text}
    {truncated ? `\n${t("task.tool.truncated")}` : ""}
  </pre>
);

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
const ApprovalNote = ({ part }: { readonly part: ToolLikePart }) => {
  const { memberName, approvalSummary, approvalCard, approvalReceipt } = useTaskContext();
  const metadata = approvalMetadataSchema.safeParse(part.toolMetadata);
  if (!metadata.success) return null;
  const receipt = metadata.data.approval.descriptor.receipt;
  // Milestone 3 (ticket 43): the task page answers it, and words its receipt with the rule and the reason.
  const card = receipt === undefined ? approvalCard?.(metadata.data.approval.id) : undefined;
  if (card !== undefined && card !== null) return <>{card}</>;
  const worded = receipt === undefined ? null : (approvalReceipt?.(metadata.data.approval.id) ?? null);
  if (worded !== null) return <div data-part="approval" data-state={receipt?.state} className="ml-[104px] text-sm text-muted">{worded}</div>;
  if (receipt === undefined) {
    const summary = approvalSummary(metadata.data.approval.id);
    const subject = approvalSubject(part);
    return (
      <NeedsYou data-testid="approval" title={t("task.approval.title")} className="my-2.5" footer={t("task.approval.readOnly")}>
        <div data-part="approval" data-state="pending">
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
  return <div data-part="approval" data-state={receipt.state} className="ml-[104px] text-sm text-muted">{text}</div>;
};

const ToolBody = ({ part }: { readonly part: ToolLikePart }) => {
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
              {open ? <Diff patch={patch} /> : null}
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
              {open ? <Output text={output.output} truncated={output.truncated} /> : null}
            </>
          )}
          {part.state === "output-error" ? <p className="ml-[104px] text-sm text-red">{part.errorText}</p> : null}
        </div>
      );
    }
    case "dynamic-tool":
      return (
        <Line icon={part.toolName === "execute" ? <SquareTerminalIcon /> : <WrenchIcon />} verb={<span className="block truncate pr-2">{part.toolName}</span>} end={<ToolStatus part={part} />} tone={part.state === "output-error" ? "red" : undefined}>
          <span className="min-w-0 truncate">{part.title ?? ""}</span>
          {part.state === "output-error" ? <span className="text-sm text-red">{part.errorText}</span> : null}
        </Line>
      );
    default:
      return part satisfies never;
  }
};

export const ToolRow = ({ toolCallId }: { readonly toolCallId: string }) => {
  const part = useToolPart(toolCallId);
  if (part === undefined) return null;
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

const DataBody = ({ part }: { readonly part: TaskDataPart }) => {
  const { memberName, questionCard } = useTaskContext();
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
    case "data-question": {
      const status = part.data.status;
      const card = status.state === "open" ? questionCard?.(part.data.questionId) : undefined;
      if (card !== undefined && card !== null) return <div data-part="question">{card}</div>;
      return (
        <div data-part="question">
          {status.state === "open" ? (
            <NeedsYou data-testid="question" title={t("task.question.title")} className="my-2.5" footer={t("task.question.readOnly")}>
              <p className="whitespace-pre-wrap">{part.data.message}</p>
            </NeedsYou>
          ) : (
            <div className="my-1">
              <p className="whitespace-pre-wrap">{part.data.message}</p>
              <p className="text-sm text-muted">
                {status.state === "answered" ? t("task.question.answered", { name: memberName(status.answeredBy) }) : t("task.question.closed", { reason: status.closedReason })}
              </p>
            </div>
          )}
        </div>
      );
    }
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
              {open || setup.state === "failed" ? <Output text={text} truncated={false} /> : null}
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
          {open ? <Output text={part.data.body} truncated={false} /> : null}
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
    case "data-ticket-files":
      return (
        <div data-part="ticket-files">
          <Line icon={<PaperclipIcon />} tone="muted">
            {t("task.ticketFiles")}
            <span className="truncate font-mono text-sm text-faint">{part.data.paths.map((path) => `.ostra/ticket/${path}`).join(", ")}</span>
          </Line>
        </div>
      );
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
      return <EffortMarker data={part.data} name={memberName(part.data.memberId)} />;
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
    default:
      return part satisfies never;
  }
};

export const DataRow = ({ id }: { readonly id: string }) => {
  const part = useDataPart(id);
  return part === undefined ? null : <DataBody part={part} />;
};
