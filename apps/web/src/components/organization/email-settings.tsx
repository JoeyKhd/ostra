"use client";

import { CheckIcon, CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, LockIcon, SendIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SecretField } from "@/components/ui/secret-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { delayText } from "../account/notification-words";
import { lastChangeText, providerName, settingsList, whenText } from "./email-words";
import type { EmailChange, EmailDraft, EmailField, EmailProblems, EmailProvider, SavedEmail, SmtpSecurity } from "./email-words";

// The email settings' parts (email-settings.md, F-115): the provider, its section, the sender, the
// test and the panel. Each takes plain data; `email-settings-view.tsx` wires them to ticket 37's
// `email.settings`, `.save` and `email.sendTest`.

/** A test mail's outcome: accepted by the provider (its host, or `Resend`), or its reason in words. */
export type TestOutcome = { readonly ok: true; readonly by: string; readonly at: number } | { readonly ok: false; readonly message: string; readonly at: number };

/** What the page shows beside the form (ticket 37's `email.settings.get`). */
export type EmailFacts = {
  readonly saved: SavedEmail;
  /** The settings that lock the page (`OSTRA_EMAIL_PROVIDER`, …); empty when the panel owns it. */
  readonly lockedBy: readonly string[];
  /** The two non-secret settings' values, `null` when unset. */
  readonly settings: { readonly provider: string | null; readonly from: string | null };
  readonly delaySeconds: number;
  readonly lastTest: TestOutcome | null;
  readonly lastChange: EmailChange | null;
};

const PROVIDERS = ["off", "resend", "smtp"] as const satisfies readonly EmailProvider[];
const SECURITIES = ["starttls", "tls", "none"] as const satisfies readonly SmtpSecurity[];

const providerHint = (provider: EmailProvider): string => {
  switch (provider) {
    case "off":
      return t("email.offHint");
    case "resend":
      return t("email.resendHint");
    case "smtp":
      return t("email.smtpHint");
    default:
      return provider satisfies never;
  }
};

const providerLabel = (provider: EmailProvider): string => (provider === "off" ? t("email.off") : providerName(provider));

/** The lock block: `--line-2` rule, a lock and the settings that own the page (never amber). */
export const LockBlock = ({ lockedBy }: { readonly lockedBy: readonly string[] | "read-only" }) => {
  const settings = lockedBy === "read-only" ? null : settingsList(lockedBy);
  const [before = "", after = ""] = t("email.locked", { settings: "\u0000" }).split("\u0000");
  return (
    <p className="mt-4 flex max-w-[720px] items-start gap-2 border-l-2 border-line-2 pl-3 text-[12.5px] leading-5 text-muted">
      <LockIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75]" />
      <span>
        {settings === null ? (
          t("email.readOnly")
        ) : (
          <>
            {before}
            <span className="font-mono">{settings}</span>
            {after}
          </>
        )}
      </span>
    </p>
  );
};

const Title = ({ children, className }: { readonly children: string; readonly className?: string }) => <h2 className={cn("mb-2 mt-7 text-ui font-semibold text-text", className)}>{children}</h2>;

/** A 44px form row: a 180px label column (120px on a phone) and the control. */
const FormRow = ({ id, label, children, problem }: { readonly id: string; readonly label: string; readonly children: ReactNode; readonly problem?: string | undefined }) => (
  <div className="border-b border-line first:border-t">
    <div className="grid min-h-11 grid-cols-[120px_minmax(0,1fr)] items-center gap-x-0 sm:grid-cols-[180px_minmax(0,1fr)]">
      <label htmlFor={id} className="text-ui text-muted">
        {label}
      </label>
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
    {problem === undefined ? null : (
      <p id={`${id}-problem`} role="alert" className="pb-2 text-xs text-red sm:pl-[180px]">
        {problem}
      </p>
    )}
  </div>
);

const inputClass = "h-8 min-w-0 flex-1 font-mono text-[12.5px] sm:flex-none";

export type EmailFormProps = {
  readonly draft: EmailDraft;
  readonly saved: SavedEmail;
  readonly problems: EmailProblems;
  /** Shown problems: a field's only after it was touched or a save was tried. */
  readonly shown: ReadonlySet<EmailField>;
  /** Locked by settings, read-only for an organization admin, or saving. */
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onDraft: (draft: EmailDraft) => void;
  readonly onTouch: (field: EmailField) => void;
};

/** Provider, the provider's section and the sender. */
export const EmailForm = ({ draft, saved, problems, shown, disabled, readOnly, onDraft, onTouch }: EmailFormProps) => {
  const problem = (field: EmailField): string | undefined => {
    const key = problems[field];
    return key === undefined || !shown.has(field) ? undefined : t(key);
  };
  const text = (field: "host" | "port" | "user" | "fromAddress" | "fromName", id: string, width: string, type = "text") => {
    const touch: EmailField | null = field === "user" || field === "fromName" ? null : field;
    const invalid = touch !== null && problem(touch) !== undefined;
    return (
      <Input
        id={id}
        type={type}
        className={cn(inputClass, width)}
        value={draft[field]}
        disabled={disabled || readOnly}
        aria-invalid={invalid}
        {...(invalid ? { "aria-describedby": `${id}-problem` } : {})}
        onChange={(event) => {
          onDraft({ ...draft, [field]: event.target.value });
        }}
        onBlur={() => {
          if (touch !== null) onTouch(touch);
        }}
      />
    );
  };
  return (
    <>
      <Title>{t("email.provider")}</Title>
      <RadioGroup
        value={draft.provider}
        disabled={disabled || readOnly}
        aria-label={t("email.provider")}
        onValueChange={(value) => {
          const provider = PROVIDERS.find((option) => option === value);
          if (provider !== undefined) onDraft({ ...draft, provider });
        }}
      >
        {PROVIDERS.map((provider) => (
          <label key={provider} className="flex h-8 items-center text-ui">
            <RadioGroupItem
              value={provider}
              className="size-4 border-control-line data-[state=checked]:border-[5px] data-[state=checked]:border-text data-[state=checked]:bg-bg [&>span]:hidden"
            />
            <span className="ml-2.5 text-text">{providerLabel(provider)}</span>
            <span className="ml-2.5 text-faint">{providerHint(provider)}</span>
          </label>
        ))}
      </RadioGroup>

      {draft.provider === "off" ? <p className="mt-2.5 text-[12.5px] text-muted">{t("email.offLine")}</p> : null}

      {draft.provider === "smtp" ? (
        <section>
          <Title>{t("email.smtpTitle")}</Title>
          <FormRow id="email-host" label={t("email.host")} problem={problem("host")}>
            {text("host", "email-host", "sm:w-[320px]")}
          </FormRow>
          <FormRow id="email-port" label={t("email.port")} problem={problem("port")}>
            {text("port", "email-port", "w-[88px] flex-none")}
          </FormRow>
          <FormRow id="email-security" label={t("email.security")} problem={problem("security")}>
            <Select
              value={draft.secure}
              disabled={disabled || readOnly}
              onValueChange={(value) => {
                const secure = SECURITIES.find((option) => option === value);
                if (secure !== undefined) {
                  onDraft({ ...draft, secure });
                  onTouch("security");
                }
              }}
            >
              <SelectTrigger id="email-security" className={cn("h-8 w-[200px] bg-surface", problem("security") !== undefined && "border-red")} aria-invalid={problem("security") !== undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECURITIES.map((secure) => (
                  <SelectItem key={secure} value={secure}>
                    {t(`email.${secure}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow id="email-user" label={t("email.username")}>
            {text("user", "email-user", "sm:w-[320px]")}
          </FormRow>
          <FormRow id="email-password" label={t("email.password")}>
            <SecretField
              id="email-password"
              set={saved.smtp.passwordSet}
              value={draft.password}
              disabled={disabled}
              readOnly={readOnly || disabled}
              onChange={(password) => {
                onDraft({ ...draft, password });
              }}
            />
          </FormRow>
          <p className="mt-2.5 text-[12.5px] text-faint">{t("email.smtpHelp")}</p>
        </section>
      ) : null}

      {draft.provider === "resend" ? (
        <section>
          <Title>{t("email.resendTitle")}</Title>
          <FormRow id="email-api-key" label={t("email.apiKey")} problem={problem("apiKey")}>
            <SecretField
              id="email-api-key"
              set={saved.resendKeySet}
              value={draft.apiKey}
              disabled={disabled}
              readOnly={readOnly || disabled}
              invalid={problem("apiKey") !== undefined}
              {...(problem("apiKey") === undefined ? {} : { describedBy: "email-api-key-problem" })}
              onChange={(apiKey) => {
                onDraft({ ...draft, apiKey });
                onTouch("apiKey");
              }}
            />
          </FormRow>
          <p className="mt-2.5 text-[12.5px] text-faint">{t("email.resendHelp")}</p>
        </section>
      ) : null}

      {draft.provider === "off" ? null : (
        <section>
          <Title>{t("email.sender")}</Title>
          <FormRow id="email-from-address" label={t("email.fromAddress")} problem={problem("fromAddress")}>
            {text("fromAddress", "email-from-address", "sm:w-[320px]", "email")}
          </FormRow>
          <FormRow id="email-from-name" label={t("email.fromName")}>
            {text("fromName", "email-from-name", "sm:w-[320px]")}
          </FormRow>
          <p className="mt-2.5 text-[12.5px] text-faint">{t("email.senderHelp")}</p>
        </section>
      )}
    </>
  );
};

export type TestSectionProps = {
  readonly address: string | null;
  readonly edited: boolean;
  readonly sending: boolean;
  /** This visit's test, or `null` before one. */
  readonly outcome: TestOutcome | null;
  readonly error: string | null;
  readonly onSend: () => void;
};

/** `Send a test mail` to the admin's own address, with the saved settings, and its result. */
export const TestSection = ({ address, edited, sending, outcome, error, onSend }: TestSectionProps) => {
  const hint = address === null ? t("email.noAddress") : edited ? t("email.saveToTest") : t("email.testTo", { address });
  return (
    <section>
      <Title>{t("email.test")}</Title>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button className="h-8 text-ui" disabled={address === null || edited || sending} onClick={onSend}>
          {sending ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <SendIcon aria-hidden className="size-[14px]" />}
          {sending ? t("email.sending") : t("email.sendTest")}
        </Button>
        <span className="text-[12.5px] text-faint">{hint}</span>
      </div>
      <div role="status" className="mt-2.5 min-h-5 text-[12.5px]">
        {outcome === null ? null : outcome.ok ? (
          <span className="flex items-center gap-1.5 text-green">
            <CircleCheckIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
            {t("email.accepted", { provider: outcome.by, time: formatClock(outcome.at), address: address ?? "" })}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-red">
            <CircleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
            {outcome.message}
          </span>
        )}
        {error === null ? null : (
          <span role="alert" className="flex items-center gap-1.5 text-red">
            <CircleAlertIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
            {error}
          </span>
        )}
      </div>
    </section>
  );
};

/** The footnote, and the save's outcome under it. */
export const EmailFoot = ({ saved, error }: { readonly saved: boolean; readonly error: string | null }) => (
  <div className="mt-6">
    <p className="text-xs text-faint">{t("email.footnote")}</p>
    {saved ? (
      <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-green">
        <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {t("email.saved")}
      </p>
    ) : null}
    {error === null ? null : (
      <p role="alert" className="mt-2 text-[12.5px] text-red">
        {error}
      </p>
    )}
  </div>
);

const Mono = ({ children, faint = false }: { readonly children: string; readonly faint?: boolean }) => <span className={cn("truncate font-mono text-xs", faint ? "text-faint" : "text-text")}>{children}</span>;

/** The properties panel: status, the two settings, the last test and the last change. */
export const EmailPanel = ({ facts, now }: { readonly facts: EmailFacts | undefined; readonly now: number }) => {
  const value = (node: (data: EmailFacts) => ReactNode) => (facts === undefined ? <Skeleton className="w-[100px]" /> : node(facts));
  return (
    <div className="text-[12.5px]">
      <PropGroup title={t("email.status")}>
        <PropRow label={t("email.mail")} labelWidth={150}>
          {value((data) =>
            data.saved.provider === "off" ? (
              <Status tone="grey">{t("email.offStatus")}</Status>
            ) : (
              <Status tone="green">{t("email.onThrough", { provider: providerName(data.saved.provider) })}</Status>
            ),
          )}
        </PropRow>
        <PropRow label={t("email.delay")} labelWidth={150}>
          {value((data) => delayText(data.delaySeconds))}
        </PropRow>
      </PropGroup>
      <PropGroup title={t("email.configuration")}>
        <PropRow label="OSTRA_EMAIL_PROVIDER" labelWidth={150} labelClassName="font-mono text-xs">
          {value((data) => (data.settings.provider === null ? <Mono faint>{t("email.unset")}</Mono> : <Mono>{data.settings.provider}</Mono>))}
        </PropRow>
        <PropRow label="OSTRA_EMAIL_FROM" labelWidth={150} labelClassName="font-mono text-xs">
          {value((data) => (data.settings.from === null ? <Mono faint>{t("email.unset")}</Mono> : <Mono>{data.settings.from}</Mono>))}
        </PropRow>
      </PropGroup>
      <PropGroup title={t("email.lastTest")}>
        {facts === undefined ? (
          <Skeleton className="w-[120px]" />
        ) : facts.lastTest === null ? (
          <p className="text-muted">{t("email.noTest")}</p>
        ) : (
          <>
            <PropRow label={t("email.when")} labelWidth={150}>
              {whenText(facts.lastTest.at, now)}
            </PropRow>
            <PropRow label={t("email.result")} labelWidth={150}>
              {facts.lastTest.ok ? t("email.acceptedShort") : <span className="text-red">{t("email.failedShort")}</span>}
            </PropRow>
          </>
        )}
      </PropGroup>
      <PropGroup title={t("email.lastChange")}>{facts === undefined ? <Skeleton className="w-[160px]" /> : <p className="text-muted">{lastChangeText(facts.lastChange)}</p>}</PropGroup>
    </div>
  );
};
