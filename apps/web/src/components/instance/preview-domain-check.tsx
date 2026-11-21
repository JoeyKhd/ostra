import { CircleCheckIcon, CircleDashedIcon, CircleXIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { fillNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The preview domain's check on Instance › Previews (milestone 8, ticket 26, F-144;
// `instance-preview-domain.md`, "Check"): four rows, the DNS record, the certificate, ostra's proxy
// answering and a WebSocket upgrade, each passed, failed, not run because a row before it didn't
// pass, not needed (under `localhost`), not checked yet, or running. Core's check (ticket 25) gives
// each result as a code and its values, worded here (F-083), with the names and addresses set in mono.

export type InstancePreviews = RouterOutputs["instance"]["previews"];
type Checked = Extract<InstancePreviews["status"], { readonly state: "checked" }>["check"];
type CheckRow = Checked["dns"];

export const checkRowIds = ["dns", "certificate", "proxy", "upgrade"] as const;
export type CheckRowId = (typeof checkRowIds)[number];

/** One row as the page draws it: the check's result, not checked yet, or running. */
export type CheckRowView = CheckRow | { readonly state: "unchecked" } | { readonly state: "running" };

type Pass = Extract<CheckRow, { readonly state: "passed" }>["detail"];
type Failure = Extract<CheckRow, { readonly state: "failed" }>["reason"];

/** A result as a message and its values. */
type ResultText = { readonly key: MessageKey; readonly params: Readonly<Record<string, string>> };

/** The values that are names or addresses, set in mono on the page. */
const MONO_VALUES: ReadonlySet<string> = new Set(["name", "coreHost", "addresses", "cover", "names", "domain"]);

const list = (values: readonly string[]): string => values.join(", ");

const passText = (detail: Pass): ResultText => {
  switch (detail.code) {
    case "dns-resolves":
      return { key: "instance.previews.check.words.dnsResolves", params: { name: detail.name, coreHost: detail.coreHost, addresses: list(detail.addresses) } };
    case "certificate-valid":
      return detail.validTo === null
        ? { key: "instance.previews.check.words.certificateValidNoEnd", params: { cover: `*.${detail.domain}` } }
        : { key: "instance.previews.check.words.certificateValid", params: { cover: `*.${detail.domain}`, validTo: detail.validTo } };
    case "proxy-answered":
      return { key: "instance.previews.check.words.proxyAnswered", params: {} };
    case "upgrade-through":
      return { key: "instance.previews.check.words.upgradeThrough", params: {} };
    default:
      return detail satisfies never;
  }
};

const failureText = (reason: Failure): ResultText => {
  switch (reason.code) {
    case "dns-no-record":
      return { key: "instance.previews.check.words.dnsNoRecord", params: { name: reason.name } };
    case "dns-elsewhere":
      return { key: "instance.previews.check.words.dnsElsewhere", params: { name: reason.name, addresses: list(reason.addresses), coreHost: reason.coreHost } };
    case "core-http":
      return { key: "instance.previews.check.words.coreHttp", params: { setting: "OSTRA_CORE_PUBLIC_URL" } };
    case "no-https-answer":
      return { key: "instance.previews.check.words.noHttpsAnswer", params: { name: reason.name, error: reason.error } };
    case "no-certificate":
      return { key: "instance.previews.check.words.noCertificate", params: { name: reason.name } };
    case "certificate-names":
      return reason.names.length === 0
        ? { key: "instance.previews.check.words.certificateNoNames", params: { cover: `*.${reason.domain}` } }
        : { key: "instance.previews.check.words.certificateNames", params: { names: list(reason.names), cover: `*.${reason.domain}` } };
    case "certificate-expired":
      return reason.validTo === null ? { key: "instance.previews.check.words.certificateExpiredNoDate", params: {} } : { key: "instance.previews.check.words.certificateExpired", params: { validTo: reason.validTo } };
    case "certificate-untrusted":
      return { key: "instance.previews.check.words.certificateUntrusted", params: {} };
    case "no-answer":
      return { key: "instance.previews.check.words.noAnswer", params: { name: reason.name, error: reason.error } };
    case "something-else":
      return { key: "instance.previews.check.words.somethingElse", params: {} };
    case "upgrade-failed":
      return { key: "instance.previews.check.words.upgradeFailed", params: { error: reason.error } };
    case "upgrade-refused":
      return { key: "instance.previews.check.words.upgradeRefused", params: { status: String(reason.status) } };
    default:
      return reason satisfies never;
  }
};

/** A finished row's result as a message and its values. Only the DNS record and the certificate are ever not needed. */
const resultText = (id: CheckRowId, row: CheckRow): ResultText => {
  switch (row.state) {
    case "passed":
      return passText(row.detail);
    case "failed":
      return failureText(row.reason);
    case "skipped":
      return { key: `instance.previews.check.needs.${row.needs}`, params: {} };
    case "not-needed":
      return { key: id === "dns" ? "instance.previews.check.notNeeded.dns" : "instance.previews.check.notNeeded.certificate", params: { domain: row.domain } };
    default:
      return row satisfies never;
  }
};

/** A finished row's result in words, as text: `ostra-check-….preview.acme.dev doesn't resolve.` */
export const resultWords = (id: CheckRowId, row: CheckRow): string => {
  const text = resultText(id, row);
  return t(text.key, text.params);
};

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
  if (row.state === "unchecked" || row.state === "running") return null;
  return t(`instance.previews.check.result.${row.state}`, { name: t(rowName[id]), detail: resultWords(id, row) });
};

/** A finished row's result in words, with each name and address in mono. */
const ResultWords = ({ id, row }: { readonly id: CheckRowId; readonly row: CheckRow }): ReactNode => {
  const text = resultText(id, row);
  const nodes = Object.fromEntries(
    Object.entries(text.params).map(([name, value]) => [name, MONO_VALUES.has(name) ? <span className="font-mono text-[12.5px] text-text-2">{value}</span> : value]),
  );
  return fillNodes(t(text.key), nodes);
};

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

const Result = ({ id, row }: { readonly id: CheckRowId; readonly row: CheckRowView }): ReactNode => {
  switch (row.state) {
    case "passed":
    case "not-needed":
    case "failed":
    case "skipped":
      return <ResultWords id={id} row={row} />;
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
            <Result id={id} row={row} />
          </span>
        </div>
      );
    })}
  </div>
);
