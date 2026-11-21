import { ServerOffIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-076 (2026-11-21, the maintainer's "all yes"): once setup is done, Home's checklist never comes
// back. While no runner is online after that, Home says so at the top instead, quietly: the panel's
// info line (an icon and `--muted` words, no box, not amber: nothing waits on the reader yet), with
// the way to Runners for admins.

type SetupStatus = RouterOutputs["setup"]["status"];

/** What the top of Home shows for setup: the checklist on a first run, the notice, or nothing. */
export type HomeSetupView = "loading" | "checklist" | "no-runner" | "done";

export const homeSetupView = (status: SetupStatus | undefined): HomeSetupView => {
  if (status === undefined) return "loading";
  if (!status.complete) return "checklist";
  return status.runnerOnline ? "done" : "no-runner";
};

export const NoRunnerNotice = ({ admin }: { readonly admin: boolean }) => (
  <p role="status" data-testid="no-runner-notice" className="mt-3 flex max-w-[720px] flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-muted">
    <ServerOffIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0">{t("home.noRunner.text")}</span>
    {admin ? (
      <Link href="/organization/runners" className="font-medium text-teal hover:underline">
        {t("home.noRunner.action")}
      </Link>
    ) : null}
  </p>
);
