"use client";

import { CheckCircle2Icon, ServerIcon, XCircleIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

type Step =
  | { readonly kind: "enter" }
  | { readonly kind: "confirm"; readonly code: string }
  | { readonly kind: "approved" }
  | { readonly kind: "denied" };

/** A device code as the runner prints it: letters and digits, any dashes or spaces dropped. */
export const normalizeUserCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The device approval page (`/device`, F-014, ADR 0029): the member enters or confirms the code
 * `ostra runner` printed, and approves it. The runner then trades the device session for its own
 * key pair, and core registers it as the member's personal runner in their active organization.
 */
export const DeviceApproval = () => {
  const params = useSearchParams();
  const fromLink = params.get("user_code");
  const [code, setCode] = useState(fromLink ?? "");
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (event: SubmitEvent) => {
    event.preventDefault();
    const userCode = normalizeUserCode(code);
    setBusy(true);
    setError(null);
    const result = await authClient.device({ query: { user_code: userCode } });
    setBusy(false);
    if (result.error !== null) {
      setError(t("device.unknownCode"));
      return;
    }
    if (result.data.status !== "pending") {
      setError(t("device.notPending"));
      return;
    }
    setStep({ kind: "confirm", code: userCode });
  };

  const decide = async (userCode: string, approve: boolean) => {
    setBusy(true);
    setError(null);
    const result = approve ? await authClient.device.approve({ userCode }) : await authClient.device.deny({ userCode });
    setBusy(false);
    if (result.error !== null) {
      setError(t("device.failed"));
      return;
    }
    setStep({ kind: approve ? "approved" : "denied" });
  };

  return (
    <PageFrame crumbs={[{ label: t("shell.runners"), href: "/organization/runners" }, { label: t("device.title") }]}>
      <PageHeading title={t("device.title")} lede={t("device.lede")} />
      <div className="mt-6 max-w-[440px]">
        {step.kind === "enter" ? (
          <form onSubmit={(event) => void check(event)} noValidate>
            <Field id="user-code" label={t("device.code")} help={t("device.codeHelp")} error={error}>
              <Input
                id="user-code"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="h-10 font-mono text-[16px] tracking-[0.2em]"
                value={code}
                onChange={(e) => { setCode(e.target.value); }}
                placeholder="ABCD-EFGH"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy || normalizeUserCode(code) === ""}>
              {t("device.continue")}
            </Button>
          </form>
        ) : step.kind === "confirm" ? (
          <div data-testid="device-confirm">
            <div className="mb-4 flex items-center gap-2.5 border-y border-line py-3">
              <ServerIcon className="size-[15px] text-muted" />
              <span className="font-mono tracking-[0.15em]">{step.code}</span>
            </div>
            <p className="mb-2 text-body">{t("device.confirmBody")}</p>
            <p className="mb-5 text-sm text-amber">{t("device.notIsolated")}</p>
            {error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{error}</p>}
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void decide(step.code, true)}>
                {t("device.approve")}
              </Button>
              <Button disabled={busy} onClick={() => void decide(step.code, false)}>
                {t("device.deny")}
              </Button>
            </div>
          </div>
        ) : (
          <p role="status" className={step.kind === "approved" ? "flex items-center gap-2 text-green" : "flex items-center gap-2 text-muted"}>
            {step.kind === "approved" ? <CheckCircle2Icon className="size-4" /> : <XCircleIcon className="size-4" />}
            {step.kind === "approved" ? t("device.approved") : t("device.denied")}
          </p>
        )}
      </div>
    </PageFrame>
  );
};
