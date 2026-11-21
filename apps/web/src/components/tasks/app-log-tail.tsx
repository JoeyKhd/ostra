"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "@/lib/messages";

// F-140 (milestone 8's ticket 17): "Show log" on an app process that exited or failed: the last
// lines of its log, a blob of the task the runner uploaded, read through the panel's route
// (`/api/tasks/<taskId>/app-logs/<blobId>`, plain text, never a page). The log is the app's own
// output: shown as text, never markup, and never logged.

/** Where a log's tail downloads: the web app's route, which checks the member may open the task. */
export const appLogPath = (taskId: string, blobId: string): string => `/api/tasks/${taskId}/app-logs/${encodeURIComponent(blobId)}`;

/** The most lines shown: the tail is at most 64 KiB, and its end says why it stopped. */
const SHOWN_LINES = 40;

const LogText = ({ taskId, blobId }: { readonly taskId: string; readonly blobId: string }) => {
  const log = useQuery({
    queryKey: ["app-log", taskId, blobId],
    queryFn: async ({ signal }): Promise<string> => {
      const response = await fetch(appLogPath(taskId, blobId), { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (log.isPending) return <p className="text-sm text-faint">{t("environment.app.log.loading")}</p>;
  if (log.isError) return <p role="alert" className="text-sm text-red">{t("environment.app.log.unreadable")}</p>;
  const lines = log.data.replace(/\n$/, "").split("\n");
  return (
    <pre data-testid="app-log-tail" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm leading-[1.6] text-muted">
      {lines.slice(-SHOWN_LINES).join("\n") || t("environment.app.log.empty")}
    </pre>
  );
};

/** The teal "Show log" toggle and, open, the log's last lines. */
export const AppLogTail = ({ taskId, blobId, label, className }: { readonly taskId: string; readonly blobId: string; readonly label?: string; readonly className?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button type="button" className="text-sm text-teal hover:underline" aria-expanded={open} data-action="show-log" onClick={() => { setOpen((now) => !now); }}>
        {open ? t("environment.app.log.hide") : (label ?? t("environment.app.log.show"))}
      </button>
      {open ? <div className="mt-1.5"><LogText taskId={taskId} blobId={blobId} /></div> : null}
    </div>
  );
};
