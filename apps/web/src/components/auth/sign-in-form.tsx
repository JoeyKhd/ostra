"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

import { FormMessage } from "./form-message";
import { safeNext } from "./safe-next";
import { signInFailureOf, signInFailureText } from "./sign-in-failure";
import type { SignInFailure } from "./sign-in-failure";

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "failed"; readonly failure: SignInFailure };

const MESSAGE_ID = "sign-in-message";

/** better-auth's sign-in by email or by username, as an HTTP status: 200, the refusal's, or 0 for no reply. */
const attempt = async (identifier: string, password: string): Promise<number> => {
  const name = identifier.trim();
  try {
    const result = name.includes("@")
      ? await authClient.signIn.email({ email: name, password })
      : await authClient.signIn.username({ username: name.toLowerCase(), password });
    return result.error === null ? 200 : result.error.status;
  } catch {
    return 0;
  }
};

/**
 * Sign-in by username or email, and a password (F-002, sign-in.md). A refusal marks both inputs,
 * so it never hints which half was wrong; a rate limit or a server error marks neither.
 */
export const SignInForm = () => {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const busy = status.kind === "submitting";
  const failure = status.kind === "failed" ? status.failure : null;
  const invalid = failure === "credentials";
  const describedBy = failure === null ? undefined : MESSAGE_ID;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || identifier === "" || password === "") return;
    setStatus({ kind: "submitting" });
    const code = await attempt(identifier, password);
    if (code !== 200) {
      setStatus({ kind: "failed", failure: signInFailureOf(code) });
      return;
    }
    router.replace(next);
    router.refresh();
  };

  /** Editing either field clears the refusal: the member is fixing it. */
  const edit = (set: (value: string) => void, value: string) => {
    set(value);
    if (status.kind === "failed") setStatus({ kind: "idle" });
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="mt-[24px]">
      <div>
        <Label className="mb-[3px]" htmlFor="identifier">{t("signIn.identifier")}</Label>
        <Input
          id="identifier"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          readOnly={busy}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="h-[36px] px-[10px]"
          value={identifier}
          onChange={(event) => { edit(setIdentifier, event.target.value); }}
        />
      </div>
      <div className="mt-[16px]">
        <Label className="mb-[3px]" htmlFor="password">{t("signIn.password")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          readOnly={busy}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="h-[36px] px-[10px]"
          value={password}
          onChange={(event) => { edit(setPassword, event.target.value); }}
        />
      </div>
      {failure === null ? null : <FormMessage id={MESSAGE_ID}>{signInFailureText(failure)}</FormMessage>}
      <Button type="submit" variant="primary" size="xl" className="mt-[23px] w-full" disabled={busy || identifier === "" || password === ""}>
        {busy ? (
          <>
            <LoaderCircleIcon strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />
            {t("signIn.busy")}
          </>
        ) : (
          t("signIn.submit")
        )}
      </Button>
    </form>
  );
};
