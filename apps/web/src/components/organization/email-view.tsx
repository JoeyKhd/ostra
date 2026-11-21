"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { EmailFoot, EmailForm, EmailPanel, LockBlock, TestSection } from "./email-settings";
import type { EmailFacts, TestOutcome } from "./email-settings";
import { draftOf, isEdited, problemsOf, providerName, saveInputOf } from "./email-words";
import type { EmailChange, EmailDraft, EmailField, SavedEmail } from "./email-words";

// Ticket 45 wired (email-settings.md; F-115): the install's email through `email.settings.get` and
// `.save`, and "Send a test mail" through `email.sendTest`. An organization admin who isn't the
// instance admin sees the page read-only; settings that lock it are named.

type Settings = RouterOutputs["email"]["settings"]["get"];

export const savedOf = (view: Settings): SavedEmail => ({
  provider: view.provider,
  fromAddress: view.fromAddress,
  fromName: view.fromName,
  resendKeySet: view.resend.apiKey === "set",
  smtp: { host: view.smtp.host, port: view.smtp.port, secure: view.smtp.secure, user: view.smtp.user, passwordSet: view.smtp.password === "set" },
});

const changeOf = (audit: Settings["lastAudit"]): EmailChange | null => {
  if (audit === null) return null;
  const what = audit.action.includes("smtp") ? "smtp" : audit.action.includes("resend") ? "resend" : audit.action.includes("off") ? "off" : "sender";
  return { what, by: audit.actorName ?? t("taskPage.someone"), at: audit.at };
};

export const factsOf = (view: Settings): EmailFacts => ({
  saved: savedOf(view),
  lockedBy: view.lockedBy,
  settings: { provider: view.settingValues["OSTRA_EMAIL_PROVIDER"] ?? null, from: view.settingValues["OSTRA_EMAIL_FROM"] ?? null },
  delaySeconds: view.delaySeconds,
  lastTest: view.lastTest === null ? null : view.lastTest.ok ? { ok: true, by: view.provider === "off" ? "" : providerName(view.provider), at: view.lastTest.at } : { ok: false, message: view.lastTest.words, at: view.lastTest.at },
  lastChange: changeOf(view.lastAudit),
});

export const EmailView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const instanceAdmin = me.data?.instanceAdmin === true;
  const crumbs = [{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.email") }];
  const settings = useQuery({ ...trpc.email.settings.get.queryOptions(), enabled: instanceAdmin });
  const save = useMutation(trpc.email.settings.save.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.email.settings.get.queryKey() }) }));
  const test = useMutation(trpc.email.sendTest.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.email.settings.get.queryKey() }) }));
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [shown, setShown] = useState<ReadonlySet<EmailField>>(new Set());
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [now] = useState(() => Date.now());

  const view = settings.data;
  const saved = view === undefined ? null : savedOf(view);
  useEffect(() => {
    if (saved !== null && draft === null) setDraft(draftOf(saved));
  }, [saved, draft]);

  if (me.data !== undefined && !instanceAdmin) {
    return (
      <PageFrame crumbs={crumbs}>
        <PageHeading title={t("shell.email")} lede={t("email.lede")} />
        <LockBlock lockedBy="read-only" />
      </PageFrame>
    );
  }
  if (view === undefined || saved === null || draft === null) {
    return (
      <PageFrame crumbs={crumbs}>
        <PageHeading title={t("shell.email")} lede={t("email.lede")} />
        {settings.error === null ? null : <p role="alert" className="text-red">{errorText(settings.error)}</p>}
      </PageFrame>
    );
  }
  const problems = problemsOf(draft, saved);
  const edited = isEdited(draft, saved);
  const locked = view.lockedBySettings;
  const trySave = () => {
    setShown(new Set<EmailField>(["host", "port", "security", "fromAddress", "apiKey"]));
    if (Object.keys(problems).length > 0) return;
    setSavedNotice(false);
    save.mutate(saveInputOf(draft), {
      onSuccess: () => {
        setSavedNotice(true);
        setDraft(null);
      },
    });
  };
  return (
    <PageFrame
      crumbs={crumbs}
      // email-settings.md: the page's one primary button, in the top bar, on until the form differs from the saved settings.
      actions={
        locked ? null : (
          <Button variant="primary" disabled={!edited || save.isPending} onClick={trySave} data-action="save-email">
            {save.isPending ? <><LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> {t("email.saving")}</> : t("email.save")}
          </Button>
        )
      }
      properties={<EmailPanel facts={factsOf(view)} now={now} />}
    >
      <PageHeading title={t("shell.email")} lede={t("email.lede")} />
      {locked ? <LockBlock lockedBy={view.lockedBy} /> : null}
      <EmailForm
        draft={draft}
        saved={saved}
        problems={problems}
        shown={shown}
        disabled={locked || save.isPending}
        readOnly={false}
        onDraft={(next) => { setDraft(next); setSavedNotice(false); }}
        onTouch={(field) => { setShown((now) => new Set([...now, field])); }}
      />
      <div className="mt-8">
        <TestSection
          address={view.adminAddress}
          edited={edited}
          sending={test.isPending}
          outcome={outcome}
          error={test.error === null ? null : errorText(test.error)}
          onSend={() => {
            test.mutate(undefined, {
              onSuccess: (result) => {
                setOutcome(result.ok ? { ok: true, by: view.provider === "off" ? "" : providerName(view.provider), at: Date.now() } : { ok: false, message: result.words, at: Date.now() });
              },
            });
          }}
        />
      </div>
      <EmailFoot saved={savedNotice} error={save.error === null ? null : errorText(save.error)} />
    </PageFrame>
  );
};
