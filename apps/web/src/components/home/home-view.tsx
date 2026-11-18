"use client";

import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import Link from "next/link";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { SetupChecklist } from "./setup-checklist";

const today = (): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

/** The organization's Home: the checklist while setup isn't done, then its projects. */
export const HomeView = () => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const organization = me.data?.organization;
  const admin = organization?.role === "admin";

  return (
    <PageFrame
      crumbs={[{ label: organization?.name ?? "" }, { label: t("home.title") }]}
      actions={
        <Link href="/tasks/new" className={buttonVariants()}>
          <PlusIcon /> {t("shell.newTask")}
        </Link>
      }
    >
      <PageHeading eyebrow={<span suppressHydrationWarning>{today()}</span>} title={organization?.name ?? t("home.title")} lede={t("home.lede")} />
      <SetupChecklist admin={admin} />
    </PageFrame>
  );
};
