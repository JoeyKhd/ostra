"use client";

import { useEffect, useRef, useState } from "react";

import { dragDepth, dragShowsZone, dropAttaches } from "./attach-words";

// The drop zone's state (composer-attachments.md, "Drop"): files dragged over the window from
// outside the page show it; it hides on drop, when the drag leaves the window, or on Escape. A drop
// anywhere on the page but the preview pane (`data-drop-excluded`) attaches; a folder is passed on
// as one, so the tray can say it can't take it. One per page.

/** The files of a drop, and which of them are folders (a browser hands a folder over as a file). */
export const droppedFiles = (data: DataTransfer): { readonly files: readonly File[]; readonly folders: ReadonlySet<File> } => {
  const files: File[] = [];
  const folders = new Set<File>();
  for (const item of [...data.items]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    files.push(file);
    if (item.webkitGetAsEntry()?.isDirectory === true) folders.add(file);
  }
  return files.length > 0 ? { files, folders } : { files: [...data.files], folders };
};

export const useDropZone = ({ enabled, onDrop }: {
  /** Whether the member may attach here: a viewer gets no drop zone. */
  readonly enabled: boolean;
  readonly onDrop: (files: readonly File[], folders: ReadonlySet<File>) => void;
}): boolean => {
  const [shown, setShown] = useState(false);
  const depth = useRef(0);
  const fromPage = useRef(false);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!enabled) return undefined;
    const types = (event: DragEvent): readonly string[] => [...(event.dataTransfer?.types ?? [])];
    const carries = (event: DragEvent) => dragShowsZone({ types: types(event), fromPage: fromPage.current });
    const hide = (how: "drop" | "end" | "escape") => {
      depth.current = dragDepth(depth.current, how);
      setShown(false);
    };
    const onDragStart = () => { fromPage.current = true; };
    const onDragEnd = () => {
      fromPage.current = false;
      hide("end");
    };
    const onEnter = (event: DragEvent) => {
      if (!carries(event)) return;
      depth.current = dragDepth(depth.current, "enter");
      setShown(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!carries(event)) return;
      depth.current = dragDepth(depth.current, "leave");
      if (depth.current === 0) setShown(false);
    };
    const onOver = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = dropAttaches(event.target instanceof Element ? event.target : null) ? "copy" : "none";
    };
    const onDropEvent = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      hide("drop");
      if (event.dataTransfer === null || !dropAttaches(event.target instanceof Element ? event.target : null)) return;
      const { files, folders } = droppedFiles(event.dataTransfer);
      if (files.length > 0) onDropRef.current(files, folders);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && depth.current > 0) {
        event.stopPropagation();
        hide("escape");
      }
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDropEvent);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDropEvent);
      window.removeEventListener("keydown", onKey, true);
      depth.current = 0;
      setShown(false);
    };
  }, [enabled]);

  return enabled && shown;
};
