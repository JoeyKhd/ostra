"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRightIcon, BookOpenIcon, CheckIcon, CopyIcon, GlobeIcon, LockIcon, MinusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { copyText, COPIED_MS } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatClock } from "@/lib/format";
import { tNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { checkRowsOf, passedCount, PreviewDomainCheckRows, rowAnnouncement } from "./preview-domain-check";
import type { InstancePreviews } from "./preview-domain-check";
import { PublicLinksSetting } from "./public-links-setting";

// Instance › Previews (milestone 8, ticket 26, F-144, F-142; `instance-preview-domain.md`,
// `instance-preview-domain`, `instance-preview-domain-unset`): the optional preview domain as
// configured, read-only since it's a setting; the one DNS record, the wildcard certificate and the
// WebSocket upgrades to add, in the self-hoster's words; the check with each row's result, kept per
// install; the warning on a domain on the panel's own site (Q307: allowed, never blocking); and the
// organization's "Allow public preview links". With no domain, what works without it and the four
// steps to turn it on. The page runs the check once on its first visit after the domain changes.

/** The example of a preview domain of its own, and the setting's line that sets it (the target's words). */
const EXAMPLE_DOMAIN = "acme-preview.dev";
const settingLine = (domain: string): string => `OSTRA_PREVIEW_DOMAIN=${domain}`;
/** A name on the panel's own site, for the first step: `preview.<the panel's site>`. */
const sharedExample = (panelHost: string): string => ["preview", ...panelHost.replace(/:\d+$/, "").split(".").slice(-2)].join(".");
/** A domain of its own beside the panel's site, for the warning: `acme-preview.dev` beside `acme.dev`. */
const ownExample = (site: string): string => [`${site.split(".")[0] ?? "acme"}-preview`, "dev"].join(".");

const Mono = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => <span className={cn("font-mono", className)}>{children}</span>;

/** A code line with its teal `Copy` at the right; it scrolls sideways inside its box on a phone. */
const CodeLine = ({ copy, children, testId }: { readonly copy: string; readonly children: ReactNode; readonly testId: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return (
    <div className="col-start-2 mt-[7px] flex h-[34px] items-center gap-3 rounded-lg border border-line-2 bg-surface pl-3 pr-1.5 font-mono text-[13px] text-text max-lg:h-11" data-testid={testId}>
      <span className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto whitespace-nowrap">{children}</span>
      <button
        type="button"
        data-copy={copy}
        onClick={() => {
          void copyText(copy, undefined).then((outcome) => {
            if (outcome !== "copied") return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => { setCopied(false); }, COPIED_MS);
          });
        }}
        className="inline-flex h-[26px] shrink-0 items-center gap-[5px] rounded-sm px-2 font-sans text-sm font-medium text-teal hover:bg-sel max-lg:h-11"
      >
        {copied ? <CheckIcon aria-hidden className="size-[13px]" /> : <CopyIcon aria-hidden className="size-[13px]" />}
        {copied ? t("instance.previews.copied") : t("instance.previews.copy")}
      </button>
      <span role="status" aria-live="polite" className="sr-only">{copied ? t("instance.previews.copied") : ""}</span>
    </div>
  );
};

/** One item of a list between hairlines: an icon or a number, its words, and its detail. */
const Item = ({ marker, title, children, testId }: { readonly marker: ReactNode; readonly title: ReactNode; readonly children?: ReactNode; readonly testId?: string }) => (
  <div className="grid grid-cols-[26px_minmax(0,1fr)] gap-x-2 border-b border-line py-2.5" data-testid={testId}>
    <span className="pt-0.5 text-faint [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">{marker}</span>
    <span className="text-ui font-medium text-text">{title}</span>
    {children}
  </div>
);

const Detail = ({ children }: { readonly children: ReactNode }) => <span className="col-start-2 mt-0.5 text-sm text-muted">{children}</span>;

const Step = ({ n }: { readonly n: number }) => (
  <span className="grid size-5 place-items-center rounded-full border border-line-2 font-mono text-[11.5px] font-medium text-muted">{n}</span>
);

const RecordLine = ({ record }: { readonly record: NonNullable<InstancePreviews["record"]> }) => (
  <CodeLine copy={`${record.name} ${record.type} ${record.value}`} testId="preview-dns-record">
    <span>{record.name}</span>
    <span className="text-faint">{record.type}</span>
    <span>{record.value}</span>
  </CodeLine>
);

/** The status in the properties panel: a dot and its word. */
const statusOf = (data: InstancePreviews): { readonly tone: "green" | "red" | "grey"; readonly word: string } => {
  switch (data.status.state) {
    case "not-set":
      return { tone: "grey", word: t("instance.previews.props.notSet") };
    case "unchecked":
      return { tone: "grey", word: t("instance.previews.props.notChecked") };
    case "checked":
      return data.status.passed ? { tone: "green", word: t("instance.previews.props.working") } : { tone: "red", word: t("instance.previews.props.failing") };
    default:
      return data.status satisfies never;
  }
};

const Properties = ({ data }: { readonly data: InstancePreviews }) => {
  const status = statusOf(data);
  const checked = data.status.state === "checked" ? data.status : null;
  return (
    <>
      <PropGroup title={t("instance.previews.props.domain")}>
        <PropRow label={t("instance.previews.props.status")} labelWidth={120}>
          <Dot tone={status.tone} />
          <span data-testid="preview-domain-status">{status.word}</span>
        </PropRow>
        {checked === null ? null : (
          <PropRow label={t("instance.previews.props.lastCheck")} labelWidth={120}>
            <Mono className="text-[13px]">{formatClock(checked.at)}</Mono>
            <span className="text-sm text-faint">{t("instance.previews.props.passedOf", { n: passedCount(checked.check) })}</span>
          </PropRow>
        )}
        <PropRow label={t("instance.previews.props.inBrowser")} labelWidth={120}>
          <span className="text-muted">
            {data.status.state === "not-set" ? t("instance.previews.props.off") : checked?.passed === true ? t("instance.previews.props.on") : t("instance.previews.props.offUntil")}
          </span>
        </PropRow>
        <PropRow label={t("instance.previews.props.panel")} labelWidth={120}><Mono className="truncate text-[13px]">{data.panelHost}</Mono></PropRow>
        <PropRow label={t("instance.previews.props.core")} labelWidth={120}><Mono className="truncate text-[13px]">{data.coreHost}</Mono></PropRow>
      </PropGroup>
      {data.domain === null || data.sameSite === null ? null : (
        <PropGroup title={t("instance.previews.props.signing")}>
          <PropRow label={t("instance.previews.props.cookie")} labelWidth={120}><Mono className="truncate text-[12.5px]">__Host-ostra-preview</Mono></PropRow>
          <PropRow label={t("instance.previews.props.scope")} labelWidth={120}>{t("instance.previews.props.scopeValue")}</PropRow>
          <PropRow label={t("instance.previews.props.sameSite")} labelWidth={120}>
            <span data-testid="preview-samesite">
              {data.sameSite === "lax" ? t("instance.previews.props.lax") : t("instance.previews.props.none")}{" "}
              <span className="text-sm text-faint">{data.sameSite === "lax" ? t("instance.previews.props.laxNote") : t("instance.previews.props.noneNote")}</span>
            </span>
          </PropRow>
          <PropRow label={t("instance.previews.props.lasts")} labelWidth={120}>{t("instance.previews.props.lastsValue")}</PropRow>
          <p className="mt-1 text-[12.5px] text-faint">{t("instance.previews.props.signingHelp")}</p>
        </PropGroup>
      )}
      <PropGroup title={t("instance.previews.props.without")}>
        {(
          [
            [t("instance.previews.props.browserView"), t("instance.previews.props.browserViewNote"), false, true],
            [t("instance.previews.props.cli"), t("instance.previews.props.cliNote"), true, true],
            [t("instance.previews.props.screenshots"), t("instance.previews.props.screenshotsNote"), false, true],
            [t("instance.previews.props.native"), t("instance.previews.props.nativeNote"), false, false],
          ] as const
        ).map(([what, note, mono, works]) => (
          <div key={what} className="grid min-h-7 grid-cols-[22px_minmax(0,1fr)] items-center text-ui">
            {works ? <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" /> : <MinusIcon aria-hidden className="size-[14px] stroke-[1.75] text-faint" />}
            <span className={cn(!works && "text-muted")}>
              <span className={cn(mono && "font-mono")}>{what}</span>
              <span className="ml-1.5 text-[12.5px] text-faint">{note}</span>
            </span>
          </div>
        ))}
      </PropGroup>
    </>
  );
};

const Loading = () => (
  <div aria-busy="true" className="mt-[26px] flex max-w-[744px] flex-col gap-3">
    <Skeleton className="h-9 w-full" />
    <Skeleton className="h-9 w-full" />
    <Skeleton className="h-9 w-2/3" />
  </div>
);

export const PreviewsView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.instance.previews.queryKey();
  const query = useQuery(trpc.instance.previews.queryOptions());
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const check = useMutation(trpc.instance.previewDomainCheck.mutationOptions({ onSettled: () => refresh() }));
  const data = query.data;

  // The check runs once on the first visit after the domain changes (never checked on this domain).
  const ranFor = useRef<string | null>(null);
  const { mutate: runCheck } = check;
  const unchecked = data?.status.state === "unchecked" ? data.status.domain : null;
  useEffect(() => {
    if (unchecked === null || ranFor.current === unchecked) return;
    ranFor.current = unchecked;
    runCheck();
  }, [unchecked, runCheck]);

  const crumbs = [{ label: t("shell.instance") }, { label: t("instance.previews.title") }];
  const actions = data === undefined ? undefined : (
    <Button variant="ghost" size="sm" asChild>
      <a href={data.docs} target="_blank" rel="noopener noreferrer" data-action="previews-docs">
        <BookOpenIcon aria-hidden /> <span className="max-sm:hidden">{t("instance.previews.docs")}</span>
      </a>
    </Button>
  );

  return (
    <PageFrame crumbs={crumbs} {...(actions === undefined ? {} : { actions })} {...(data === undefined ? {} : { properties: <Properties data={data} /> })}>
      <div className="max-w-[744px]" data-testid="instance-previews" data-domain={data?.domain ?? ""}>
        <PageHeading title={t("instance.previews.title")} lede={t("instance.previews.lede")} />
        {data === undefined ? (
          <Loading />
        ) : (
          <PreviewsBody
            data={data}
            checking={check.isPending}
            checkError={check.error === null ? null : errorText(check.error)}
            onCheck={() => { runCheck(); }}
            publicLinks={<PublicLinksSetting organizationName={data.organization.name} admin={data.organization.admin} enabled={data.organization.publicPreviewLinks} linkMaxDays={data.linkMaxDays} onSaved={() => { void refresh(); }} />}
          />
        )}
      </div>
    </PageFrame>
  );
};

export type PreviewsBodyProps = {
  readonly data: InstancePreviews;
  readonly checking: boolean;
  readonly checkError: string | null;
  readonly onCheck: () => void;
  /** The organization's public-links switch (`PublicLinksSetting`), under its section's title. */
  readonly publicLinks: ReactNode;
};

/** The page's sections, from its data: the domain set (its record, certificate and check) or not (the steps). */
export const PreviewsBody = ({ data, checking, checkError, onCheck, publicLinks: setting }: PreviewsBodyProps) => {
  const domain = data.domain;
  const publicLinks = (
    <Section title={t("instance.previews.public.title")} note={t("instance.previews.public.note", { organization: data.organization.name })}>
      {setting}
    </Section>
  );
  const keyRow = (value: ReactNode) => (
    <div className="grid min-h-9 grid-cols-[196px_minmax(0,1fr)] items-center border-y border-line text-ui max-md:grid-cols-1 max-md:gap-1 max-md:py-2" data-testid="preview-domain-setting">
      <Mono className="text-[13px] text-muted">OSTRA_PREVIEW_DOMAIN</Mono>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">{value}</span>
    </div>
  );

  if (domain === null) {
    const own = EXAMPLE_DOMAIN;
    return (
      <>
        <Section title={t("instance.previews.domain.title")} note={t("instance.previews.domain.note")}>
          {keyRow(<span className="text-faint">{t("instance.previews.domain.notSet")}</span>)}
          <p className="mt-3 text-ui text-muted">
            {tNodes("instance.previews.unset.body", { cli: <Mono className="text-[13px] text-text-2">ostra preview</Mono>, localhost: <Mono className="text-[13px] text-text-2">localhost</Mono> })}
          </p>
        </Section>
        <Section title={t("instance.previews.unset.title")} note={t("instance.previews.unset.note")}>
          <div className="border-t border-line">
            <Item marker={<Step n={1} />} title={t("instance.previews.unset.step1")}>
              <Detail>{tNodes("instance.previews.unset.step1Body", { own: <Mono className="text-[12.5px] text-text-2">{own}</Mono>, shared: <Mono className="text-[12.5px] text-text-2">{sharedExample(data.panelHost)}</Mono> })}</Detail>
            </Item>
            <Item marker={<Step n={2} />} title={t("instance.previews.unset.step2")}>
              <RecordLine record={{ name: `*.${own}`, type: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(data.coreHost.replace(/:\d+$/, "")) ? "A" : "CNAME", value: data.coreHost.replace(/:\d+$/, "") }} />
            </Item>
            <Item marker={<Step n={3} />} title={t("instance.previews.unset.step3")}>
              <Detail>{tNodes("instance.previews.unset.step3Body", { name: <Mono className="text-[12.5px] text-text-2">{`*.${own}`}</Mono> })}</Detail>
            </Item>
            <Item marker={<Step n={4} />} title={t("instance.previews.unset.step4")}>
              <CodeLine copy={settingLine(own)} testId="preview-domain-line">
                <span>{settingLine(own)}</span>
              </CodeLine>
            </Item>
          </div>
          <p className="mt-2 text-sm text-faint">
            {tNodes("instance.previews.unset.localhost", { domain: <Mono className="text-[12.5px] text-muted">preview.localhost</Mono>, any: <Mono className="text-[12.5px] text-muted">*.localhost</Mono> })}
          </p>
        </Section>
        {publicLinks}
      </>
    );
  }

  const status = data.status;
  const rows = checkRowsOf(status, checking);
  const checked = status.state === "checked" ? status : null;
  const example = data.exampleHost ?? t("instance.previews.domain.pattern", { domain });
  return (
    <>
      <Section title={t("instance.previews.domain.title")} note={t("instance.previews.domain.note")}>
        {keyRow(
          <>
            <Mono className="text-ui text-text">{domain}</Mono>
            <span className="text-sm text-faint">{t("instance.previews.domain.opensOn")}</span>
            <Mono className="min-w-0 truncate text-[13px] text-muted" >{example}</Mono>
          </>,
        )}
        {data.sharedSite === null ? null : (
          <div className="mt-2.5 flex items-start gap-[9px] text-[13.5px] text-text" data-testid="preview-domain-warning">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-[15px] shrink-0 stroke-[1.75] text-muted" />
            <div>
              {tNodes("instance.previews.warning.line", { domain: <Mono className="text-[13px]">{domain}</Mono>, site: <Mono className="text-[13px]">{data.sharedSite}</Mono> })}
              <div className="text-sm text-muted">
                {tNodes("instance.previews.warning.sub", { example: <Mono className="text-[13px]">{ownExample(data.sharedSite)}</Mono> })}{" "}
                <a href={`${data.docs}#a-domain-of-its-own`} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline">{t("instance.previews.warning.why")}</a>
              </div>
            </div>
          </div>
        )}
      </Section>
      <Section title={t("instance.previews.add.title")} note={t("instance.previews.add.note")}>
        <div className="border-t border-line">
          <Item marker={<GlobeIcon aria-hidden />} title={t("instance.previews.add.dns")} testId="preview-add-dns">
            {data.record === null ? <Detail><span className="text-faint">{t("instance.previews.add.notNeeded", { domain })}</span></Detail> : <RecordLine record={data.record} />}
          </Item>
          <Item marker={<LockIcon aria-hidden />} title={tNodes("instance.previews.add.certificate", { name: <Mono className="text-[13.5px] font-normal">{`*.${domain}`}</Mono> })} testId="preview-add-certificate">
            <Detail>{data.localhost ? <span className="text-faint">{t("instance.previews.add.notNeeded", { domain })}</span> : t("instance.previews.add.certificateBody")}</Detail>
          </Item>
          <Item marker={<ArrowLeftRightIcon aria-hidden />} title={t("instance.previews.add.upgrades")}>
            <Detail>{t("instance.previews.add.upgradesBody")}</Detail>
          </Item>
        </div>
      </Section>
      <Section title={t("instance.previews.check.title")} note={data.localhost ? t("instance.previews.check.noteLocal") : t("instance.previews.check.note")}>
        <div aria-busy={checking}>
          <PreviewDomainCheckRows rows={rows} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 text-sm text-faint">
          <span className="min-w-0 flex-1" data-testid="preview-check-line">
            {checkError !== null ? (
              <span role="alert" className="text-red">{t("instance.previews.check.couldNot", { reason: checkError })}</span>
            ) : checked === null ? null : (
              <>
                {checked.byName === null ? t("instance.previews.check.atNoName", { time: formatClock(checked.at) }) : t("instance.previews.check.at", { time: formatClock(checked.at), name: checked.byName })}{" "}
                {checked.passed ? t("instance.previews.check.working") : t("instance.previews.check.failing")}
              </>
            )}
          </span>
          <Button size="sm" onClick={onCheck} disabled={checking} data-action="preview-check" className="max-lg:h-11">
            <RefreshCwIcon aria-hidden className={cn(checking && "animate-spin motion-reduce:animate-none")} />
            {checking ? t("instance.previews.check.checking") : checked === null ? t("instance.previews.check.run") : t("instance.previews.check.again")}
          </Button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {checking ? "" : rows.map(({ id, row }) => rowAnnouncement(id, row)).filter((line) => line !== null).join(" ")}
        </span>
      </Section>
      {publicLinks}
    </>
  );
};
