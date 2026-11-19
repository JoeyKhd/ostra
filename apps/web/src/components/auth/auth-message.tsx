import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The message block of the pages before the panel (accept-invite.md, reset-password.md): a 32px
 * tile with the state's icon, the title, the lede, then either one main action or a hairline and
 * help lines. It starts on the form's guide, so switching between the two moves nothing else.
 */
export const AuthMessage = ({
  icon: Icon,
  title,
  children,
  action,
  help,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly help?: ReactNode;
}) => (
  <div>
    <span aria-hidden className="grid size-8 place-items-center rounded-lg border border-line-2 bg-surface">
      <Icon className="size-4 text-muted" strokeWidth={1.75} />
    </span>
    <h1 className="page-title mt-[20px] text-text">{title}</h1>
    <div className="mt-[6px] text-lede text-muted">{children}</div>
    {action === undefined ? null : <div className="mt-[20px]">{action}</div>}
    {help === undefined ? null : <div className="mt-[28px] space-y-[8px] border-t border-line pt-[16px] text-[12.5px] leading-[18px] text-faint">{help}</div>}
  </div>
);

/** A status line beside `FormMessage`: `--muted`, for what went right or what to wait for. */
export const StatusLine = ({ children, icon }: { readonly children: ReactNode; readonly icon?: ReactNode }) => (
  <p role="status" className="flex items-center gap-[6px] text-[12.5px] leading-[18px] text-muted">
    {icon}
    {children}
  </p>
);
