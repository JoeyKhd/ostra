"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import type { ComponentProps } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

/** A password input with a show toggle inside its right end (accept-invite.md, field 3). */
export const PasswordInput = ({ className, ...props }: Omit<ComponentProps<"input">, "type">) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? "text" : "password"} className={cn("h-[36px] pl-[10px] pr-[36px]", className)} />
      <button
        type="button"
        aria-label={shown ? t("acceptInvite.hide") : t("acceptInvite.show")}
        aria-pressed={shown}
        onClick={() => { setShown((value) => !value); }}
        className="absolute right-[6px] top-1/2 grid size-[24px] -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-muted"
      >
        {shown ? <EyeOffIcon className="size-[15px]" strokeWidth={1.75} aria-hidden /> : <EyeIcon className="size-[15px]" strokeWidth={1.75} aria-hidden />}
      </button>
    </div>
  );
};
