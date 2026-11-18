"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

/** Sign-in by username or email, and a password (F-002). */
export const SignInForm = () => {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const name = identifier.trim();
    const result = name.includes("@")
      ? await authClient.signIn.email({ email: name, password })
      : await authClient.signIn.username({ username: name.toLowerCase(), password });
    setBusy(false);
    if (result.error !== null) {
      setError(result.error.status === 429 ? t("signIn.tooMany") : t("signIn.failed"));
      return;
    }
    router.replace("/");
    router.refresh();
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <Field id="identifier" label={t("signIn.identifier")}>
        <Input
          id="identifier"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={identifier}
          onChange={(event) => { setIdentifier(event.target.value); }}
        />
      </Field>
      <Field id="password" label={t("signIn.password")} error={error}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={error !== null}
          value={password}
          onChange={(event) => { setPassword(event.target.value); }}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" disabled={busy || identifier === "" || password === ""}>
        {busy ? t("signIn.busy") : t("signIn.submit")}
      </Button>
    </form>
  );
};
