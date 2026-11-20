"use client";

import { useQuery } from "@tanstack/react-query";
import { CirclePauseIcon } from "lucide-react";
import Link from "next/link";

import { projectColour } from "@/components/shell/project-colour";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// Home's needs-you rows for a rule its hourly limit paused (automations.md, "Paused by the limit"):
// shown to the project's admins, with "Review" opening the list with the rule selected. Resuming
// the rule clears its row.

export type PausedRule = RouterOutputs["automations"]["pausedByLimit"][number];

export const usePausedRules = () => {
  const trpc = useTRPC();
  return useQuery({ ...trpc.automations.pausedByLimit.queryOptions(), refetchInterval: 30_000 });
};

export const PausedRuleRows = ({ rules }: { readonly rules: readonly PausedRule[] }) =>
  rules.length === 0 ? null : (
    <ul className="rows" data-testid="paused-rules">
      {rules.map((rule) => (
        <li key={rule.id} className="flex min-h-[38px] items-center gap-2.5 border-b border-line py-1.5" data-testid="paused-rule">
          <CirclePauseIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-amber" />
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(rule.projectId) }} />
          <span className="min-w-0 flex-1 truncate text-text">{t("automations.home.paused", { rule: rule.name, n: rule.startsPerHour })}</span>
          <Link href={`/projects/${rule.projectId}/automations?automation=${rule.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 shrink-0 text-ui font-normal")}>
            {t("automations.home.review")}
          </Link>
        </li>
      ))}
    </ul>
  );
