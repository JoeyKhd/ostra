import { z } from "zod";

import type { BoxSizeName } from "@ostra/protocol";

import { shortDate } from "@/components/members/member-words";
import { plural, t } from "@/lib/messages";

// F-095 (box-sizes.md): reading and checking the Box sizes page's values. vCPU in steps of 0.5 and
// whole GiB, within the bounds the API sends (ticket 27's working values).

export type Limits = { readonly cpuMillis: number; readonly memoryMiB: number };
export type Bounds = { readonly min: Limits; readonly max: Limits };

/** `2`, `0.5`, `1.5`: vCPU from millicores, at most two decimals. */
export const cpuText = (millis: number): string => String(Math.round(millis / 10) / 100);

/** `4`, `1.5`: GiB from MiB, at most two decimals. */
export const gibText = (mib: number): string => String(Math.round((mib / 1024) * 100) / 100);

/** Millicores from what an admin typed, or `null` when it isn't a multiple of 0.5 within the bounds. */
export const parseCpu = (text: string, bounds: Bounds): number | null => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const halves = Number(trimmed) * 2;
  if (!Number.isInteger(halves)) return null;
  const millis = halves * 500;
  return millis >= bounds.min.cpuMillis && millis <= bounds.max.cpuMillis ? millis : null;
};

/** MiB from what an admin typed, or `null` when it isn't a whole number of GiB within the bounds. */
export const parseMemory = (text: string, bounds: Bounds): number | null => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const mib = Number(trimmed) * 1024;
  return mib >= bounds.min.memoryMiB && mib <= bounds.max.memoryMiB ? mib : null;
};

/** The validation lines under the table, one per invalid input. */
export const invalidLines = (name: BoxSizeName, cpu: number | null, memory: number | null, bounds: Bounds): readonly string[] => [
  ...(cpu === null ? [t("boxSizes.cpuInvalid", { size: name, min: cpuText(bounds.min.cpuMillis), max: cpuText(bounds.max.cpuMillis) })] : []),
  ...(memory === null ? [t("boxSizes.memoryInvalid", { size: name, min: gibText(bounds.min.memoryMiB), max: gibText(bounds.max.memoryMiB) })] : []),
];

export type Offer = { readonly value: number; readonly runnerName: string } | null;

/**
 * The room warning (box-sizes.md, "The room warning"): a size no online runner that enforces sizes
 * can hold. Memory first, as the picture; `null` when every runner's offer holds it.
 */
export const roomWarning = (name: BoxSizeName, limits: Limits, largest: { readonly cpuMillis: Offer; readonly memoryMiB: Offer }, projects: number): string | null => {
  const tooMuchMemory = largest.memoryMiB === null || limits.memoryMiB > largest.memoryMiB.value;
  const tooMuchCpu = largest.cpuMillis === null || limits.cpuMillis > largest.cpuMillis.value;
  if (!tooMuchMemory && !tooMuchCpu) return null;
  const first = tooMuchMemory
    ? largest.memoryMiB === null
      ? t("boxSizes.tooBigNone", { value: `${gibText(limits.memoryMiB)} GiB` })
      : t("boxSizes.tooBigMemory", { value: gibText(limits.memoryMiB), most: gibText(largest.memoryMiB.value), runner: largest.memoryMiB.runnerName })
    : largest.cpuMillis === null
      ? t("boxSizes.tooBigNone", { value: `${cpuText(limits.cpuMillis)} vCPU` })
      : t("boxSizes.tooBigCpu", { value: cpuText(limits.cpuMillis), most: cpuText(largest.cpuMillis.value), runner: largest.cpuMillis.runnerName });
  const then = projects === 0 ? t("boxSizes.tooBigWait", { size: name }) : plural(projects, "boxSizes.tooBigProjects.one", "boxSizes.tooBigProjects.other", { size: name });
  return `${first} ${then}`;
};

/** `2 host runners, and build-03, which is one minor behind.` (the panel's Runners line). */
export const slotsOnlyLine = (runners: { readonly enforce: number; readonly slotsOnly: number; readonly host: number; readonly behind: readonly { readonly name: string }[] }): string => {
  if (runners.enforce + runners.slotsOnly === 0) return t("boxSizes.noRunner");
  if (runners.enforce === 0) return t("boxSizes.noRunnerEnforces");
  if (runners.behind.length === 0) return plural(runners.host, "boxSizes.slotsOnlyHost.one", "boxSizes.slotsOnlyHost.other");
  return `${behindLead(runners.host)}${runners.behind.map((runner) => runner.name).join(", ")}${behindTail(runners.behind.length)}`;
};

/** `2 host runners, and ` before the names of the runners behind, or nothing without a `host` runner. */
export const behindLead = (hosts: number): string => (hosts === 0 ? "" : `${plural(hosts, "boxSizes.hostRunners.one", "boxSizes.hostRunners.other")}${t("boxSizes.and")}`);

/** `, which is one minor behind.` after the names. */
export const behindTail = (count: number): string => (count === 1 ? t("boxSizes.behindOne") : t("boxSizes.behindMany"));

const boxSizeUpdatedSchema = z.object({ size: z.string(), cpuMillis: z.number(), memoryMiB: z.number() });

/** `Large set to 8 vCPU · 16 GiB by Alex Kim, 12 Nov`, from the newest `box-size.updated` entry. */
export const lastChangeLine = (entry: { readonly at: number; readonly actor: { readonly name: string | null }; readonly data?: unknown } | undefined): string => {
  const data = boxSizeUpdatedSchema.safeParse(entry?.data);
  if (entry === undefined || !data.success) return t("boxSizes.neverChanged");
  const size = data.data.size.charAt(0).toUpperCase() + data.data.size.slice(1);
  return t("boxSizes.lastChangeLine", { size, cpu: cpuText(data.data.cpuMillis), memory: gibText(data.data.memoryMiB), name: entry.actor.name ?? "ostra", date: shortDate(entry.at) });
};
