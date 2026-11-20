import { z } from "zod";

import { t } from "@/lib/messages";

// F-086, F-095, F-069 (project-runners.md): a project's pools in order, each share, and the
// keyboard reorder's steps. Pure, so the view and its tests share them.

/** The most a share may be without a pool cap (project-runners.md, "Share"). */
export const SHARE_MAX_UNCAPPED = 999;

/** A share from what was typed: `null` for empty (no cap), a whole number in range, or `"invalid"`. */
export const parseShare = (text: string, poolMaxBoxes: number | null): number | null | "invalid" => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  return value >= 1 && value <= (poolMaxBoxes ?? SHARE_MAX_UNCAPPED) ? value : "invalid";
};

/** The list with the item at `from` moved to `to`, both clamped to the list. */
export const moveItem = <T,>(list: readonly T[], from: number, to: number): readonly T[] => {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(target, 0, item);
  return next;
};

/** `2 vCPU · 4 GB`: whole numbers or one decimal. */
export const sizeValue = (cpuMillis: number, memoryMiB: number): string =>
  t("projectRunners.sizeValue", { cpu: String(Math.round(cpuMillis / 100) / 10), memory: String(Math.round((memoryMiB / 1024) * 10) / 10) });

const defaultSizeSchema = z.object({ defaultBoxSize: z.string().nullable() });

/** The panel's Last change: the newer of the two entries, as one sentence. */
export const lastChangeOf = (
  project: string,
  pools: { readonly at: number; readonly actor: { readonly name: string | null } } | undefined,
  size: { readonly at: number; readonly actor: { readonly name: string | null }; readonly data?: unknown } | undefined,
): { readonly line: string; readonly at: number } | null => {
  const newest = pools !== undefined && (size === undefined || pools.at >= size.at) ? ({ kind: "pools", entry: pools } as const) : size === undefined ? null : ({ kind: "size", entry: size } as const);
  if (newest === null) return null;
  const name = newest.entry.actor.name ?? "ostra";
  if (newest.kind === "pools") return { line: t("projectRunners.changedPools", { name, project }), at: newest.entry.at };
  const data = defaultSizeSchema.safeParse(newest.entry.data);
  return { line: t("projectRunners.changedSize", { name, size: data.success ? (data.data.defaultBoxSize ?? "–") : "–" }), at: newest.entry.at };
};
