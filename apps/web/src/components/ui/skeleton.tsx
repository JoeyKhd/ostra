import { cn } from "@/lib/cn";

/** shadcn/ui's skeleton, graphite: a `--surface` bar where a value will go. No spinner. */
export const Skeleton = ({ className }: { readonly className?: string }) => (
  <span aria-hidden className={cn("block h-3 animate-pulse rounded-sm bg-surface", className)} />
);

/** A hairline row of skeleton bars, while a section's rows load. */
export const SkeletonRows = ({ rows = 3, height = "h-[38px]", bars = ["w-[15px]", "w-[120px]", "w-[240px]"] }: { readonly rows?: number; readonly height?: string; readonly bars?: readonly string[] }) => (
  <ul className="rows" aria-busy>
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className={cn("flex items-center gap-3", height)}>
        {bars.map((bar, j) => (
          <Skeleton key={`${bar}-${String(j)}`} className={cn(bar, bar === "w-[15px]" && "h-[15px]")} />
        ))}
      </li>
    ))}
  </ul>
);
