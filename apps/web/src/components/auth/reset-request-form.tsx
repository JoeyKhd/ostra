"use client";

import { LoaderCircleIcon, MailIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

import { AuthMessage } from "./auth-message";
import { FormMessage } from "./form-message";

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent"; readonly address: string }
  | { readonly kind: "failed"; readonly why: "address" | "too-many" | "unknown" };

const MESSAGE_ID = "reset-message";

/**
 * "Forgot your password?" (F-002, reset-password.md): one address, and the same "Check your inbox"
 * whether or not it belongs to an account, so the page never tells which addresses exist.
 */
export const ResetRequestForm = ({ hours }: { readonly hours: number }) => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "sending";

  if (status.kind === "sent") {
    return (
      <AuthMessage
        icon={MailIcon}
        title={t("reset.sentTitle")}
        help={
          <>
            <p>{t("reset.sentHelp")}</p>
            <p className="flex gap-[6px]">
              <Link href="/sign-in" className="font-medium text-teal hover:underline">{t("reset.back")}</Link>
              <span aria-hidden>·</span>
              <Button type="button" variant="link" className="h-auto p-0 text-[12.5px] font-medium" onClick={() => { setEmail(""); setStatus({ kind: "idle" }); }}>
                {t("reset.another")}
              </Button>
            </p>
          </>
        }
      >
        {t("reset.sentBefore")}
        <span className="font-medium text-text">{status.address}</span>
        {t("reset.sentAfter", { hours })}
      </AuthMessage>
    );
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      setStatus({ kind: "failed", why: "address" });
      return;
    }
    setStatus({ kind: "sending" });
    try {
      const result = await authClient.requestPasswordReset({ email: address, redirectTo: "/reset/new" });
      if (result.error === null) setStatus({ kind: "sent", address });
      else setStatus({ kind: "failed", why: result.error.status === 429 ? "too-many" : "unknown" });
    } catch {
      setStatus({ kind: "failed", why: "unknown" });
    }
  };

  const why = status.kind === "failed" ? status.why : null;
  return (
    <div>
      <h1 className="page-title text-text">{t("reset.title")}</h1>
      <p className="mt-[6px] text-lede text-muted">{t("reset.lede")}</p>
      <form onSubmit={(event) => void submit(event)} noValidate className="mt-[28px]">
        <Label className="mb-[3px]" htmlFor="reset-email">{t("reset.email")}</Label>
        <Input
          id="reset-email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          readOnly={busy}
          aria-invalid={why === "address"}
          aria-describedby={why === null ? undefined : MESSAGE_ID}
          className="h-[36px] px-[10px]"
          value={email}
          onChange={(event) => { setEmail(event.target.value); if (status.kind === "failed") setStatus({ kind: "idle" }); }}
        />
        {why === null ? null : (
          <FormMessage id={MESSAGE_ID}>{why === "address" ? t("reset.notAddress") : why === "too-many" ? t("reset.tooMany") : t("errors.unknown")}</FormMessage>
        )}
        <Button type="submit" variant="primary" size="xl" className="mt-[20px] w-full" disabled={busy || !email.includes("@")}>
          {busy ? (
            <>
              <LoaderCircleIcon strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />
              {t("reset.sending")}
            </>
          ) : (
            t("reset.send")
          )}
        </Button>
        <p className="mt-[16px] text-[12px] leading-[18px]">
          <Link href="/sign-in" className="font-medium text-teal hover:underline">{t("reset.back")}</Link>
        </p>
      </form>
    </div>
  );
};
