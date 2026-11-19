"use client";

import { CheckIcon, ClockIcon, KeyRoundIcon, Link2OffIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { AuthMessage } from "./auth-message";
import { FormMessage } from "./form-message";
import { brokenRuleOf, changeFailureOf, ruleLineOf } from "./new-password";
import type { PasswordRule } from "./new-password";
import { PasswordInput } from "./password-input";
import { RuleLine } from "./rule-line";

type Preview = RouterOutputs["accounts"]["resetPreview"] | { readonly state: "too-many" };
type Ended = "saved" | "expired" | "used" | "unknown" | "too-many";

const Back = () => <Link href="/sign-in" className="font-medium text-teal hover:underline">{t("reset.back")}</Link>;

const primaryLink = (href: string, label: string): ReactNode => (
  <Button asChild variant="primary" size="xl" className="w-full">
    <Link href={href}>{label}</Link>
  </Button>
);

/** The message for a link that ended, or was never good (reset-password.md, `/reset/new`). */
export const ResetEnded = ({ ended, emailOn, hours }: { readonly ended: Ended; readonly emailOn: boolean; readonly hours: number }) => {
  const again = emailOn ? { action: primaryLink("/reset", t("reset.requestNew")) } : { help: <p><Back /></p> };
  switch (ended) {
    case "saved":
      return <AuthMessage icon={CheckIcon} title={t("reset.savedTitle")} action={primaryLink("/sign-in", t("reset.signIn"))}>{t("reset.savedLede")}</AuthMessage>;
    case "expired":
      return <AuthMessage icon={ClockIcon} title={t("reset.expiredTitle")} {...again}>{emailOn ? t("reset.expiredOn", { hours }) : t("reset.expiredOff", { hours })}</AuthMessage>;
    case "used":
      return <AuthMessage icon={KeyRoundIcon} title={t("reset.usedTitle")} {...again}>{emailOn ? t("reset.usedOn") : t("reset.usedOff")}</AuthMessage>;
    case "unknown":
      return <AuthMessage icon={Link2OffIcon} title={t("reset.unknownTitle")} {...again}>{emailOn ? t("reset.unknownOn") : t("reset.unknownOff")}</AuthMessage>;
    case "too-many":
      return <AuthMessage icon={ClockIcon} title={t("reset.tooManyTitle")}>{t("reset.tooManyLede")}</AuthMessage>;
    default:
      return ended satisfies never;
  }
};

/**
 * The page a reset link opens (F-002, reset-password.md): a new password, twice. The token leaves
 * the address bar at once and lives in memory for the save. Saving signs every session out; the
 * page never signs anyone in.
 */
export const ResetNewForm = ({ token, preview, emailOn, hours }: { readonly token: string; readonly preview: Preview; readonly emailOn: boolean; readonly hours: number }) => {
  const confirmRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [flagged, setFlagged] = useState<PasswordRule | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ended, setEnded] = useState<Ended | null>(preview.state === "valid" ? null : preview.state);

  useEffect(() => {
    // The token is a bearer secret: off the address bar and out of the history.
    window.history.replaceState(null, "", "/reset/new");
  }, []);

  if (ended !== null || preview.state !== "valid") return <ResetEnded ended={ended ?? "unknown"} emailOn={emailOn} hours={hours} />;

  const rule = ruleLineOf(password, flagged);
  const message = mismatch ? t("changePassword.mismatch") : failed ? t("errors.unknown") : null;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const broken = brokenRuleOf(password);
    if (broken !== null) {
      setFlagged(broken);
      return;
    }
    if (confirm !== password) {
      setMismatch(true);
      confirmRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error === null) {
        await authClient.signOut().catch(() => undefined);
        setEnded("saved");
        return;
      }
      const code = result.error.code;
      if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED") {
        setPassword("");
        setConfirm("");
        setEnded(code === "TOKEN_EXPIRED" ? "expired" : "used");
        return;
      }
      const failure = changeFailureOf(result.error.status, code);
      if (failure.kind === "rejected") setFlagged(failure.rule);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };

  return (
    <div>
      <h1 className="page-title text-text">{t("reset.newTitle")}</h1>
      <p className="mt-[6px] text-lede text-muted">
        {t("reset.newLedeBefore")}
        <span className="font-medium text-text">{preview.address}</span>
        {t("reset.newLedeAfter")}
      </p>
      <form onSubmit={(event) => void submit(event)} noValidate className="mt-[24px]">
        <input type="text" name="username" autoComplete="username" value={preview.address} readOnly hidden />
        <Label className="mb-[3px]" htmlFor="reset-password">{t("reset.newPassword")}</Label>
        <PasswordInput
          id="reset-password"
          autoComplete="new-password"
          autoFocus
          readOnly={busy}
          aria-invalid={rule.tone === "error"}
          aria-describedby="reset-rule"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setFlagged(null); setMismatch(false); setFailed(false); }}
          onBlur={() => { if (password !== "" && brokenRuleOf(password) === "min") setFlagged("min"); }}
        />
        <RuleLine id="reset-rule" rule={rule} />
        <Label className="mb-[3px] mt-[14px]" htmlFor="reset-confirm">{t("reset.confirm")}</Label>
        <PasswordInput
          ref={confirmRef}
          id="reset-confirm"
          autoComplete="new-password"
          readOnly={busy}
          aria-invalid={mismatch}
          value={confirm}
          onChange={(event) => { setConfirm(event.target.value); setMismatch(false); setFailed(false); }}
          onBlur={() => { if (confirm !== "" && confirm !== password) setMismatch(true); }}
        />
        {message === null ? null : <FormMessage id="reset-new-message">{message}</FormMessage>}
        <Button
          type="submit"
          variant="primary"
          size="xl"
          className="mt-[20px] w-full"
          disabled={busy || brokenRuleOf(password) !== null || confirm === ""}
          onMouseDown={(event) => { event.preventDefault(); }}
        >
          {busy ? (
            <>
              <LoaderCircleIcon strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />
              {t("reset.saving")}
            </>
          ) : (
            t("reset.save")
          )}
        </Button>
        <p className="mt-[16px] text-[12px] leading-[18px]"><Back /></p>
      </form>
    </div>
  );
};
