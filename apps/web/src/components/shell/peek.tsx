"use client";

import { useEffect } from "react";

import { SpacePanel } from "./context-panel";
import { useShellState } from "./shell-state";

/**
 * The peek (app-shell.md, "The peek"; `shell-peek.webp`): while the panel is collapsed, the space the
 * mouse rests on shows its panel over the page: 240 wide, 8px from the top and the bottom, 6px right
 * of the rail, on `--raise` with a `--line-2` edge, a 10px radius and `--shadow-pop`. Escape closes it.
 */
export const Peek = () => {
  const shell = useShellState();
  const space = shell.peek;
  const control = shell.peekControl;
  useEffect(() => {
    if (space === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") control.close();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [space, control]);
  if (space === null) return null;
  return (
    <div
      data-shell-peek={space}
      onPointerEnter={control.hold}
      onPointerLeave={control.leave}
      className="fixed bottom-2 left-[70px] top-2 z-40 w-60 overflow-hidden rounded-[10px] border border-line-2 bg-raise shadow-(--shadow-pop)"
    >
      <SpacePanel space={space} mode="peek" onNavigate={control.close} />
    </div>
  );
};

/**
 * From 768 to 1023px the rail stands alone, and docking the panel lays it over the page, like a
 * pinned peek, with a scrim that closes it (app-shell.md, "Collapsing, the peek and narrow widths").
 */
export const RailOverlay = () => {
  const shell = useShellState();
  const open = shell.band === "rail" && shell.opened;
  const { hide } = shell;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [open, hide]);
  if (!open) return null;
  return (
    <>
      <div aria-hidden onClick={hide} className="fixed inset-y-0 left-16 right-0 z-30 bg-(--scrim)" />
      <div className="fixed inset-y-0 left-16 z-40 border-r border-line bg-bg" style={{ width: shell.choice.width }}>
        <SpacePanel space={shell.space} mode="overlay" onNavigate={hide} />
      </div>
    </>
  );
};
