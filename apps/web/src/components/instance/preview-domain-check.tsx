import { CircleCheckIcon, CircleDashedIcon, CircleXIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The preview domain's check on Instance › Previews (milestone 8, ticket 26, F-144;
// `instance-preview-domain.md`, "Check"): four rows, the DNS record, the certificate, ostra's proxy
// answering and a WebSocket upgrade, each passed, failed, not run because a row before it didn't
// pass, not needed (under `localhost`), not checked yet, or running. The results' words are core's
// check's (ticket 25), with the names and addresses in them set in mono.

export type InstancePreviews = RouterOutputs["instance"]["previews"];
type Checked = Extract<InstancePreviews["status"], { readonly state: "checked" }>["check"];
type CheckRow = Checked["dns"];

export const checkRowIds = ["dns", "certificate", "proxy", "upgrade"] as const;
export type CheckRowId = (typeof checkRowIds)[number];

/** One row as the page draws it. */
export type CheckRowView =
  | { readonly state: "passed"; readonly detail: string }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "skipped"; readonly needs: string }
  | { readonly state: "not-needed"; readonly detail: string }
  | { readonly state: "unchecked" }
  | { readonly state: "running" };

const rowName: Record<CheckRowId, MessageKey> = {
  dns: "instance.previews.check.dns",
  certificate: "instance.previews.check.certificate",
  proxy: "instance.previews.check.proxy",
  upgrade: "instance.previews.check.upgrade",
};

/** The four rows: the last check's, every one running while a check runs, or not checked yet. */
export const checkRowsOf = (status: InstancePreviews["status"], running: boolean): readonly { readonly id: CheckRowId; readonly row: CheckRowView }[] =>
  checkRowIds.map((id) => {
    if (running) return { id, row: { state: "running" } };
    if (status.state !== "checked") return { id, row: { state: "unchecked" } };
    const row: CheckRow = status.check[id];
    return { id, row };
  });

/** How many of the four rows passed (or weren't needed): the properties panel's `1 of 4 passed`. */
export const passedCount = (check: Checked): number => checkRowIds.filter((id) => check[id].state === "passed" || check[id].state === "not-needed").length;

/** What a screen reader hears for a finished row: `Certificate: failed. The certificate covers …`. */
export const rowAnnouncement = (id: CheckRowId, row: CheckRowView): string | null => {
  const name = t(rowName[id]);
  switch (row.state) {
    case "passed":
      return t("instance.previews.check.result.passed", { name, detail: row.detail });
    case "failed":
      return t("instance.previews.check.result.failed", { name, detail: row.reason });
    case "skipped":
      return t("instance.previews.check.result.skipped", { name, detail: row.needs });
    case "not-needed":
      return t("instance.previews.check.result.not-needed", { name, detail: row.detail });
    case "unchecked":
    case "running":
      return null;
    default:
      return row satisfies never;
  }
};

/** A name or an address in a result (`q7m2x9.preview.acme.dev`, `203.0.113.24`, `*.preview.acme.dev`), set in mono. */
const NAME = /^\*?[\w-]+(?:\.[\w*-]+)+(?::\d+)?$/;

/** A result's words, with each host, name and address in mono. */
export const ResultWords = ({ text }: { readonly text: string }): ReactNode =>
  text.split(/(\s+)/).map((part, index) => {
    const bare = part.replace(/[.,]$/, "");
    if (!NAME.test(bare) || !/[a-z0-9]\.[a-z0-9*]/i.test(bare)) return part;
    return (
      <span key={index}>
        <span className="font-mono text-[12.5px] text-text-2">{bare}</span>
        {part.slice(bare.length)}
      </span>
    );
  });

const Icon = ({ row }: { readonly row: CheckRowView }) => {
  switch (row.state) {
    case "passed":
    case "not-needed":
      return <CircleCheckIcon aria-hidden className="size-[15px] stroke-[1.75] text-green" />;
    case "failed":
      return <CircleXIcon aria-hidden className="size-[15px] stroke-[1.75] text-red" />;
    case "skipped":
    case "unchecked":
      return <CircleDashedIcon aria-hidden className="size-[15px] stroke-[1.75] text-faint" />;
    case "running":
      return <span aria-hidden className="inline-block size-[13px] animate-spin rounded-full border-[1.5px] border-line-2 border-t-muted motion-reduce:animate-none" />;
    default:
      return row satisfies never;
  }
};

const Result = ({ row }: { readonly row: CheckRowView }): ReactNode => {
  switch (row.state) {
    case "passed":
    case "not-needed":
      return <ResultWords text={row.detail} />;
    case "failed":
      return <ResultWords text={row.reason} />;
    case "skipped":
      return row.needs;
    case "unchecked":
      return t("instance.previews.check.notChecked");
    case "running":
      return t("instance.previews.check.checking");
    default:
      return row satisfies never;
  }
};

export const PreviewDomainCheckRows = ({ rows }: { readonly rows: readonly { readonly id: CheckRowId; readonly row: CheckRowView }[] }) => (
  <div role="list" className="border-t border-line" data-testid="preview-domain-check">
    {rows.map(({ id, row }) => {
      const quiet = row.state === "skipped" || row.state === "unchecked";
      return (
        <div
          key={id}
          role="listitem"
          data-row={id}
          data-state={row.state}
          aria-label={rowAnnouncement(id, row) ?? undefined}
          className={cn(
            "grid min-h-9 grid-cols-[26px_168px_minmax(0,1fr)] items-center border-b border-line text-ui max-md:grid-cols-[26px_minmax(0,1fr)] max-md:py-2",
            quiet && "text-faint",
          )}
        >
          <Icon row={row} />
          <span>{t(rowName[id])}</span>
          <span className={cn("min-w-0 truncate text-sm max-md:col-start-2 max-md:whitespace-normal", row.state === "failed" ? "text-text" : quiet ? "text-faint" : "text-muted")} title={rowAnnouncement(id, row) ?? undefined}>
            <Result row={row} />
          </span>
        </div>
      );
    })}
  </div>
);
