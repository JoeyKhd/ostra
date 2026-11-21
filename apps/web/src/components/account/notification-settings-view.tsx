"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { trackerName } from "@/components/tasks/task-ticket";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { MailOffNotice, MomentsFoot, MomentsSection, MomentsTable, NotificationPanel } from "./notification-settings";
import { choicesOf, defaultGrid, sameGrid, savedGrid, withBox } from "./notification-words";
import type { ChoiceCell, Grid } from "./notification-words";

// Ticket 45 wired (notification-settings.md; F-036): the member's choices per moment and channel
// through `notifications.preferences.get` and `.save`. Changes wait for `Save choices` in the top bar,
// which turns on once the boxes differ from the saved choices; leaving with unsaved changes asks first.

export const NotificationSettingsView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const preferences = useQuery(trpc.notifications.preferences.get.queryOptions());
  const save = useMutation(trpc.notifications.preferences.save.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.notifications.preferences.get.queryKey() }) }));
  const [grid, setGrid] = useState<Grid | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const data = preferences.data;
  const cells: readonly ChoiceCell[] = (data?.choices ?? []).map((choice) => ({ kind: choice.kind, channel: choice.channel, enabled: choice.enabled, defaultEnabled: choice.default }));
  useEffect(() => {
    if (data !== undefined && grid === undefined) setGrid(savedGrid(data.choices.map((choice) => ({ kind: choice.kind, channel: choice.channel, enabled: choice.enabled, defaultEnabled: choice.default }))));
  }, [data, grid]);
  const store = (next: Grid) => {
    setGrid(next);
    setSaved(false);
    save.reset();
  };
  const defaults = defaultGrid(cells);
  const stored = savedGrid(cells);
  const dirty = grid !== undefined && data !== undefined && !sameGrid(grid, stored);
  // The browser's own "leave page?" while a change is unsaved (notification-settings.md, "Edited").
  useEffect(() => {
    if (!dirty) return undefined;
    const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", ask);
    return () => { window.removeEventListener("beforeunload", ask); };
  }, [dirty]);
  const submit = () => {
    if (grid === undefined || !dirty) return;
    save.mutate({ choices: [...choicesOf(grid)] }, { onSuccess: () => { setSaved(true); } });
  };
  return (
    <PageFrame
      crumbs={[{ label: t("shell.account"), href: "/account" }, { label: t("shell.notifications") }]}
      actions={
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={submit}>
          {save.isPending ? t("notificationSettings.saving") : t("notificationSettings.save")}
        </Button>
      }
      properties={
        <NotificationPanel
          email={data?.emailAddress ?? null}
          facts={data === undefined ? undefined : { mailOn: data.emailOn, tracker: data.tracker === null ? null : { name: trackerName(data.tracker.kind) }, delaySeconds: data.emailDelaySeconds, savedAt: data.lastSavedAt, instanceAdmin: data.isInstanceAdmin }}
        />
      }
    >
      <PageHeading title={t("shell.notifications")} lede={t("notificationSettings.lede")} />
      {data !== undefined && !data.emailOn ? <MailOffNotice instanceAdmin={data.isInstanceAdmin} /> : null}
      <MomentsSection>
        <MomentsTable
          grid={grid}
          mailOn={data?.emailOn ?? false}
          disabled={save.isPending}
          onChange={(kind, channel, on) => { if (grid !== undefined) store(withBox(grid, kind, channel, on)); }}
        />
      </MomentsSection>
      <MomentsFoot
        showReset={grid !== undefined && !sameGrid(grid, defaults)}
        onReset={() => { store(defaults); }}
        saved={saved}
        error={save.error === null ? null : errorText(save.error)}
      />
    </PageFrame>
  );
};
