"use client";

import { defaultFirstAdmin } from "@ostra/domain/accounts";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { FormMessage } from "./form-message";
import { brokenRuleOf, changeFailureOf, ruleLineOf, ruleText } from "./new-password";
import type { ChangeFailure, PasswordRule } from "./new-password";
import { safeNext } from "./safe-next";

type Status = { readonly kind: "idle" } | { readonly kind: "submitting" } | { readonly kind: "failed" };

const RULE_ID = "new-password-rule";
const MESSAGE_ID = "change-password-message";

/**
 * better-auth's password change, as a refusal or null. There's no current-password field: this
 * page only opens while the account still has the seeded default password, which is public, and
 * better-auth checks it all the same (change-password.md, Route and flow).
 */
const change = async (newPassword: string): Promise<ChangeFailure | null> => {
  try {
    const result = await authClient.changePassword({ currentPassword: defaultFirstAdmin.password, newPassword, revokeOtherSessions: true });
    return result.error === null ? null : changeFailureOf(result.error.status, result.error.code);
  } catch {
    return { kind: "unknown" };
  }
};

/**
 * "Choose a new password" (F-001, change-password.md): a new password, twice. The rule line is the
 * first field's help, and its error; a mismatch waits for the second field's blur or a submit.
 */
export const ChangePasswordForm = ({ email }: { readonly email: string }) => {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const confirmRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [flagged, setFlagged] = useState<PasswordRule | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const busy = status.kind === "submitting";
  const rule = ruleLineOf(password, flagged);
  const message = mismatch ? t("changePassword.mismatch") : status.kind === "failed" ? t("errors.unknown") : null;

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
    setStatus({ kind: "submitting" });
    const failure = await change(password);
    if (failure === null) {
      router.replace(next);
      router.refresh();
      return;
    }
    switch (failure.kind) {
      case "signedOut":
        router.replace("/sign-in?next=%2Fchange-password");
        return;
      case "rejected":
        setFlagged(failure.rule);
        setStatus({ kind: "idle" });
        return;
      case "unknown":
        setStatus({ kind: "failed" });
        return;
      default:
        failure satisfies never;
    }
  };

  const signOut = async () => {
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  };

  /** Editing clears that field's error and the mismatch: the member is fixing it. */
  const edited = () => {
    setMismatch(false);
    if (status.kind === "failed") setStatus({ kind: "idle" });
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="mt-[24px]">
      {/* So a password manager saves the new password against this account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <div>
        <Label className="mb-[3px]" htmlFor="new-password">{t("changePassword.newPassword")}</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          readOnly={busy}
          aria-invalid={rule.tone === "error"}
          aria-describedby={RULE_ID}
          className="h-[36px] px-[10px]"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setFlagged(null);
            edited();
          }}
          onBlur={() => {
            if (password !== "" && brokenRuleOf(password) === "min") setFlagged("min");
          }}
        />
        <p id={RULE_ID} className={cn("mt-[4px] flex items-center gap-[6px] text-[12px] leading-[18px]", rule.tone === "error" ? "text-red" : "text-faint")}>
          <span className="flex size-[13px] shrink-0 items-center justify-center" aria-hidden>
            {rule.tone === "met" ? <CheckIcon className="size-[13px] text-green" strokeWidth={1.75} /> : null}
            {rule.tone === "error" ? <CircleAlertIcon className="size-[13px]" strokeWidth={1.75} /> : null}
          </span>
          {ruleText(rule.rule)}
        </p>
      </div>
      <div className="mt-[14px]">
        <Label className="mb-[3px]" htmlFor="confirm-password">{t("changePassword.confirm")}</Label>
        <Input
          ref={confirmRef}
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          readOnly={busy}
          aria-invalid={mismatch}
          aria-describedby={message === null ? undefined : MESSAGE_ID}
          className="h-[36px] px-[10px]"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            edited();
          }}
          onBlur={() => {
            if (confirm !== "" && confirm !== password) setMismatch(true);
          }}
        />
      </div>
      {message === null ? null : <FormMessage id={MESSAGE_ID}>{message}</FormMessage>}
      <Button type="submit" variant="primary" size="xl" className="mt-[23px] w-full" disabled={busy || brokenRuleOf(password) !== null || confirm === ""}>
        {busy ? (
          <>
            <LoaderCircleIcon strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />
            {t("changePassword.busy")}
          </>
        ) : (
          t("changePassword.submit")
        )}
      </Button>
      <p className="mt-[12px] text-[12px] leading-[18px] text-faint">
        {t("changePassword.signedInAs", { email })}
        <span aria-hidden className="mx-[6px]">·</span>
        <Button type="button" variant="link" className="h-auto p-0 align-baseline text-[12px] leading-[18px] font-medium" onClick={() => void signOut()}>
          {t("changePassword.signOut")}
        </Button>
      </p>
    </form>
  );
};
