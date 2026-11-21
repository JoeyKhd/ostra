"use client";

import { PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { DensityProvider, useDensity } from "./nav-link";
import { HomePanel } from "./panels/home";
import { NeedsYouPanel } from "./panels/needs-you";
import { OrganizationPanel } from "./panels/organization";
import { ProjectPanel } from "./panels/project";
import { ProjectsPanel } from "./panels/projects";
import { SettingsPanel } from "./panels/settings";
import type { Space } from "./places";
import { rovingKeyDown } from "./roving";
import { useShellState } from "./shell-state";
import { PANEL_WIDTH } from "./sidebar-state";

/**
 * Where a panel is drawn, which decides its head's last button:
 * - `docked`: beside the rail; `panel-left-close` hides it;
 * - `peek`: floating over the page while the panel is collapsed; `panel-left-open` keeps it open;
 * - `overlay`: docked from 768 to 1023px, over the page; `panel-left-close` hides it;
 * - `sheet`: in the phone's menu sheet; `x` closes the sheet.
 */
export type PanelMode = "docked" | "peek" | "overlay" | "sheet";

/** A 28px icon button of the panel's head (44px in the sheet), with its words as its name and its title. */
export const HeadButton = ({ label, onClick, children, sheet = false }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode; readonly sheet?: boolean }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className={cn("grid shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-text", sheet ? "size-11 [&_svg]:size-[19px]" : "size-7 [&_svg]:size-4", "[&_svg]:stroke-[1.75]")}
  >
    {children}
  </button>
);

export type PanelFrameProps = {
  readonly mode: PanelMode;
  /** The landmark's name: the place's own (`Acme Corp`, a project, `Organization`). */
  readonly label: string;
  /** The head's title, or the project switcher. */
  readonly title: ReactNode;
  /** The head's other buttons, before its last one (a project's `plus`). Never in the sheet. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

/** The last button of the head, by where the panel is drawn. */
const LastButton = ({ mode }: { readonly mode: PanelMode }) => {
  const shell = useShellState();
  switch (mode) {
    case "docked":
    case "overlay":
      return (
        <HeadButton label={t("shell.panel.hide")} onClick={shell.hide}>
          <PanelLeftCloseIcon aria-hidden />
        </HeadButton>
      );
    case "peek":
      return (
        <HeadButton label={t("shell.panel.keepOpen")} onClick={shell.dock}>
          <PanelLeftOpenIcon aria-hidden />
        </HeadButton>
      );
    case "sheet":
      return (
        <Dialog.Close aria-label={t("shell.panel.closeNavigation")} title={t("shell.panel.closeNavigation")} className="grid size-11 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text">
          <XIcon aria-hidden className="size-[19px] stroke-[1.75]" />
        </Dialog.Close>
      );
    default:
      return mode satisfies never;
  }
};

/**
 * One space's panel (app-shell.md, "The panel"): a `nav` landmark on `--bg`, its 46px head (the
 * title, then its buttons), and a body that scrolls on its own. ↑ and ↓ move between its rows.
 */
export const PanelFrame = ({ mode, label, title, actions, children }: PanelFrameProps) => {
  const sheet = mode === "sheet";
  return (
    <DensityProvider value={sheet ? "sheet" : "desktop"}>
      <nav aria-label={label} data-shell-panel={mode} className="flex h-full min-h-0 flex-col">
        <div className={cn("flex shrink-0 items-center gap-2", sheet ? "h-[54px] pl-3.5 pr-1" : "h-[46px] pl-4 pr-2")}>
          <div className="flex min-w-0 flex-1 items-center">{title}</div>
          <div className="flex shrink-0 items-center gap-0.5">
            {sheet ? null : actions}
            <LastButton mode={mode} />
          </div>
        </div>
        <div
          className="panel-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-0.5"
          onKeyDownCapture={rovingKeyDown(false)}
        >
          {children}
        </div>
      </nav>
    </DensityProvider>
  );
};

/** The head's title: Plex Sans 600 15px `--text` (16px in the sheet). */
export const PanelTitle = ({ children }: { readonly children: string }) => {
  const density = useDensity();
  // Not a heading: the landmark already names the place, and the page's own title is its first heading.
  return <div className={cn("min-w-0 truncate font-semibold leading-[1.2] text-text", density === "sheet" ? "text-base" : "text-[15px]")}>{children}</div>;
};

/** The open space's panel, or the peeked one's. */
export const SpacePanel = ({ space, mode, onNavigate }: { readonly space: Space; readonly mode: PanelMode; readonly onNavigate?: () => void }) => {
  const shell = useShellState();
  const navigate = onNavigate ?? (() => undefined);
  switch (space) {
    case "home":
      return <HomePanel mode={mode} onNavigate={navigate} />;
    case "needs-you":
      return <NeedsYouPanel mode={mode} onNavigate={navigate} />;
    case "projects":
      return shell.projectId === null ? <ProjectsPanel mode={mode} onNavigate={navigate} /> : <ProjectPanel key={shell.projectId} projectId={shell.projectId} mode={mode} onNavigate={navigate} />;
    case "organization":
      return <OrganizationPanel mode={mode} onNavigate={navigate} />;
    case "settings":
      return <SettingsPanel mode={mode} onNavigate={navigate} />;
    default:
      return space satisfies never;
  }
};

/**
 * The drag handle on the docked panel's right edge (a 5px hit area): 200 to 320px, kept in the
 * cookie when the drag ends; a double-click puts it back to 240. Mouse only: `[` is the keyboard's.
 */
export const ResizeHandle = () => {
  const shell = useShellState();
  const start = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width: shell.choice.width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    shell.setWidth(start.current.width + event.clientX - start.current.x, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    shell.setWidth(start.current.width + event.clientX - start.current.x, true);
    start.current = null;
  };
  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { shell.setWidth(PANEL_WIDTH.initial, true); }}
      className="absolute inset-y-0 -right-[3px] z-10 w-[5px] cursor-col-resize"
    />
  );
};
