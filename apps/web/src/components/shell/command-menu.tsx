"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BoxIcon,
  CornerDownLeftIcon,
  CpuIcon,
  GitPullRequestIcon,
  HouseIcon,
  ListChecksIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquarePenIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { destinations, matchDestinations } from "./destinations";
import type { Destination, DestinationIcon } from "./destinations";
import { projectColour } from "./project-colour";

const icons: Record<Exclude<DestinationIcon, "project">, ReactNode> = {
  home: <HouseIcon />,
  "new-task": <SquarePenIcon />,
  tasks: <ListChecksIcon />,
  environment: <BoxIcon />,
  "new-project": <PlusIcon />,
  runners: <ServerIcon />,
  models: <CpuIcon />,
  github: <GitPullRequestIcon />,
};

const DestinationMark = ({ destination }: { readonly destination: Destination }) =>
  destination.icon === "project" ? (
    <span aria-hidden className="mx-[3.5px] size-2 shrink-0 rounded-[2px]" style={{ background: destination.colour }} />
  ) : (
    icons[destination.icon]
  );

/**
 * Search ⌘K (the sidebar's search box): a dialog that jumps to any page the sidebar has. ⌘K or
 * Ctrl+K opens it from anywhere in the panel.
 */
export const CommandMenu = ({ open, onOpenChange, admin }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const listId = useId();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const all = useMemo(
    () => destinations((projects.data ?? []).map((project) => ({ id: project.id, name: project.name, colour: projectColour(project.id) })), admin),
    [projects.data, admin],
  );
  const found = matchDestinations(all, query);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const go = (destination: Destination) => {
    onOpenChange(false);
    router.push(destination.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (found.length === 0 ? 0 : (index + 1) % found.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (found.length === 0 ? 0 : (index - 1 + found.length) % found.length));
    } else if (event.key === "Enter") {
      const destination = found[active];
      if (destination !== undefined) {
        event.preventDefault();
        go(destination);
      }
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setQuery("");
        setActive(0);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-line-2 bg-raise shadow-[0_16px_48px_rgba(0,0,0,0.5)] focus:outline-none"
        >
          <Dialog.Title className="sr-only">{t("shell.search")}</Dialog.Title>
          <div className="flex h-11 items-center gap-2.5 border-b border-line px-3.5 text-faint">
            <SearchIcon aria-hidden className="size-[15px] stroke-[1.75]" />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t("shell.searchPlaceholder")}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={found[active] === undefined ? undefined : `${listId}-${String(active)}`}
              className="min-w-0 flex-1 bg-transparent text-body text-text placeholder:text-faint focus:outline-none"
            />
          </div>
          <ul id={listId} role="listbox" aria-label={t("shell.search")} className="max-h-[360px] overflow-y-auto p-1">
            {found.length === 0 ? (
              <li className="px-2.5 py-3 text-muted">{t("shell.searchEmpty")}</li>
            ) : (
              found.map((destination, index) => (
                <li
                  key={`${destination.href}-${destination.icon}`}
                  id={`${listId}-${String(index)}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    go(destination);
                  }}
                  className={cn(
                    "flex h-8 cursor-default items-center gap-[9px] rounded-sm px-2.5 text-text [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
                    index === active && "bg-sel",
                  )}
                >
                  <DestinationMark destination={destination} />
                  <span className="min-w-0 truncate">{destination.label}</span>
                  {destination.context === undefined ? null : <span className="min-w-0 truncate text-faint">{destination.context}</span>}
                  {index === active ? <CornerDownLeftIcon aria-hidden className="ml-auto !size-[13px] !text-faint" /> : null}
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
