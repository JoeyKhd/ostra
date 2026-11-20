import type { ThemePreference } from "@ostra/domain/theme";

import { cn } from "@/lib/cn";

// A schematic of the panel in one theme (account-appearance.md, "The preview"): a sidebar strip
// with three bars and the needs-you dot, a top bar, a title, a lede and three rows, drawn with the
// theme's own tokens (`data-theme` on its root), so it looks right whichever theme the page is in.
// No words: it's decoration, and the radio's label names the choice.

const Schematic = ({ scheme, className }: { readonly scheme: "dark" | "light"; readonly className?: string }) => {
  const strong = scheme === "dark" ? "bg-muted" : "bg-text";
  const soft = scheme === "dark" ? "bg-faint" : "bg-muted";
  return (
    <div data-theme={scheme} className={cn("absolute inset-0 flex bg-bg", className)}>
      <div className="flex w-[64px] shrink-0 flex-col gap-[9px] border-r border-line bg-side px-[9px] pt-[12px]">
        <span className="h-[6px] w-[38px] rounded-[3px] bg-line-2" />
        <span className={cn("h-[6px] w-[30px] rounded-[3px]", soft)} />
        <span className="flex items-center gap-[6px]">
          <span className={cn("h-[6px] w-[24px] rounded-[3px]", soft)} />
          <span className="size-[5px] rounded-full bg-amber shadow-(--dot-amber)" />
        </span>
        <span className={cn("h-[6px] w-[34px] rounded-[3px]", soft)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="h-[18px] border-b border-line" />
        <div className="px-[12px] pt-[12px]">
          <span className={cn("block h-[7px] w-[58%] rounded-[3px]", strong)} />
          <span className={cn("mt-[7px] block h-[5px] w-[82%] rounded-[3px]", soft)} />
          <div className="mt-[14px]">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-[18px] items-center border-t border-line last:border-b">
                <span className={cn("h-[5px] rounded-[3px]", soft, row === 1 ? "w-[46%]" : "w-[62%]")} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/** The 236 × 148px preview of one choice; "match my system" is both, split corner to corner. */
export const ThemePreview = ({ theme }: { readonly theme: ThemePreference }) => {
  switch (theme) {
    case "dark":
    case "light":
      return <Schematic scheme={theme} />;
    case "system":
      return (
        <>
          <Schematic scheme="dark" />
          <Schematic scheme="light" className="[clip-path:polygon(100%_0,100%_100%,0_100%)]" />
        </>
      );
    default:
      return theme satisfies never;
  }
};
