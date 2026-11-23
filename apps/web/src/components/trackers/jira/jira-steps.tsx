"use client";

import { ArrowUpRightIcon, CheckIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { Readback, Sentence } from "./jira-readback";
import { expiryWarning, firstExpiryDay, isWholeHost, jiraDefaultName, jiraSiteName, tokenAction, tokenDoneShort, tokenDoneWords, tokenHelp } from "./jira-words";
import type { JiraDetail, JiraReadBack, JiraVerdict, SiteRefusal, StepNumber, StepState } from "./jira-words";

// Connecting Jira's numbered steps (jira-connect.md, "A step"), in the house style of
// connect-linear.md's: hairline rows, a 22px circle (done filled `--green` with a check, the open
// one a 1px `--text` ring, a later one a 1px `--line-2` ring), the title at 14.5px 500 with a teal
// link at its right, the body at 13.5px `--muted`, and the open step's form in a 470px column. Only
// the open step's fields and buttons are reachable; a done step offers only its `Change` or
// `Replace`.

/** One thing a step can do: run it, whether it's running, and what went wrong in words. */
export type StepAct<I> = { readonly run: (input: I) => void; readonly pending: boolean; readonly error: string | null };

const circleLook: Readonly<Record<StepState, string>> = {
  done: "border-green bg-green text-on-primary",
  current: "border-text text-text",
  later: "border-line-2 text-muted",
};

/** The 22px step circle. */
export const StepCircle = ({ state, n }: { readonly state: StepState; readonly n: StepNumber }) => (
  <span data-tick={state} className={cn("inline-grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-[11.5px] font-medium", circleLook[state])}>
    {state === "done" ? <CheckIcon className="size-[13px] stroke-[2.5]" aria-label={t("checklist.done")} /> : n}
  </span>
);

/** The teal link at a step title's right: a page in Jira or Atlassian's admin (`↗`), or the step's own `Change`/`Replace`. */
export const StepLink = ({ children, href, onClick, testId }: { readonly children: ReactNode; readonly href?: string; readonly onClick?: () => void; readonly testId?: string }) =>
  href === undefined ? (
    <button type="button" data-testid={testId} onClick={onClick} className="ml-auto shrink-0 text-[13.5px] font-normal text-teal hover:underline">
      {children}
    </button>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testId} className="ml-auto inline-flex shrink-0 items-center gap-1 text-[13.5px] font-normal text-teal hover:underline">
      {children}
      <ArrowUpRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
    </a>
  );

export type StepProps = {
  readonly n: StepNumber;
  readonly state: StepState;
  readonly title: ReactNode;
  /** Beside the title: the site's host once found, in mono. */
  readonly value?: string;
  /** The teal link at the title's right. */
  readonly link?: ReactNode;
  readonly body?: ReactNode;
  readonly children?: ReactNode;
};

/** A step's row: the circle, the title line, the body and what the step holds. */
export const Step = ({ n, state, title, value, link, body, children }: StepProps) => (
  <li data-step={n} data-look={state} aria-current={state === "current" ? "step" : undefined} className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 border-b border-line pb-[15px] pt-3.5 max-sm:gap-x-2.5 max-sm:py-3">
    <StepCircle state={state} n={n} />
    <div className="min-w-0">
      <div className={cn("flex min-h-[22px] flex-wrap items-center gap-x-2.5 text-body font-medium leading-[22px] max-sm:text-[15px]", state === "done" && "text-muted", state === "later" && "text-muted")}>
        <h3 className="font-medium">{title}</h3>
        {value === undefined ? null : <span className="font-mono text-sm font-normal text-muted max-sm:hidden">{value}</span>}
        {link}
      </div>
      {body === undefined ? null : <div className="mt-0.5 max-w-[600px] text-[13.5px] leading-normal text-muted max-sm:text-ui [&_b]:font-medium [&_b]:text-text">{body}</div>}
      {children}
    </div>
  </li>
);

/** An error under a field, in words: red, with its `triangle-alert`, an alert. */
export const AlertLine = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <p role="alert" className={cn("flex items-start gap-[7px] text-[13.5px] leading-normal text-red", className)}>
    <TriangleAlertIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

const fieldBox = "flex h-8 items-center rounded-md border border-control-line bg-surface text-[13px] text-text focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-teal max-sm:h-10";
const labelText = "mb-[5px] flex items-center gap-2 text-[12.5px] font-medium text-muted";
const bareInput = "h-full min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:text-faint disabled:opacity-60";

// ---------- step 1: the site ----------

export type SiteValues = { readonly site: string; readonly name: string };

export type SiteFormProps = {
  /** The site found before (on `Change`), or nothing yet. */
  readonly site: string;
  /** The connection's name as it is; a placeholder (`Jira`) is prefilled from the site as it's typed. */
  readonly name: string | null;
  readonly act: StepAct<SiteValues>;
  readonly refusal: SiteRefusal | null;
  readonly focus: boolean;
};

/**
 * Step 1's form: `https://` [name] `.atlassian.net` (a pasted URL trimmed to the name), the
 * connection's name prefilled from the site until the admin types one (choice 2), and `Find the
 * site`. A refusal shows under the field: no site there, a Data Center address, a site that
 * doesn't answer, or a site another connection holds, with `Open it →` to it.
 */
export const SiteForm = ({ site: initialSite, name: initialName, act, refusal, focus }: SiteFormProps) => {
  const id = useId();
  const [site, setSite] = useState(initialSite);
  // The name follows the site until the admin edits it (or the connection already had one).
  const [name, setName] = useState<string | null>(initialName);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);
  const shownName = name ?? jiraDefaultName(site);
  const ready = jiraSiteName(site) !== "" && shownName.trim() !== "";
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || act.pending) return;
    act.run({ site: jiraSiteName(site), name: shownName.trim() });
  };
  const errorId = `${id}-site-error`;
  const failed = refusal !== null;
  return (
    <form onSubmit={submit} noValidate aria-label={t("trackers.jira.connect.step1.title")} className="mt-3 flex max-w-[470px] flex-col gap-3 max-sm:max-w-none">
      <div>
        <label htmlFor={`${id}-site`} className={labelText}>
          {t("trackers.jira.connect.step1.site")}
        </label>
        <div className={cn(fieldBox, "gap-0 px-2.5 font-mono", failed && "border-red")}>
          <span aria-hidden className="shrink-0 text-faint">https://</span>
          <input
            ref={field}
            id={`${id}-site`}
            data-testid="jira-site"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            className={cn(bareInput, "px-1")}
            value={site}
            disabled={act.pending}
            aria-invalid={failed}
            aria-describedby={failed ? errorId : undefined}
            onChange={(event) => { setSite(event.target.value); }}
            onPaste={(event) => {
              // A pasted URL is trimmed to the site's name.
              const pasted = event.clipboardData.getData("text");
              if (/[/:]/.test(pasted)) {
                event.preventDefault();
                setSite(jiraSiteName(pasted));
              }
            }}
          />
          {isWholeHost(site) ? null : <span aria-hidden className="shrink-0 text-faint">.atlassian.net</span>}
        </div>
        {refusal === null ? null : (
          <AlertLine className="mt-2">
            <span id={errorId}>{refusal.text}</span>
            {refusal.holder === null ? null : (
              <>
                {" "}
                <Link href={`/organization/trackers/${refusal.holder.id}`} className="text-teal hover:underline">
                  {t("trackers.jira.connect.step1.openIt")}
                </Link>
              </>
            )}
          </AlertLine>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-name`} className={labelText}>
          {t("trackers.jira.connect.step1.name")}
          <span className="ml-auto font-normal text-faint">{t("trackers.jira.connect.step1.nameHint")}</span>
        </label>
        <div className={cn(fieldBox, "px-2.5")}>
          <input
            id={`${id}-name`}
            data-testid="jira-name"
            autoComplete="off"
            maxLength={60}
            className={cn(bareInput, "font-sans text-ui")}
            value={shownName}
            disabled={act.pending}
            onChange={(event) => { setName(event.target.value); }}
          />
        </div>
      </div>
      {act.error === null ? null : <AlertLine>{act.error}</AlertLine>}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!ready || act.pending} className="max-sm:h-11 max-sm:flex-1">
          {act.pending ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : null}
          {act.pending ? t("trackers.jira.connect.step1.running") : t("trackers.jira.connect.step1.action")}
        </Button>
      </div>
    </form>
  );
};

// ---------- step 2: the token ----------

export type TokenValues = { readonly email: string; readonly token: string; readonly expiresOn: string };

export type TokenFormProps = {
  /** The service account's email saved before (on `Replace`), or nothing yet. */
  readonly email: string;
  readonly scopes: readonly string[];
  readonly check: StepAct<TokenValues>;
  readonly save: StepAct<TokenValues>;
  /** The last read-back of what's in the fields; `null` before a check, or once a field changed. */
  readonly readBack: JiraReadBack | null;
  readonly verdict: JiraVerdict | null;
  /** A field changed: the read-back no longer says what's in the fields. */
  readonly onEdit: () => void;
  readonly now: number;
  readonly focus: boolean;
};

/**
 * Step 2's form: the scopes as mono chips, the service account's email, the scoped token
 * (a password with an eye) and its date (choice 6), then `Check the token`, the read-back, and
 * `Save and continue` after a pass, `Save anyway` with warnings only, or `Check the token` again
 * after a failure. The token stays in the field until it's saved, and nowhere else.
 */
export const TokenForm = ({ email: initialEmail, scopes, check, save, readBack, verdict, onEdit, now, focus }: TokenFormProps) => {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [token, setToken] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [shown, setShown] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focus) first.current?.focus();
  }, [focus]);
  const values: TokenValues = { email: email.trim(), token: token.trim(), expiresOn };
  const filled = values.email !== "" && values.token !== "" && expiresOn !== "";
  const busy = check.pending || save.pending;
  const action = readBack === null ? "check" : tokenAction(verdict);
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    onEdit();
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!filled || busy) return;
    if (action === "check") check.run(values);
    else save.run(values);
  };
  const error = save.error ?? check.error;
  return (
    <>
      <ul aria-label={t("trackers.jira.connect.step2.scopes")} className="mt-2 flex flex-wrap gap-1.5">
        {scopes.map((scope) => (
          <li key={scope} className="inline-flex h-6 items-center rounded-[5px] border border-line-2 bg-surface px-[7px] font-mono text-[12.5px] text-text-2">
            {scope}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} noValidate aria-label={t("trackers.jira.connect.step2.title")} className="mt-3 max-w-[470px] max-sm:max-w-none">
        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor={`${id}-email`} className={labelText}>
              {t("trackers.jira.connect.step2.email")}
            </label>
            <div className={cn(fieldBox, "px-2.5")}>
              <input
                ref={first}
                id={`${id}-email`}
                data-testid="jira-email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                className={bareInput}
                value={email}
                disabled={busy}
                onChange={(event) => { edit(setEmail)(event.target.value); }}
              />
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3 max-sm:grid-cols-1">
            <div>
              <label htmlFor={`${id}-token`} className={labelText}>
                {t("trackers.jira.connect.step2.token")}
              </label>
              <div className={cn(fieldBox, "pl-2.5 pr-1")}>
                <input
                  id={`${id}-token`}
                  data-testid="jira-token"
                  type={shown ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={bareInput}
                  value={token}
                  disabled={busy}
                  onChange={(event) => { edit(setToken)(event.target.value); }}
                />
                <button
                  type="button"
                  aria-label={shown ? t("trackers.jira.connect.step2.hideToken") : t("trackers.jira.connect.step2.showToken")}
                  aria-pressed={shown}
                  onClick={() => { setShown((value) => !value); }}
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:text-muted max-sm:size-9"
                >
                  {shown ? <EyeIcon aria-hidden className="size-[15px] stroke-[1.75]" /> : <EyeOffIcon aria-hidden className="size-[15px] stroke-[1.75]" />}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-expires`} className={labelText}>
                {t("trackers.jira.connect.step2.expires")}
              </label>
              <div className={cn(fieldBox, "px-2.5")}>
                <input
                  id={`${id}-expires`}
                  data-testid="jira-expires"
                  type="date"
                  min={firstExpiryDay(now)}
                  className={cn(bareInput, "font-sans text-ui [color-scheme:inherit]")}
                  value={expiresOn}
                  disabled={busy}
                  onChange={(event) => { edit(setExpiresOn)(event.target.value); }}
                />
              </div>
            </div>
          </div>
        </div>
        {readBack === null ? null : <Readback readBack={readBack} />}
        {error === null ? null : <AlertLine className="mt-3">{error}</AlertLine>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={!filled || busy} data-testid="jira-token-action" className="max-sm:h-11">
            {busy ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : null}
            {save.pending
              ? t("trackers.jira.connect.step2.saving")
              : check.pending
                ? t("trackers.jira.connect.step2.checking")
                : action === "save"
                  ? t("trackers.jira.connect.step2.save")
                  : action === "save-anyway"
                    ? t("trackers.jira.connect.step2.saveAnyway")
                    : t("trackers.jira.connect.step2.check")}
          </Button>
          {action === "check" ? null : (
            <Button type="button" disabled={!filled || busy} onClick={() => { check.run(values); }} className="max-sm:h-11">
              {t("trackers.jira.connect.step2.checkAgain")}
            </Button>
          )}
          <span className="text-[12.5px] text-faint">{tokenHelp(readBack, verdict)}</span>
        </div>
      </form>
    </>
  );
};

/** The detail step 2's done line reads: the account, its reach, and the token's date. */
export type TokenDoneDetail = Pick<JiraDetail, "signsInAs" | "tokenExpiresAt" | "tokenExpiry"> & { readonly jira: Pick<JiraDetail["jira"], "reach"> };

/** Step 2 once saved: who it is, what it sees, the token's date; the warning from 14 days before it (F-008/c8). */
export const TokenDone = ({ detail }: { readonly detail: TokenDoneDetail }) => {
  const warning = expiryWarning(detail);
  return (
    <>
      <span className="max-sm:hidden">
        <Sentence words={tokenDoneWords(detail)} monoClassName="text-[13px]" />
      </span>
      <span className="sm:hidden">
        <Sentence words={tokenDoneShort(detail)} monoClassName="text-[13px]" />
      </span>
      {warning === null ? null : (
        <span data-testid="jira-token-expiry" className="mt-1 flex items-start gap-[7px] text-text-2">
          <TriangleAlertIcon aria-hidden className="mt-[3px] size-[14px] shrink-0 stroke-[1.75] text-red" />
          <span className="min-w-0">{warning}</span>
        </span>
      )}
    </>
  );
};
