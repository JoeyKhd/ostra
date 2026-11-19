"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type NavLinkProps = {
  readonly href: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly end?: ReactNode;
  /** Match only this exact path (Home), not its children. */
  readonly exact?: boolean;
  /** Other pages that belong to this row's page and select it too: `/device` for Runners. */
  readonly also?: readonly string[];
  readonly sub?: boolean;
  readonly onNavigate?: () => void;
};

/** A sidebar row, 28px (the approved pictures' scale): the current page is the selected row. */
export const NavLink = ({ href, icon, children, end, exact = false, also = [], sub = false, onNavigate }: NavLinkProps) => {
  const pathname = usePathname();
  const active = (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)) || also.includes(pathname);
  return (
    <Link
      href={href}
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 items-center gap-2.5 whitespace-nowrap rounded-sm px-2 font-medium text-text-2 hover:text-text [&_svg]:size-4 [&_svg]:stroke-[1.75]",
        sub && "h-[27px] pl-[30px]",
        active && "bg-sel text-text",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {end === undefined ? null : <span className="ml-auto">{end}</span>}
    </Link>
  );
};
