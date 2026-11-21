import { ClockIcon, Link2OffIcon, LockIcon, MoonIcon, ServerOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import type { ViewerEnd } from "./viewer-state";

// The viewer page's end blocks (preview-viewer.md, "Every state"; `preview-viewer-states`, 2 and 3):
// a link that expired, was revoked, isn't allowed any more, can't be served, or opens nothing. No
// picture of the app: nothing of it is shown after a link ends. Each is a `status`, so a screen
// reader hears the change while the page is open. An unknown link never says whether it existed.

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** `22 Nov`, in the visitor's own time zone. */
export const shortDate = (at: number): string => dayFormat.format(new Date(at));

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

const Block = ({ icon, title, children, testId }: { readonly icon: ReactNode; readonly title: string; readonly children: ReactNode; readonly testId: string }) => (
  <div className="grid flex-1 place-items-start justify-center bg-bg px-[22px] pb-6 pt-[120px] sm:place-items-center sm:p-6" data-testid="viewer-ended" data-end={testId}>
    <div role="status" className="w-full max-w-[380px]">
      <div aria-hidden className="mb-3.5 grid size-9 place-items-center rounded-[9px] border border-line-2 text-muted [&_svg]:size-[17px] [&_svg]:stroke-[1.75]">{icon}</div>
      <h1 className="mb-1.5 text-[17px] font-semibold leading-[1.35] text-text">{title}</h1>
      <p className="text-[14.5px] text-muted">{children}</p>
      <p className="mt-3.5 border-t border-line pt-3 text-[13px] text-faint">{t("previewViewer.fine")}</p>
    </div>
  </div>
);

/** The label and port as the page names the preview: `web :5173`. */
const Named = ({ label, port }: { readonly label: string; readonly port: number | null }) => (
  <span className="font-mono text-[13.5px] text-text">
    {label}
    {port === null ? null : ` :${String(port)}`}
  </span>
);

export const ViewerEnded = ({ end, now }: { readonly end: ViewerEnd; readonly now: number }) => {
  switch (end.kind) {
    case "expired":
      return (
        <Block icon={<ClockIcon />} title={t("previewViewer.expired.title")} testId="expired">
          {t("previewViewer.expired.before")} <Named label={end.label} port={end.port} />{" "}
          {t("previewViewer.expired.after", { organization: end.organizationName, time: formatClock(end.at), date: shortDate(end.at) })}
        </Block>
      );
    case "revoked":
      return (
        <Block icon={<Link2OffIcon />} title={t("previewViewer.revoked.title")} testId="revoked">
          {sameDay(end.at, now)
            ? t("previewViewer.revoked.today", { organization: end.organizationName, time: formatClock(end.at) })
            : t("previewViewer.revoked.on", { organization: end.organizationName, time: formatClock(end.at), date: shortDate(end.at) })}
        </Block>
      );
    case "not-allowed":
      return (
        <Block icon={<LockIcon />} title={t("previewViewer.notAllowed.title")} testId="not-allowed">
          {t("previewViewer.notAllowed.body", { organization: end.organizationName })}
        </Block>
      );
    case "runner-too-old":
      return (
        <Block icon={<ServerOffIcon />} title={t("previewViewer.tooOld.title")} testId="runner-too-old">
          {t("previewViewer.tooOld.body")}
        </Block>
      );
    case "unknown":
      return (
        <Block icon={<Link2OffIcon />} title={t("previewViewer.unknown.title")} testId="unknown">
          {t("previewViewer.unknown.body")}
        </Block>
      );
    case "too-many-tries":
      return (
        <Block icon={<ClockIcon />} title={t("previewViewer.tooMany.title")} testId="too-many-tries">
          {t("previewViewer.tooMany.body")}
        </Block>
      );
    default:
      return end satisfies never;
  }
};

/** The app isn't running: the last picture stays behind, grey, and the page picks the app up by itself. */
export const ViewerNotRunning = ({ organizationName }: { readonly organizationName: string }) => (
  <div className="absolute inset-0 grid place-items-center p-5" data-testid="viewer-not-running">
    <div role="status" className="w-full max-w-[380px] rounded-xl border border-line-2 bg-raise px-6 py-[22px] shadow-(--shadow-pop)">
      <div aria-hidden className="mb-3 grid size-9 place-items-center rounded-[9px] border border-line-2 text-muted [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"><MoonIcon /></div>
      <h1 className="mb-1 text-[16px] font-semibold text-text">{t("previewViewer.notRunning.title")}</h1>
      <p className="text-[14px] text-muted">{t("previewViewer.notRunning.body", { organization: organizationName })}</p>
    </div>
  </div>
);
