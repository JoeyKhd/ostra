"use client";

import { MIN_PASSWORD_LENGTH } from "@ostra/domain/accounts";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

import { safeNext } from "./sign-in-form";

type Failure = { readonly field: "current" | "next" | "confirm"; readonly text: string };

/** What better-auth's refusal of a password change means, in the form's words. */
const failureOf = (code: string | undefined): Failure => {
  if (code === "INVALID_PASSWORD") return { field: "current", text: t("changePassword.wrongCurrent") };
  if (code === "PASSWORD_TOO_SHORT") return { field: "next", text: t("changePassword.tooShort", { n: MIN_PASSWORD_LENGTH }) };
  return { field: "confirm", text: t("errors.unknown") };
};

/**
 * The current password and a new one, twice (F-001). better-auth checks the policy and the current
 * password; changing it clears the account's default-password flag and signs out its other sessions.
 */
export const ChangePasswordForm = () => {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setFailure({ field: "confirm", text: t("changePassword.mismatch") });
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await authClient.changePassword({ currentPassword: current, newPassword: password, revokeOtherSessions: true });
    setBusy(false);
    if (result.error !== null) {
      setFailure(failureOf(result.error.code));
      return;
    }
    router.replace(next);
    router.refresh();
  };

  const errorFor = (field: Failure["field"]): string | null => (failure?.field === field ? failure.text : null);

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <Field id="current-password" label={t("changePassword.current")} error={errorFor("current")}>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-invalid={failure?.field === "current"}
          value={current}
          onChange={(event) => { setCurrent(event.target.value); }}
        />
      </Field>
      <Field id="new-password" label={t("changePassword.next")} help={t("changePassword.nextHelp", { n: MIN_PASSWORD_LENGTH })} error={errorFor("next")}>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={failure?.field === "next"}
          value={password}
          onChange={(event) => { setPassword(event.target.value); }}
        />
      </Field>
      <Field id="confirm-password" label={t("changePassword.confirm")} error={errorFor("confirm")}>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={failure?.field === "confirm"}
          value={confirm}
          onChange={(event) => { setConfirm(event.target.value); }}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="mt-2 w-full"
        disabled={busy || current === "" || password.length < MIN_PASSWORD_LENGTH || confirm === ""}
      >
        {busy ? t("changePassword.busy") : t("changePassword.submit")}
      </Button>
    </form>
  );
};
