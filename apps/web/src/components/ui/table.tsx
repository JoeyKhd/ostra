import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

// shadcn/ui's table, restyled to graphite (graphite.css `table.t`): no box, hairlines between rows,
// a 30px head in 500 11.5px `--faint`, numbers right-aligned in tabular Plex Mono (`TableCell num`).

export const Table = ({ className, ...props }: ComponentProps<"table">) => (
  <table className={cn("w-full table-fixed border-collapse text-body", className)} {...props} />
);

export const TableHeader = ({ className, ...props }: ComponentProps<"thead">) => <thead className={cn(className)} {...props} />;

export const TableBody = ({ className, ...props }: ComponentProps<"tbody">) => <tbody className={cn(className)} {...props} />;

export const TableRow = ({ className, ...props }: ComponentProps<"tr">) => (
  <tr className={cn("border-b border-line", className)} {...props} />
);

export const TableHead = ({ className, num = false, ...props }: ComponentProps<"th"> & { readonly num?: boolean }) => (
  <th
    className={cn("h-[30px] px-0 text-left align-middle text-[11.5px] font-medium text-faint", num && "text-right", className)}
    {...props}
  />
);

export const TableCell = ({ className, num = false, ...props }: ComponentProps<"td"> & { readonly num?: boolean }) => (
  <td
    className={cn("h-[38px] px-0 align-middle", num && "text-right font-mono text-[12.5px] tabular-nums", className)}
    {...props}
  />
);
