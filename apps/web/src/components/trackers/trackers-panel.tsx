"use client";

import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { projectColour } from "@/components/shell/project-colour";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { TrackerMark, trackerMarkAt, trackerName } from "./tracker-mark";
import { agoText, capabilityRows, failedWords, kindWord, modeWord, rowStatus, statusWord } from "./tracker-words";
import type { RowStatus, TrackerDetail, TrackerItem } from "./tracker-words";

// Organization › Trackers' properties panel (F-152, F-008; trackers.md, "The properties panel"):
// the selected connection's status, mode, last event, sign-in and token, the boards on it, and what
// its kind's adapter does here, then `Open <name> →` to its page. A member reads it without the
// sign-in and the token (`trackers.list` sends them to admins only). With no connection yet, the
// panel says how it works and how connections are kept apart.

/** The status's mark: a dot (green, red), Pending's dashed ring, or the red `triangle-alert` of a warning. */
export const StatusMark = ({ status }: { readonly status: RowStatus }) => {
  switch (status.kind) {
    case "connected":
      return <Dot tone="green" />;
    case "failed":
      return <Dot tone="red" />;
    case "pending":
      return <span aria-hidden className="inline-block size-[9px] shrink-0 rounded-full border-[1.5px] border-dashed border-faint" />;
    case "silent":
    case "expiring":
      return <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />;
    default:
      return status satisfies never;
  }
};

/** The status's word in its colour: Failed red, Pending `--muted`, the rest `--text`. */
export const StatusLabel = ({ status, className }: { readonly status: RowStatus; readonly className?: string }) => (
  <span className={cn("inline-flex items-center gap-[7px] whitespace-nowrap", status.kind === "failed" ? "text-red" : status.kind === "pending" ? "text-muted" : "text-text", className)}>
    <StatusMark status={status} />
    {statusWord(status)}
  </span>
);

/** `14 Nov`, or `14 Nov 2025` in another year. */
const dayOf = (at: number, now: number): string =>
  new Intl.DateTimeFormat("en-GB", new Date(at).getFullYear() === new Date(now).getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(at);

/** `14 Sep 2027`: a token's date, always with its year. */
const fullDay = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(at);

const Group = ({ title, count, children, first = false }: { readonly title: string; readonly count?: number; readonly children: ReactNode; readonly first?: boolean }) => (
  <div className={cn("border-t border-line", first ? "mt-4 pt-3.5" : "mt-4 pt-4")}>
    <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
      {title}
      {count === undefined ? null : <span className="ml-1.5 font-mono">{count}</span>}
    </h3>
    {children}
  </div>
);

const Prop = ({ label, children, testId }: { readonly label: string; readonly children: ReactNode; readonly testId?: string }) => (
  <div className="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] items-center text-ui" data-prop={testId}>
    <span className="truncate text-muted">{label}</span>
    <span className="flex min-w-0 items-center gap-[7px] overflow-hidden whitespace-nowrap text-text">{children}</span>
  </div>
);

const Faint = ({ children }: { readonly children: ReactNode }) => <span className="min-w-0 truncate text-[13px] text-faint">{children}</span>;

const dash = "–";

/** What `trackers.get` adds for the panel: since when, and the last event's ticket. */
const detailOf = (detail: TrackerDetail | undefined): { readonly since: number | null; readonly ticketKey: string | null; readonly lastEventAt: number | null } => {
  if (detail === undefined) return { since: null, ticketKey: null, lastEventAt: null };
  switch (detail.kind) {
    case "jira":
      return { since: detail.state === "active" ? detail.jira.activatedAt : null, ticketKey: detail.jira.lastEvent?.ticketKey ?? null, lastEventAt: detail.jira.lastEvent?.at ?? null };
    case "linear":
      return {
        since: detail.linear === null ? null : detail.state === "active" ? detail.linear.activatedAt : detail.state === "failed" ? detail.linear.stateSince : null,
        ticketKey: detail.linear?.lastEvent?.ticketKey ?? null,
        lastEventAt: detail.linear?.lastEvent?.at ?? null,
      };
    default:
      return detail satisfies never;
  }
};

/** The token's row: Jira's date (red while it nears), Linear's health. */
const TokenValue = ({ connection, status }: { readonly connection: TrackerItem; readonly status: RowStatus }) => {
  if (connection.kind === "jira") {
    if (connection.tokenExpiresAt === null) return <span className="text-faint">{dash}</span>;
    const [before = "", after = ""] = t("trackers.panel.expires", { date: "{date}" }).split("{date}");
    return (
      <>
        {status.kind === "expiring" || (status.kind === "failed" && connection.tokenExpiry?.state === "expired") ? <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" /> : null}
        <span>
          {before}
          <span className="font-mono text-[13.5px]">{fullDay(connection.tokenExpiresAt)}</span>
          {after}
        </span>
      </>
    );
  }
  switch (connection.state) {
    case "active":
      return <span>{t("trackers.panel.healthy")}</span>;
    case "failed":
      return <span className="truncate text-red">{failedWords(connection.failedReason) ?? t("trackers.status.failed")}</span>;
    case "pending":
      return <span className="text-faint">{dash}</span>;
    default:
      return connection.state satisfies never;
  }
};

/** The selected connection's panel (`trackers`, Globex Jira selected). */
export const TrackerPanel = ({
  connection,
  detail,
  canManage,
  now,
  link = true,
}: {
  readonly connection: TrackerItem;
  readonly detail: TrackerDetail | undefined;
  readonly canManage: boolean;
  readonly now: number;
  /** `Open <name> →` to its page; left out on the page itself. */
  readonly link?: boolean;
}) => {
  const status = rowStatus(connection);
  const more = detailOf(detail);
  const lastEventAt = more.lastEventAt ?? connection.lastEventAt;
  const kindName = trackerName[connection.kind];
  return (
    <div data-testid="tracker-panel" data-connection={connection.id}>
      <div className="flex items-center gap-3">
        <TrackerMark kind={connection.kind} size={trackerMarkAt.trackerPanelHead.size} label={false} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-text">{connection.name}</div>
          <div className="mt-px truncate text-sm text-muted">
            {kindWord(connection.kind)}
            {connection.site === null ? null : (
              <>
                {" · "}
                <span className="font-mono text-[12.5px]">{connection.site}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <Group title={t("trackers.panel.connection")} first>
        <Prop label={t("trackers.panel.status")} testId="status">
          <StatusLabel status={status} />
          {status.kind === "pending" || status.kind === "failed" ? (
            status.why === null ? null : <Faint>{`· ${status.why}`}</Faint>
          ) : more.since === null ? null : (
            <Faint>{`· ${t("trackers.panel.since", { date: dayOf(more.since, now) })}`}</Faint>
          )}
        </Prop>
        <Prop label={t("trackers.panel.mode")} testId="mode">
          {connection.state === "active" && connection.silentSince !== null ? (
            <>
              <TriangleAlertIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-red" />
              <span>{t("trackers.panel.silentSince", { time: formatClock(connection.silentSince) })}</span>
              <Faint>{`· ${t("trackers.panel.silentAfter")}`}</Faint>
            </>
          ) : (
            modeWord(connection.webhookMode)
          )}
        </Prop>
        <Prop label={t("trackers.panel.lastEvent")} testId="last-event">
          {lastEventAt === null ? (
            <span className="text-faint">{dash}</span>
          ) : (
            <>
              <span className="font-mono text-[13.5px]">{agoText(lastEventAt, now)}</span>
              {more.ticketKey === null ? null : <Faint>{`· ${more.ticketKey}`}</Faint>}
            </>
          )}
        </Prop>
        {canManage ? (
          <>
            <Prop label={t("trackers.panel.signsInAs")} testId="signs-in-as">
              {connection.signsInAs === null ? (
                <span className="text-faint">{dash}</span>
              ) : (
                <>
                  <span className="truncate font-mono text-[13.5px]">{connection.signsInAs}</span>
                  <Faint>{`· ${connection.kind === "jira" ? t("trackers.panel.serviceAccount") : t("trackers.panel.appUser")}`}</Faint>
                </>
              )}
            </Prop>
            <Prop label={t("trackers.panel.token")} testId="token">
              <TokenValue connection={connection} status={status} />
            </Prop>
          </>
        ) : null}
      </Group>

      <Group title={t("trackers.panel.boards")} count={connection.boards.length}>
        {connection.boards.length === 0 ? (
          <p className="py-1 text-sm text-faint">{t("trackers.panel.noBoards")}</p>
        ) : (
          <ul data-testid="tracker-boards">
            {connection.boards.map((board) => (
              <li key={board.id} className="flex h-7 items-center gap-[9px] whitespace-nowrap text-ui">
                <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(board.project.id) }} />
                <span className="min-w-0 truncate text-text">{board.project.name}</span>
                <span className="ml-auto min-w-0 truncate pl-2 text-[12.5px] text-faint">
                  {board.name}
                  {board.key === null ? null : (
                    <>
                      {" · "}
                      <span className="font-mono">{board.key}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title={t("trackers.panel.does", { kind: kindName })}>
        <div data-testid="tracker-capabilities">
          {capabilityRows(connection.kind, connection.capabilities, connection.agentModeAt).map((row) => (
            <Prop key={row.label} label={row.label}>
              <span className={cn(row.faint && "text-faint")}>{row.value}</span>
            </Prop>
          ))}
        </div>
      </Group>

      {link ? (
        <Link href={`/organization/trackers/${connection.id}`} className="mt-3.5 inline-flex items-center gap-1 text-ui text-teal hover:underline">
          {t("trackers.panel.open", { name: connection.name })}
          <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        </Link>
      ) : null}
    </div>
  );
};

/** The panel while the list loads: the groups with `–` for every value. */
export const TrackerPanelLoading = () => (
  <div aria-busy data-testid="tracker-panel-loading">
    <Group title={t("trackers.panel.connection")} first>
      {[t("trackers.panel.status"), t("trackers.panel.mode"), t("trackers.panel.lastEvent")].map((label) => (
        <Prop key={label} label={label}>
          <span className="text-faint">{dash}</span>
        </Prop>
      ))}
    </Group>
  </div>
);

const HowStep = ({ n, lead, rest }: { readonly n: number; readonly lead: string; readonly rest: string }) => (
  <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5 py-[7px] text-[13.5px] leading-normal text-muted">
    <span aria-hidden className="mt-px grid size-5 place-items-center rounded-full border border-line-2 font-mono text-[11px] font-medium text-muted">{n}</span>
    <span>
      <b className="font-medium text-text">{lead}</b> {rest}
    </span>
  </li>
);

/** No connection yet: how it works, in three steps, and how each connection is kept apart. */
export const HowItWorksPanel = () => (
  <div data-testid="trackers-how">
    <h3 className="mb-1.5 text-xs font-medium text-faint">{t("trackers.how.title")}</h3>
    <ol>
      <HowStep n={1} lead={t("trackers.how.connect")} rest={t("trackers.how.connectRest")} />
      <HowStep n={2} lead={t("trackers.how.attach")} rest={t("trackers.how.attachRest")} />
      <HowStep n={3} lead={t("trackers.how.start")} rest={t("trackers.how.startRest")} />
    </ol>
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="mb-1.5 text-xs font-medium text-faint">{t("trackers.how.keptTitle")}</h3>
      <p className="text-sm leading-normal text-faint">{t("trackers.how.kept")}</p>
    </div>
  </div>
);
