import { useAuiState } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { memo, useState, type ReactNode } from "react";
import { ToolCallId } from "../shared/ids.ts";
import { approvalMetadataSchema, type QuestionStatus, type SystemEvent } from "../shared/ui-types.ts";
import { useDataPart, useTaskContext, useToolPart, type ToolLikePart } from "./task-context.ts";

// Renderers are keyed by ACP `kind`, never by an agent's tool name, so every agent renders alike.
// Agent text, diffs and command output are untrusted: markdown with no raw HTML, safe links,
// command output as plain text, and nothing here loads a remote resource.

const safeHref = (href: string | undefined): string | null => {
  if (href === undefined) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export const SafeLink = ({ href, children }: { href?: string | undefined; children?: ReactNode }) => {
  const safe = safeHref(href);
  return safe === null ? (
    <span>{children}</span>
  ) : (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
};

const markdownComponents = {
  a: SafeLink,
  // a remote image would be a request to a third party: show it as text instead
  img: ({ alt }: { alt?: string | undefined }) => <span>[image{alt === undefined ? "" : `: ${alt}`}]</span>,
};

export const AssistantText = ({ streaming }: { streaming: boolean }) => (
  <div data-part="text" data-streaming={streaming ? "true" : "false"} className="text">
    <MarkdownTextPrimitive smooth={false} components={markdownComponents} />
  </div>
);

export const Reasoning = ({ text, streaming }: { text: string; streaming: boolean }) => (
  <details data-part="reasoning" data-streaming={streaming ? "true" : "false"} className="reasoning" open={streaming}>
    <summary>Thinking</summary>
    <p>{text}</p>
  </details>
);

const stateLabel = (part: ToolLikePart): string => {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return "running";
    case "approval-requested":
      return "needs approval";
    case "approval-responded":
      return "approved";
    case "output-available":
      return part.preliminary === true ? "running" : "done";
    case "output-error":
      return "failed";
    case "output-denied":
      return "denied";
    default:
      return part satisfies never;
  }
};

const ApprovalCard = ({ part }: { part: ToolLikePart }) => {
  const { actions } = useTaskContext();
  // Without an onRespondToToolApproval handler the runtime says the thread cannot answer tool calls,
  // and the card renders as a request without its controls.
  const answerable = useAuiState((s) => s.thread.capabilities.answerToolCall);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const metadata = approvalMetadataSchema.safeParse(part.toolMetadata);
  if (!metadata.success) return null;
  const approval = metadata.data.approval;
  const options = approval.descriptor.options;
  const receipt = approval.descriptor.receipt;
  if (receipt !== undefined) {
    let text: string;
    switch (receipt.state) {
      case "answered":
        text =
          receipt.decision === "allow_once"
            ? `Approved once by ${receipt.by}`
            : receipt.decision === "allow_task"
              ? `Approved for this task by ${receipt.by}`
              : `Denied by ${receipt.by}`;
        break;
      case "auto":
        text = `Approved automatically by rule ${receipt.ruleId}`;
        break;
      case "closed":
        text = receipt.reason === "expired" ? "Approval expired" : "Approval cancelled";
        break;
      default:
        return receipt satisfies never;
    }
    return (
      <div className="approval settled" data-part="approval" data-state={receipt.state} data-approval-id={approval.id}>
        {text}
      </div>
    );
  }
  const canAnswer = answerable && actions.canAnswerApprovals;
  return (
    <div className="approval pending" data-part="approval" data-state="pending" data-approval-id={approval.id}>
      <div>{canAnswer ? "This needs your decision." : "Waiting for approval"}</div>
      {canAnswer ? (
        <div className="actions">
          {options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              data-action={`approve-${option.optionId}`}
              disabled={busy !== null}
              onClick={() => {
                setBusy(option.optionId);
                setError(null);
                actions
                  .answer(approval.id, option.optionId)
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "failed");
                  })
                  .finally(() => {
                    setBusy(null);
                  });
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {error === null ? null : (
        <div className="error" data-part="approval-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

const ToolBody = ({ part }: { part: ToolLikePart }) => {
  switch (part.type) {
    case "tool-read": {
      const output = part.state === "output-available" ? part.output : undefined;
      return (
        <div className="line">
          <span className="verb">read</span> <code>{part.input?.path ?? ""}</code>
          {output?.lineCount === undefined ? null : <span className="muted"> {output.lineCount} lines</span>}
        </div>
      );
    }
    case "tool-edit": {
      const output = part.state === "output-available" ? part.output : undefined;
      const added = output?.files.reduce((n, f) => n + f.added, 0);
      const removed = output?.files.reduce((n, f) => n + f.removed, 0);
      return (
        <details className="edit">
          <summary>
            <span className="verb">edit</span> <code>{(part.input?.paths ?? []).join(", ")}</code>
            {added === undefined ? null : (
              <span className="diffstat">
                {" "}
                <span className="add">+{added}</span> <span className="del">-{removed ?? 0}</span>
              </span>
            )}
          </summary>
          {output?.files.map((file) => (
            <pre key={file.path} data-part="diff" className="diff">
              {file.patch ?? ""}
            </pre>
          ))}
        </details>
      );
    }
    case "tool-execute": {
      const output = part.state === "output-available" ? part.output : undefined;
      return (
        <div className="exec">
          <div className="line">
            <span className="verb">run</span> <code>{part.input?.command ?? ""}</code>
            {output === undefined ? null : (
              <span className="muted"> {output.exitCode === null ? "running" : `exit ${String(output.exitCode)}`}</span>
            )}
          </div>
          {output === undefined || output.output.length === 0 ? null : (
            <pre data-part="output" className="output" data-lines={lineCount(output.output)}>
              {output.output}
            </pre>
          )}
        </div>
      );
    }
    case "dynamic-tool":
      return (
        <div className="line">
          <span className="verb">{part.toolName}</span> <span>{part.title ?? ""}</span>
        </div>
      );
    default:
      return part satisfies never;
  }
};

// assistant-ui hands the id back as a plain string: it is branded here, at the boundary.
// Memoized, and subscribed to its own part: a row re-renders only when its part changed.
export const ToolRow = memo(({ toolCallId }: { toolCallId: string }) => {
  const id = ToolCallId.safeParse(toolCallId);
  const part = useToolPart(id.success ? id.data : undefined);
  if (part === undefined) {
    return (
      <div className="tool" data-part="tool-missing">
        tool call {toolCallId}
      </div>
    );
  }
  const kind = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
  const error = part.state === "output-error" ? part.errorText : null;
  return (
    <div className="tool" data-part="tool" data-kind={kind} data-state={part.state}>
      <ToolBody part={part} />
      <span className="state" data-part="tool-state">
        {stateLabel(part)}
      </span>
      {error === null ? null : (
        <div className="error" data-part="tool-error">
          {error}
        </div>
      )}
      <ApprovalCard part={part} />
    </div>
  );
});

const questionText = (status: QuestionStatus): string => {
  switch (status.state) {
    case "open":
      return "Waiting for an answer";
    case "answered":
      return `Answered by ${status.answeredBy}`;
    case "closed":
      return `Closed (${status.closedReason})`;
    default:
      return status satisfies never;
  }
};

const systemText = (event: SystemEvent): string => {
  switch (event.kind) {
    case "driver.changed":
      return `${event.memberId} took over`;
    case "runner.connected":
      return `Runner ${event.runnerId} connected`;
    case "runner.lost":
      return `Runner ${event.runnerId} lost`;
    case "session.restored":
      return "Session restored";
    case "session.crashed":
      return `Session crashed: ${event.error}`;
    case "pr.opened":
      return `Pull request #${String(event.number)} opened`;
    case "session.config_changed":
      return `${event.key} set to ${event.value}`;
    case "turn.cancel_requested":
      return `${event.memberId} asked to interrupt`;
    default:
      return event satisfies never;
  }
};

export const DataRow = memo(({ id }: { id: string }) => {
  const part = useDataPart(id);
  if (part === undefined) {
    return (
      <div className="system problem" data-part="data-missing">
        data part {id}
      </div>
    );
  }
  switch (part.type) {
    case "data-plan":
      return (
        <ol className="plan" data-part="plan">
          {part.data.entries.map((entry, i) => (
            <li key={i} data-status={entry.status}>
              <span className="muted">{entry.status.replace("_", " ")}</span> {entry.content}
            </li>
          ))}
        </ol>
      );
    case "data-question":
      return (
        <div className="question" data-part="question" data-state={part.data.status.state}>
          <div>{part.data.message}</div>
          <ul>
            {part.data.fields.map((field) => (
              <li key={field.id}>
                {field.label}
                {field.options === undefined ? "" : `: ${field.options.join(" / ")}`}
              </li>
            ))}
          </ul>
          <div className="muted">{questionText(part.data.status)}</div>
        </div>
      );
    case "data-compaction":
      return (
        <div className="divider" data-part="compaction" data-state={part.data.status}>
          {part.data.status === "running" ? "Compacting context" : `Context compacted. ${part.data.summary ?? ""}`}
        </div>
      );
    case "data-system":
      return (
        <div className="system" data-part="system" data-event-kind={part.data.event.kind}>
          {systemText(part.data.event)}
        </div>
      );
    case "data-unsupported":
      return (
        <div className="system unsupported" data-part="unsupported" data-event-kind={part.data.rawKind}>
          Unsupported event: {part.data.rawKind}
        </div>
      );
    case "data-problem":
      return (
        <div className="system problem" data-part="problem">
          {part.data.text}
        </div>
      );
    default:
      return part satisfies never;
  }
});
