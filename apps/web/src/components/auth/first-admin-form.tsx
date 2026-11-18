"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

const MIN_PASSWORD = 12;

/**
 * "Create the first admin" (F-001, F-002, Q117): the setup token from the server's log, the
 * account and the organization's name. A wrong token gets one clear line and nothing else.
 */
export const FirstAdminForm = () => {
  const trpc = useTRPC();
  const router = useRouter();
  const [form, setForm] = useState({ setupToken: "", username: "", email: "", password: "", organizationName: "" });
  const create = useMutation(
    trpc.setup.createFirstAdmin.mutationOptions({
      onSuccess: () => {
        router.replace("/");
        router.refresh();
      },
    }),
  );
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const failure = create.error === null ? null : create.error.data?.code === "FORBIDDEN" ? t("firstAdmin.wrongToken") : errorText(create.error);
  const tokenWrong = create.error?.data?.code === "FORBIDDEN";

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    create.mutate({ ...form, username: form.username.trim().toLowerCase(), email: form.email.trim(), organizationName: form.organizationName.trim(), setupToken: form.setupToken.trim() });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Field id="setupToken" label={t("firstAdmin.setupToken")} help={t("firstAdmin.setupTokenHelp")} error={tokenWrong ? failure : null}>
        <Input id="setupToken" autoComplete="off" spellCheck={false} className="font-mono" required aria-invalid={tokenWrong} value={form.setupToken} onChange={(e) => { set("setupToken")(e.target.value); }} />
      </Field>
      <Field id="organizationName" label={t("firstAdmin.organizationName")}>
        <Input id="organizationName" autoComplete="organization" required value={form.organizationName} onChange={(e) => { set("organizationName")(e.target.value); }} />
      </Field>
      <Field id="username" label={t("firstAdmin.username")} help={t("firstAdmin.usernameHelp")}>
        <Input id="username" autoComplete="username" required value={form.username} onChange={(e) => { set("username")(e.target.value); }} />
      </Field>
      <Field id="email" label={t("firstAdmin.email")}>
        <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(e) => { set("email")(e.target.value); }} />
      </Field>
      <Field id="password" label={t("firstAdmin.password")} help={t("firstAdmin.passwordHelp", { n: MIN_PASSWORD })} error={tokenWrong ? null : failure}>
        <Input id="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={form.password} onChange={(e) => { set("password")(e.target.value); }} />
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="mt-2 w-full"
        disabled={create.isPending || Object.values(form).some((value) => value.trim() === "") || form.password.length < MIN_PASSWORD}
      >
        {create.isPending ? t("firstAdmin.busy") : t("firstAdmin.submit")}
      </Button>
    </form>
  );
};
