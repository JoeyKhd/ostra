"use client";

import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { PrCommentData, TaskDataPart, TaskUIMessage } from "@ostra/task-view";

import type { RememberResult } from "@/components/tasks/task-changes/diff-view";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { t } from "@/lib/messages";

import { safeHref } from "../renderers";
import { useTaskContext } from "../task-context";

// Owner: ticket 12 (milestone 10, F-151: a PR comment, parts.md part 2; F-053, F-111). An accepted
// `@ostra` comment, or a reviewer's "changes requested", came from GitHub: its message is the
// outlined bubble named `{login} on GitHub`, and the `pr.comment_received` core writes with it (in
// the same transaction, so the nearest one) gives the login and the comment's address. Under the
// quoted comment, teal `Open on GitHub` and `Remember this`: the member writes the proposal in their
// own words, since the comment's text is untrusted and stays in the message (milestone 4's form,
// under the bubble). Moved here from milestone 4's thread row in `renderers.tsx`.

/** How many events from its message core may have written a comment's `pr.comment_received`. */
const NEAR = 8;

/** The `pr.comment_received` nearest the message at `seq`, after it first, or `null` when none is in view. */
const nearestPrComment = (data: ReadonlyMap<string, TaskDataPart>, seq: number): PrCommentData | null => {
  for (let gap = 1; gap <= NEAR; gap += 1) {
    for (const at of [seq + gap, seq - gap]) {
      const part = data.get(`pr-comment:${String(at)}`);
      if (part?.type === "data-pr-comment") return part.data;
    }
  }
  return null;
};

/** The comment a PR comment's or a review's message came with: its login, address, file and line. */
export const usePrCommentOf = (message: TaskUIMessage): PrCommentData | null => {
  const { store } = useTaskContext();
  const seq = message.metadata?.firstSeq ?? null;
  const read = () => (seq === null ? null : nearestPrComment(store.get().data, seq));
  return useSyncExternalStore(store.subscribe, read, read);
};

/** A teal link out of a bubble, 13.5px: a new tab, safe addresses only. */
const OutLink = ({ href, children }: { readonly href: string; readonly children: ReactNode }) => {
  const safe = safeHref(href);
  return safe === null ? null : (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-teal hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal">
      {children}
    </a>
  );
};

/** `Open on GitHub` and `Remember this` under the quoted comment, 10px apart. */
export const PrCommentLinks = ({ comment, onRemember, remembered }: { readonly comment: PrCommentData; readonly onRemember: (() => void) | null; readonly remembered: boolean }) => (
  <div className="mt-[5px] flex flex-wrap items-center gap-x-2.5 text-[13.5px]" data-part="pr-comment-links">
    <OutLink href={comment.url}>{t("task.bubble.openOnGitHub")}</OutLink>
    {remembered ? (
      <span className="text-muted" data-testid="remembered">{t("changes.remembered")}</span>
    ) : onRemember === null ? null : (
      <button type="button" data-action="remember-this" className="text-teal hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal" onClick={onRemember}>
        {t("changes.rememberThis")}
      </button>
    )}
  </div>
);

/** "Remember this" (F-111): open, milestone 4's form under the bubble; proposed, its words in the links. */
export const useRememberThis = (comment: PrCommentData | null) => {
  const { rememberPrComment } = useTaskContext();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RememberResult | "pending" | null>(null);
  const proposed = state !== null && state !== "pending" && state.kind === "proposed";
  return {
    open: open && rememberPrComment !== undefined && comment !== null,
    remembered: proposed,
    onRemember: rememberPrComment === undefined || comment === null || open ? null : () => { setOpen(true); },
    form:
      open && rememberPrComment !== undefined && comment !== null ? (
        <RememberForm
          seq={comment.seq}
          state={state}
          onSubmit={(draft) => {
            setState("pending");
            void rememberPrComment(comment.seq, draft).then((result) => {
              setState(result);
              if (result.kind === "proposed") setOpen(false);
            });
          }}
          onCancel={() => { setOpen(false); setState(null); }}
        />
      ) : null,
  };
};

const RememberForm = ({ seq, state, onSubmit, onCancel }: {
  readonly seq: number;
  readonly state: RememberResult | "pending" | null;
  readonly onSubmit: (draft: { readonly title: string; readonly body: string }) => void;
  readonly onCancel: () => void;
}) => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const refused = state !== null && state !== "pending" && state.kind === "refused" ? state.message : null;
  const fieldId = `pr-comment-${String(seq)}`;
  return (
    <form
      className="mt-2 w-full max-w-[560px] self-end rounded-lg border border-line-2 bg-surface p-3"
      data-testid="pr-comment-remember"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ title: title.trim(), body: body.trim() });
      }}
    >
      <Field id={`${fieldId}-title`} label={t("task.prCommentTitle")}>
        <Input id={`${fieldId}-title`} value={title} maxLength={120} onChange={(event) => { setTitle(event.target.value); }} />
      </Field>
      <Field id={`${fieldId}-body`} label={t("task.prCommentBody")} help={t("task.prCommentHelp")} error={refused}>
        <Textarea id={`${fieldId}-body`} value={body} rows={3} maxLength={4096} onChange={(event) => { setBody(event.target.value); }} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={state === "pending" || title.trim() === "" || body.trim() === ""}>
          {state === "pending" ? t("task.prCommentProposing") : t("task.prCommentPropose")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
};
