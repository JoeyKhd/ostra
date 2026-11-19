import { initials } from "@/components/shell/user-menu";
import { cn } from "@/lib/cn";

/** A member as a 22px circle with their initials (graphite.css `.av`); the name is its label. */
export const Avatar = ({ name, className }: { readonly name: string; readonly className?: string }) => (
  <span
    role="img"
    aria-label={name}
    title={name}
    className={cn("inline-grid size-[22px] shrink-0 place-items-center rounded-full bg-line-2 text-[10px] font-semibold text-text", className)}
  >
    {initials(name)}
  </span>
);
