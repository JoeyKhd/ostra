import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

/** The form's one error line, under its last field (sign-in.md, States): an icon and a sentence. */
export const FormMessage = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => (
  <p id={id} role="alert" className="mt-[4px] flex items-center gap-[6px] text-[12.5px] leading-[18px] text-red">
    <CircleAlertIcon className="size-[13px]" strokeWidth={1.75} aria-hidden />
    {children}
  </p>
);
