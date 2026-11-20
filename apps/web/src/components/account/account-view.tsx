"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { cliSessionIdSchema } from "@ostra/protocol";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AccountPanel, CliSessionsSection, GitHubSection } from "./account";
import type { DialogState } from "./account";
import { linkReturnOf } from "./account-words";
import type { LinkReturn } from "./account-words";
import { AppearancePanelGroup, AppearanceSection } from "./theme-choice";

// Ticket 47 wired (account.md; F-119, F-103): the member's GitHub link through
// `/api/github/link/start` and `account.github.*`, and their CLI sessions through
// `account.cliSessions.*`. `?github=…` after the link's callback is read once and cleared.
// Milestone 7 (account-appearance.md, F-082): Appearance first, and its group in the panel.

export const AccountView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const me = useQuery(trpc.me.get.queryOptions());
  const github = useQuery(trpc.account.github.get.queryOptions());
  const sessions = useQuery(trpc.account.cliSessions.list.queryOptions());
  const unlink = useMutation(trpc.account.github.unlink.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.account.github.get.queryKey() }) }));
  const revoke = useMutation(trpc.account.cliSessions.revoke.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.account.cliSessions.list.queryKey() }) }));
  const [back, setBack] = useState<LinkReturn | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const value = linkReturnOf(params.get("github"));
    if (value !== null) {
      setBack(value);
      router.replace("/account", { scroll: false });
    }
  }, [params, router]);

  const dialog = (mutation: { readonly isPending: boolean; readonly error: Parameters<typeof errorText>[0] }): DialogState =>
    mutation.isPending ? { kind: "busy" } : mutation.error !== null ? { kind: "failed", message: errorText(mutation.error) ?? t("errors.unknown") } : { kind: "idle" };
  const organization = me.data?.organization;
  const days = sessions.data?.days ?? 30;

  return (
    <PageFrame
      crumbs={[{ label: t("shell.account") }]}
      {...(me.data === undefined
        ? {}
        : {
            properties: (
              <AccountPanel
                me={{ name: me.data.name, email: me.data.email, role: organization?.role === "admin" ? "admin" : "member", organization: organization?.name ?? "" }}
                github={github.data}
                sessions={sessions.data?.sessions.length}
                days={days}
                appearance={<AppearancePanelGroup />}
              />
            ),
          })}
    >
      <PageHeading title={t("shell.account")} lede={t("account.lede")} />
      <AppearanceSection />
      <GitHubSection
        github={github.data}
        admin={organization?.role === "admin"}
        back={back}
        unlinked={unlinked}
        unlink={dialog(unlink)}
        onUnlink={async () => {
          try {
            await unlink.mutateAsync();
            setUnlinked(true);
            return true;
          } catch {
            return false;
          }
        }}
        onUnlinkReset={() => { unlink.reset(); }}
      />
      <CliSessionsSection
        sessions={sessions.data?.sessions}
        days={days}
        loginLine={`ostra login --server ${sessions.data?.serverUrl ?? ""}`}
        now={now}
        revoke={dialog(revoke)}
        revoked={revoked}
        onRevoke={async (sessionId) => {
          try {
            await revoke.mutateAsync({ sessionId: cliSessionIdSchema.parse(sessionId) });
            setRevoked(true);
            return true;
          } catch {
            return false;
          }
        }}
        onRevokeReset={() => { revoke.reset(); setRevoked(false); }}
      />
    </PageFrame>
  );
};
