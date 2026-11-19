import { CheckIcon, CircleAlertIcon } from "lucide-react";

import { cn } from "@/lib/cn";

import { ruleText } from "./new-password";
import type { RuleLine as Rule } from "./new-password";

/** The password policy's line under a new password: plain, met (a green check), or its error. */
export const RuleLine = ({ id, rule }: { readonly id: string; readonly rule: Rule }) => (
  <p id={id} className={cn("mt-[4px] flex items-center gap-[6px] text-[12px] leading-[18px]", rule.tone === "error" ? "text-red" : "text-faint")}>
    <span className="flex size-[13px] shrink-0 items-center justify-center" aria-hidden>
      {rule.tone === "met" ? <CheckIcon className="size-[13px] text-green" strokeWidth={1.75} /> : null}
      {rule.tone === "error" ? <CircleAlertIcon className="size-[13px]" strokeWidth={1.75} /> : null}
    </span>
    {ruleText(rule.rule)}
  </p>
);
