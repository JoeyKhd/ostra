import type { SavedData, SystemEvent } from "@ostra/task-view";

import { t } from "@/lib/messages";

// The words of the thread's milestone 2 markers (task-reopen.md, "Markers in the thread"): sizes in
// SI with one decimal, SHAs 7 characters, counts as plain integers.

/** `2.4 MB`, `812 kB`, `120 B`. */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${String(Math.round(bytes / 1_000))} kB`;
  return `${String(bytes)} B`;
};

/** `archive 2.4 MB · hidden ref 3be91f0`, or what wasn't saved. */
export const savedDetail = (data: SavedData): string => {
  const archive = data.archiveBytes === null ? t("task.savedNoArchive") : t("task.savedArchive", { size: formatSize(data.archiveBytes) });
  const [first] = data.hiddenRefs;
  const refs =
    data.hiddenRefs.length > 1 ? t("task.savedRefs", { n: data.hiddenRefs.length }) : first === undefined ? t("task.savedNoRef") : t("task.savedRef", { sha: first.slice(0, 7) });
  return `${archive} · ${refs}`;
};

type Restored = Extract<SystemEvent, { readonly kind: "session.restored" }>;

/** What a restore says after its title: the box, the replayed updates, the unfinished work. */
export const restoredDetail = (event: Restored): string => {
  const parts: string[] = [];
  if (event.previousBox === "released") parts.push(t("task.system.previousReleased"));
  if (event.previousBox === "lost") parts.push(t("task.system.previousLost"));
  if (event.origin === "restored" && event.replayedUpdates !== undefined) parts.push(t("task.system.replayed", { n: event.replayedUpdates }));
  if (event.hiddenRef === "applied") parts.push(t("task.system.workRestored"));
  if (event.hiddenRef === "conflict") parts.push(t("task.system.workConflict"));
  return parts.join(" · ");
};
