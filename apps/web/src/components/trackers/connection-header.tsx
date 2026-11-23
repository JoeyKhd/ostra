"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import type { ConnectionId } from "@ostra/protocol";

import { pageKeyLine } from "@/components/shell/page-frame";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { kindWord } from "./tracker-words";
import type { TrackerItem } from "./tracker-words";
import { TrackerMark, trackerMarkAt } from "./tracker-mark";

// A connection's header (connection-settings.md): the mark at 36px, the kind and its site in mono
// `--faint`, the name at the page's title size with the pencil that renames it in place, and the
// lede. Admins rename it: `Enter` saves, `Esc` cancels, a blank name is refused, and a name another
// connection holds is said (`name-taken`). A member reads the same header without the pencil.

/** A Jira site's or a Linear workspace's line under the mark: `Jira Cloud · globex.atlassian.net`. */
export const connectionEyebrow = (kind: TrackerItem["kind"], site: string | null): string =>
  site === null ? kindWord(kind) : t(kind === "linear" ? "trackers.header.workspace" : "trackers.header.site", { kind: kindWord(kind), site });

export type ConnectionHeaderProps = {
  readonly connectionId: ConnectionId;
  readonly kind: TrackerItem["kind"];
  readonly name: string;
  readonly site: string | null;
  readonly lede: ReactNode;
  readonly admin: boolean;
};

const inputClass = "page-title h-9 min-w-0 flex-1 rounded-md border border-control-line bg-surface px-2.5 text-text outline-2 outline-offset-1 outline-teal max-sm:h-11";

/** The name, renamed in place by an admin (the pencil; `Enter` saves, `Esc` cancels). */
export const ConnectionHeader = ({ connectionId, kind, name, site, lede, admin }: ConnectionHeaderProps) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [refusal, setRefusal] = useState<string | null>(null);
  const rename = useMutation(
    trpc.trackers.rename.mutationOptions({
      onSuccess: (result) => {
        setDraft(result.name);
        setEditing(false);
        setRefusal(null);
        void queryClient.invalidateQueries({ queryKey: trpc.trackers.pathKey() });
      },
    }),
  );

  const start = () => {
    setDraft(name);
    setRefusal(null);
    rename.reset();
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setRefusal(null);
    rename.reset();
  };
  const save = (event: SubmitEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === "") {
      setRefusal(t("trackers.rename.blank"));
      return;
    }
    if (next === name) {
      cancel();
      return;
    }
    rename.mutate(
      { id: connectionId, name: next },
      {
        onError: (error) => {
          setRefusal(error.data?.code === "CONFLICT" ? t("trackers.rename.nameTaken", { name: next }) : (errorText(error) ?? t("errors.server")));
        },
      },
    );
  };

  return (
    <div className="mb-2 flex items-start gap-3" data-testid="connection-header">
      <TrackerMark kind={kind} size={trackerMarkAt.connectionHeader.size} label={false} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className={pageKeyLine}>{connectionEyebrow(kind, site)}</div>
        <div className="flex min-w-0 items-center gap-2.5">
          {editing ? (
            <form onSubmit={save} noValidate className="flex min-w-0 flex-1 items-center gap-1.5" aria-label={t("trackers.rename.label")}>
              <input
                aria-label={t("trackers.rename.label")}
                data-testid="connection-name-input"
                className={inputClass}
                value={draft}
                maxLength={60}
                disabled={rename.isPending}
                autoFocus
                onChange={(event) => {
                  setDraft(event.target.value);
                  setRefusal(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancel();
                  }
                }}
              />
              <button type="submit" aria-label={t("trackers.rename.save")} disabled={rename.isPending} className="grid size-7 shrink-0 place-items-center rounded-sm text-teal hover:bg-hover disabled:opacity-50">
                <CheckIcon aria-hidden className="size-4 stroke-2" />
              </button>
              <button type="button" aria-label={t("trackers.rename.cancel")} onClick={cancel} className="grid size-7 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-text">
                <XIcon aria-hidden className="size-4 stroke-[1.75]" />
              </button>
            </form>
          ) : (
            <>
              <h1 className="page-title min-w-0 break-words">{name}</h1>
              {admin ? (
                <button type="button" aria-label={t("trackers.rename.action", { name })} data-testid="connection-rename" onClick={start} className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-text">
                  <PencilIcon aria-hidden className="size-[15px] stroke-[1.75]" />
                </button>
              ) : null}
            </>
          )}
        </div>
        {refusal === null ? null : (
          <p role="alert" data-testid="connection-rename-error" className="mt-1 text-sm text-red">
            {refusal}
          </p>
        )}
        <p className="mt-1.5 max-w-[720px] text-lede text-muted">{lede}</p>
      </div>
    </div>
  );
};
