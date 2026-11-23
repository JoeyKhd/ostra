"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, InfoIcon, LockIcon, PlusIcon, RadioTowerIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { isTypingTarget } from "@/components/shell/actions/use-shortcuts";
import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { TrackerMark, trackerMarkAt } from "./tracker-mark";
import { EmptyPicker, TrackerPickerDialog } from "./tracker-picker";
import { agoText, keptApartText, kindWord, modeWord, rowStatus } from "./tracker-words";
import type { PickerKinds, TrackerItem, TrackerKind } from "./tracker-words";
import { HowItWorksPanel, StatusLabel, TrackerPanel, TrackerPanelLoading } from "./trackers-panel";

// Organization › Trackers (F-152, F-008, F-005; app-targets/m11-trackers/trackers.md): every
// tracker connection of the organization, of any kind, at once: its mark, name, workspace or site,
// how its events arrive, when the last came, and whether it's healthy, with the selected one's detail
// in the properties panel. Admins connect another from `Connect a tracker` (or `c`); a member reads
// the list without it, under the line that says changes are the admins'. With no connection yet the
// picker sits on the page. On a phone each connection is a card that opens its page.

const th = "h-[30px] border-b border-line pr-3 text-left align-middle text-[12.5px] font-medium text-faint";
const dash = "–";

/** The table's Mode cell: `radio-tower` or `refresh-cw` in `--faint`, then the word. */
const ModeCell = ({ mode }: { readonly mode: TrackerItem["webhookMode"] }) => (
  <span className="inline-flex items-center gap-[7px] whitespace-nowrap text-[13.5px] text-muted">
    {mode === "webhooks" ? <RadioTowerIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : <RefreshCwIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />}
    {modeWord(mode)}
  </span>
);

/** The Status cell: the word with its mark, and Pending's or Failed's reason under it. */
const StatusCell = ({ connection }: { readonly connection: TrackerItem }) => {
  const status = rowStatus(connection);
  return (
    <span className="flex flex-col leading-[1.25]">
      <StatusLabel status={status} className="text-[13.5px]" />
      {(status.kind === "pending" || status.kind === "failed") && status.why !== null ? (
        <span className="truncate pl-4 text-[12.5px] text-faint" title={status.why}>{status.why}</span>
      ) : null}
    </span>
  );
};

const ConnectionRow = ({
  connection,
  selected,
  now,
  onSelect,
  onOpen,
  onKey,
}: {
  readonly connection: TrackerItem;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>) => void;
}) => (
  <tr
    tabIndex={0}
    aria-selected={selected}
    data-connection={connection.id}
    data-kind={connection.kind}
    onClick={onSelect}
    onDoubleClick={onOpen}
    onKeyDown={onKey}
    className={cn("h-[46px] cursor-pointer border-b border-line hover:bg-hover", selected && "bg-sel hover:bg-sel [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md")}
  >
    <td className="pl-2 pr-3">
      <span className="flex min-w-0 items-center gap-[11px]">
        <TrackerMark kind={connection.kind} size={trackerMarkAt.trackersRow.size} label={false} />
        <span className="flex min-w-0 flex-col leading-[1.25]">
          <span className="truncate text-[14px] font-medium text-text">{connection.name}</span>
          <span className="whitespace-nowrap text-[12.5px] text-faint">{kindWord(connection.kind)}</span>
        </span>
      </span>
    </td>
    <td className="pr-3">
      <span className="block truncate font-mono text-sm text-muted" title={connection.site ?? undefined}>{connection.site ?? dash}</span>
    </td>
    <td className="pr-3">
      <ModeCell mode={connection.webhookMode} />
    </td>
    <td className="whitespace-nowrap pr-3 font-mono text-sm text-muted">
      {connection.lastEventAt === null ? <span className="text-faint">{dash}</span> : agoText(connection.lastEventAt, now)}
    </td>
    <td className="pr-2">
      <StatusCell connection={connection} />
    </td>
  </tr>
);

/** A connection on a phone (`trackers-phone`): a card between hairlines that opens its page. */
const ConnectionCard = ({ connection, now }: { readonly connection: TrackerItem; readonly now: number }) => {
  const status = rowStatus(connection);
  return (
    <li className="border-b border-line first:border-t">
      <Link href={`/organization/trackers/${connection.id}`} data-connection={connection.id} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 py-3">
        <TrackerMark kind={connection.kind} size={trackerMarkAt.trackersPhoneRow.size} label={false} className="mt-px" />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium leading-5 text-text">{connection.name}</span>
          <span className="mt-0.5 block truncate font-mono text-[12.5px] text-muted">{connection.site ?? kindWord(connection.kind)}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted">
            <StatusLabel status={status} />
            {status.kind === "pending" || status.kind === "failed" ? (
              status.why === null ? null : <span className="min-w-0 truncate">{status.why}</span>
            ) : (
              <>
                <span>{modeWord(connection.webhookMode)}</span>
                {connection.lastEventAt === null ? null : <span className="font-mono text-[12.5px]">{agoText(connection.lastEventAt, now)}</span>}
              </>
            )}
          </span>
        </span>
        <ChevronRightIcon aria-hidden className="mt-0.5 size-4 stroke-[1.75] text-faint" />
      </Link>
    </li>
  );
};

/** One line in `--muted` with its `info` icon: what a member can't do here. */
const MemberLine = () => (
  <p className="mt-4 flex items-start gap-2 text-[13.5px] leading-normal text-muted" data-testid="trackers-member">
    <InfoIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75]" />
    <span>{t("trackers.member")}</span>
  </p>
);

export const TrackersView = ({ kinds }: { readonly kinds: PickerKinds }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const params = useSearchParams();
  const [mounted] = useState(() => Date.now());
  const me = useQuery(trpc.me.get.queryOptions());
  const list = useQuery({ ...trpc.trackers.list.queryOptions(), refetchInterval: 30_000 });
  const now = list.dataUpdatedAt === 0 ? mounted : list.dataUpdatedAt;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<TrackerKind | null>(null);
  const tableRef = useRef<HTMLTableSectionElement | null>(null);
  const emptyRef = useRef<HTMLDivElement | null>(null);

  const data = list.data;
  const connections = data?.connections ?? [];
  const canManage = data?.canManage ?? false;
  const empty = data !== undefined && connections.length === 0;
  const selectedParam = params.get("connection");
  const selected = connections.find((connection) => connection.id === selectedParam) ?? connections[0] ?? null;
  const detail = useQuery(trpc.trackers.get.queryOptions(selected === null ? skipToken : { id: selected.id }));

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("connection", id);
    router.replace(`/organization/trackers?${next.toString()}`, { scroll: false });
  };
  const open = (id: string) => { router.push(`/organization/trackers/${id}`); };

  // `c` opens Connect a tracker (the empty page's tiles take the focus instead), never while typing
  // or with a dialog open, and only for the admins who may connect one.
  const latest = useRef({ canManage, empty });
  latest.current = { canManage, empty };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "c" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (isTypingTarget(event.target) || document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu']") !== null) return;
      if (!latest.current.canManage) return;
      event.preventDefault();
      if (latest.current.empty) emptyRef.current?.querySelector<HTMLElement>("[role='radio']")?.focus();
      else setPickerOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

  // The table is a list of rows: `↑`/`↓` move the selection (the panel follows), `Enter` opens.
  const onKey = (index: number) => (event: KeyboardEvent<HTMLTableRowElement>) => {
    const row = connections[index];
    if (row === undefined) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(row.id);
    } else if (event.key === " ") {
      event.preventDefault();
      select(row.id);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = index + (event.key === "ArrowDown" ? 1 : -1);
      const next = connections[at];
      if (next === undefined) return;
      select(next.id);
      const element = tableRef.current?.children[at];
      if (element instanceof HTMLElement) element.focus();
    }
  };

  const connect = t("trackers.connect");
  const actions =
    canManage && !empty ? (
      <>
        <Button variant="primary" className="max-md:hidden" onClick={() => { setPickerOpen(true); }}>
          <PlusIcon className="stroke-[1.75]" />
          {connect}
        </Button>
        <button
          type="button"
          aria-label={connect}
          title={connect}
          onClick={() => { setPickerOpen(true); }}
          className="grid size-11 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-text md:hidden"
        >
          <PlusIcon aria-hidden className="size-5 stroke-[1.75]" />
        </button>
      </>
    ) : undefined;

  const properties = data === undefined ? (list.isError ? undefined : <TrackerPanelLoading />) : empty ? <HowItWorksPanel /> : selected === null ? undefined : <TrackerPanel connection={selected} detail={detail.data?.id === selected.id ? detail.data : undefined} canManage={canManage} now={now} />;

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("trackers.title") }]}
      {...(actions === undefined ? {} : { actions })}
      {...(properties === undefined ? {} : { properties })}
      phoneProperties="sheet"
      phoneTitle={{ title: t("trackers.title"), line: null }}
    >
      <div className="max-w-[760px]">
        <PageHeading
          title={t("trackers.title")}
          lede={
            <>
              {/* The phone target's lede: 14px, two lines (its `http` picture's `.ph .lede`). */}
              <span className="text-[14px] sm:hidden">{t("trackers.ledeShort")}</span>
              <span className="max-sm:hidden">{t("trackers.lede")}</span>
            </>
          }
        />
        {list.isError ? (
          <p role="alert" className="mt-6 text-sm text-red">{errorText(list.error)}</p>
        ) : data === undefined ? (
          <Section title={t("trackers.connections")} className="mt-[22px]">
            <SkeletonRows rows={3} height="h-[46px]" bars={["w-5 h-5", "w-[160px]", "w-[120px]", "w-[80px]"]} />
          </Section>
        ) : empty ? (
          canManage ? (
            <div ref={emptyRef}>
              <EmptyPicker kinds={kinds} picked={picked} onPick={setPicked} />
            </div>
          ) : (
            <>
              <MemberLine />
              <p className="mt-3 text-ui text-muted" data-testid="trackers-none">{t("trackers.memberEmpty")}</p>
            </>
          )
        ) : (
          <>
            {canManage ? null : <MemberLine />}
            {/* The phone target lists the cards under the lede, with no section title. */}
            <Section title={t("trackers.connections")} count={connections.length} className="mt-[22px] max-sm:[&>div:first-child]:hidden">
              <table className="w-full table-fixed border-collapse text-ui max-sm:hidden" data-testid="tracker-connections" aria-label={t("trackers.rows")}>
                <colgroup>
                  <col />
                  <col className="w-[188px] max-lg:w-[150px]" />
                  <col className="w-[112px]" />
                  <col className="w-[92px] max-md:hidden" />
                  <col className="w-[118px]" />
                </colgroup>
                <thead>
                  <tr>
                    <th className={cn(th, "pl-2")}>{t("trackers.col.connection")}</th>
                    <th className={th}>{t("trackers.col.site")}</th>
                    <th className={th}>{t("trackers.col.mode")}</th>
                    <th className={cn(th, "max-md:hidden")}>{t("trackers.col.lastEvent")}</th>
                    <th className={th}>{t("trackers.col.status")}</th>
                  </tr>
                </thead>
                <tbody ref={tableRef}>
                  {connections.map((connection, index) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      selected={connection.id === selected?.id}
                      now={now}
                      onSelect={() => { select(connection.id); }}
                      onOpen={() => { open(connection.id); }}
                      onKey={onKey(index)}
                    />
                  ))}
                </tbody>
              </table>
              <ul className="sm:hidden" data-testid="tracker-cards">
                {connections.map((connection) => (
                  <ConnectionCard key={connection.id} connection={connection} now={now} />
                ))}
              </ul>
              <p className="mt-3.5 flex max-w-[640px] items-start gap-2 text-sm text-faint" data-testid="trackers-kept-apart">
                <LockIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
                <span className="max-sm:hidden">{keptApartText(connections.map((connection) => connection.name))}</span>
                <span className="sm:hidden">{t("trackers.keptApartShort")}</span>
              </p>
            </Section>
          </>
        )}
      </div>
      {canManage && !empty ? <TrackerPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} kinds={kinds} picked={picked} onPick={setPicked} /> : null}
    </PageFrame>
  );
};
