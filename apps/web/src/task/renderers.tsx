"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  BrainIcon,
  CheckIcon,
  CircleDotIcon,
  CircleIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HandIcon,
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

import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/messages";

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
  <details data-part="reasoning" data-streaming={streaming ? "true" : "false"} open={streaming} className="group my-1 text-muted">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
      <BrainIcon className="size-[13px]" /> {streaming ? t("task.thinking") : t("task.thought")}
    </summary>
    <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 text-sm">{text}</p>
  </details>
);

/** One activity line: icon, verb, subject, and what's on its right. */
const Line = ({ icon, children, end, tone }: { readonly icon: ReactNode; readonly children: ReactNode; readonly end?: ReactNode; readonly tone?: "red" | "muted" | undefined }) => (
  <div className={cn("flex min-h-7 min-w-0 items-center gap-2.5 text-body", tone === "red" && "text-red", tone === "muted" && "text-muted")}>
    <span className="shrink-0 text-faint [&_svg]:size-[14px]">{icon}</span>
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">{children}</span>
    {end === undefined ? null : <span className="ml-auto shrink-0 text-sm">{end}</span>}
  </div>
);

const Mono = ({ children }: { readonly children: ReactNode }) => <span className="min-w-0 break-all font-mono text-[12.5px] text-text">{children}</span>;

const running = (part: ToolLikePart): boolean =>
  part.state === "input-available" || part.state === "input-streaming" || (part.state === "output-available" && part.preliminary === true);

const ToolStatus = ({ part }: { readonly part: ToolLikePart }) => {
  if (part.state === "output-error") return <span className="text-red">{part.errorText === "cancelled" ? t("task.tool.cancelled") : t("task.tool.failed")}</span>;
  if (part.state === "output-denied") return <span className="text-red">{t("task.tool.denied")}</span>;
  if (part.state === "approval-requested") return <span className="text-amber">{t("task.tool.needsApproval")}</span>;
  if (running(part)) return <span className="text-faint">{t("task.tool.running")}</span>;
  return null;
};

/** A unified diff, as text: additions green, deletions red, never HTML. */
const Diff = ({ patch }: { readonly patch: string }) => (
  <pre className="my-1 max-h-96 overflow-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12px] leading-[1.6]">
    {patch.split("\n").map((line, i) => (
      <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "text-green" : line.startsWith("-") && !line.startsWith("---") ? "text-red" : "text-muted"}>
        {line === "" ? " " : line}
      </div>
    ))}
  </pre>
);

const Output = ({ text, truncated }: { readonly text: string; readonly truncated: boolean }) => (
  <pre data-part="command-output" className="my-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12px] leading-[1.6] text-muted">
    {text === "" ? t("task.tool.noOutput") : text}
    {truncated ? `\n${t("task.tool.truncated")}` : ""}
  </pre>
);

/** The approval, read-only in milestone 1: answering comes with F-026 in milestone 3. */
const ApprovalNote = ({ part }: { readonly part: ToolLikePart }) => {
  const { memberName } = useTaskContext();
  const metadata = approvalMetadataSchema.safeParse(part.toolMetadata);
  if (!metadata.success) return null;
  const receipt = metadata.data.approval.descriptor.receipt;
  if (receipt === undefined) {
    return (
      <div data-part="approval" data-state="pending" className="my-2 border-l-2 border-amber pl-3">
        <div className="flex items-center gap-2 font-medium text-amber"><HandIcon className="size-[14px]" /> {t("task.approval.title")}</div>
        <p className="text-sm text-muted">{t("task.approval.readOnly")}</p>
      </div>
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
  return <div data-part="approval" data-state={receipt.state} className="ml-6 text-sm text-muted">{text}</div>;
};

const ToolBody = ({ part }: { readonly part: ToolLikePart }) => {
  const [open, setOpen] = useState(false);
  switch (part.type) {
    case "tool-read":
      return (
        <Line icon={<FileTextIcon />} end={<ToolStatus part={part} />} tone={part.state === "output-error" ? "red" : undefined}>
          <span className="text-muted">{t("task.tool.read")}</span>
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
              end={<ToolStatus part={part} />}
            >
              <span className="text-muted">{done ? t("task.tool.edited") : t("task.tool.editing")}</span>
              <Mono>{file.path}</Mono>
              {file.added === null ? null : <span className="font-mono text-sm text-green">+{file.added}</span>}
              {file.removed === null || file.removed === 0 ? null : <span className="font-mono text-sm text-red">−{file.removed}</span>}
            </Line>
          ))}
          {patch === "" ? null : (
            <>
              <button type="button" className="ml-6 text-sm text-teal hover:underline" aria-expanded={open} onClick={() => { setOpen((v) => !v); }}>
                {open ? t("task.tool.hideDiff") : t("task.tool.showDiff")}
              </button>
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
            tone={part.state === "output-error" ? "red" : undefined}
            end={
              exit === undefined ? <ToolStatus part={part} /> : exit === 0 ? (
                <span className="inline-flex items-center gap-1 text-green"><CheckIcon className="size-3" /> {t("task.tool.exit", { code: 0 })}</span>
              ) : (
                <span className="text-red">{exit === null ? t("task.tool.killed") : t("task.tool.exit", { code: exit })}</span>
              )
            }
          >
            <span className="text-muted">{running(part) ? t("task.tool.running") : t("task.tool.ran")}</span>
            <Mono>{part.input?.command ?? ""}</Mono>
          </Line>
          {output === null ? null : (
            <>
              <button type="button" className="ml-6 text-sm text-teal hover:underline" aria-expanded={open} onClick={() => { setOpen((v) => !v); }}>
                {open ? t("task.tool.hideOutput") : t("task.tool.showOutput")}
              </button>
              {open ? <Output text={output.output} truncated={output.truncated} /> : null}
            </>
          )}
          {part.state === "output-error" ? <p className="ml-6 text-sm text-red">{part.errorText}</p> : null}
        </div>
      );
    }
    case "dynamic-tool":
      return (
        <Line icon={part.toolName === "execute" ? <SquareTerminalIcon /> : <WrenchIcon />} end={<ToolStatus part={part} />} tone={part.state === "output-error" ? "red" : undefined}>
          <span className="text-muted">{part.toolName}</span>
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
    <div data-part="tool" data-tool-kind={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} data-state={part.state} className="my-0.5">
      <ToolBody part={part} />
      <ApprovalNote part={part} />
    </div>
  );
};

const PlanStatus = ({ status }: { readonly status: "pending" | "in_progress" | "completed" }) =>
  status === "completed" ? <CheckIcon className="size-3 text-green" /> : status === "in_progress" ? <CircleDotIcon className="size-3 text-teal" /> : <CircleIcon className="size-3 text-faint" />;

const DataBody = ({ part }: { readonly part: TaskDataPart }) => {
  const { memberName } = useTaskContext();
  const [open, setOpen] = useState(false);
  switch (part.type) {
    case "data-plan":
      return (
        <div data-part="plan" className="my-1.5">
          <div className="mb-1 text-sm font-medium text-muted">{t("task.plan")}</div>
          <ul className="space-y-0.5">
            {part.data.entries.map((entry, i) => (
              <li key={i} className={cn("flex items-center gap-2 text-body", entry.status === "completed" && "text-muted line-through")}>
                <PlanStatus status={entry.status} /> {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "data-question": {
      const status = part.data.status;
      return (
        <div data-part="question" className="my-2 border-l-2 border-amber pl-3">
          <div className="flex items-center gap-2 font-medium text-amber"><HandIcon className="size-[14px]" /> {t("task.question.title")}</div>
          <p className="whitespace-pre-wrap">{part.data.message}</p>
          <p className="text-sm text-muted">
            {status.state === "open"
              ? t("task.question.readOnly")
              : status.state === "answered"
                ? t("task.question.answered", { name: memberName(status.answeredBy) })
                : t("task.question.closed", { reason: status.closedReason })}
          </p>
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
              setup.state === "running" ? <span className="text-faint">{t("task.tool.running")}</span> : (
                <span className={setup.state === "succeeded" ? "text-green" : "text-red"}>
                  {setup.state === "succeeded" ? t("task.setup.ok") : setup.exitCode === null || setup.exitCode === undefined ? t("task.tool.killed") : t("task.tool.exit", { code: setup.exitCode })}
                  {setup.durationMs === undefined ? "" : ` · ${formatDuration(setup.durationMs)}`}
                </span>
              )
            }
          >
            <span className="text-muted">{t("task.setup.title")}</span>
          </Line>
          {text === "" ? null : (
            <>
              <button type="button" className="ml-6 text-sm text-teal hover:underline" aria-expanded={open || setup.state === "failed"} onClick={() => { setOpen((v) => !v); }}>
                {open ? t("task.setup.hide") : t("task.setup.show")}
              </button>
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
          <button type="button" className="ml-6 text-sm text-teal hover:underline" aria-expanded={open} onClick={() => { setOpen((v) => !v); }}>
            {open ? t("task.prBodyHide") : t("task.prBodyShow")}
          </button>
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
    case "data-driver":
      return (
        <Line icon={<InfoIcon />} tone="muted">
          {t("task.driverChanged", { name: memberName(part.data.memberId), by: memberName(part.data.byMemberId) })}
        </Line>
      );
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
        case "session.restored":
          text = t("task.system.restored");
          break;
        case "session.crashed":
          text = t("task.system.crashed", { error: event.error });
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
