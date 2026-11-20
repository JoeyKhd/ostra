import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

/**
 * How a numbered step looks: done (a filled `--green` circle with an `--on-primary` check: ink in dark, white in light), the current
 * step (a 1px `--text` ring), a later one (a 1px `--line-2` ring, `--muted` number) or skipped (a
 * dashed `--line-2` ring with a `--faint` dash).
 */
export type StepLook = "done" | "current" | "later" | "skipped";

const look: Readonly<Record<StepLook, string>> = {
  done: "border-green bg-green text-on-primary",
  current: "border-text text-text",
  later: "border-line-2 text-muted",
  skipped: "border-dashed border-line-2 text-faint",
};

/** The 22px step circle, shared by Home's checklist and the Linear page's three steps. */
export const StepTick = ({ state, n }: { readonly state: StepLook; readonly n: number }) => (
  <span
    data-tick={state}
    className={cn("inline-grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-xs", look[state])}
  >
    {state === "done" ? (
      <CheckIcon className="size-[13px] stroke-[2.25]" aria-label={t("checklist.done")} />
    ) : state === "skipped" ? (
      <span aria-label={t("checklist.skippedStep")}>–</span>
    ) : (
      n
    )}
  </span>
);
