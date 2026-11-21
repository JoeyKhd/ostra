import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { killTree } from "../cdp/pipe.ts";

// CPU and memory of the box's processes, from sampler.ps1's JSON lines. CPU is reported in vCPUs (CPU
// seconds a second), so 2.0 is the whole of a small box. Memory is the sum of private bytes over a group's
// processes (closest to what a container's memory limit counts) and of working sets (which double-count
// shared pages).

const procSchema = z.looseObject({ id: z.number(), cpu: z.number(), ws: z.number(), priv: z.number() });
const sampleSchema = z.looseObject({ t: z.number(), groups: z.record(z.string(), z.union([z.array(procSchema), procSchema, z.null()])) });
type Proc = z.infer<typeof procSchema>;
type Sample = { readonly t: number; readonly groups: Record<string, readonly Proc[]> };

export type GroupUse = { readonly vcpu: number; readonly privMaxMB: number; readonly wsMaxMB: number; readonly procsMax: number };

export const startSampler = (groups: Record<string, string>) => {
  const spec = Object.entries(groups)
    .map(([name, pids]) => `${name}=${pids}`)
    .join(";");
  const script = fileURLToPath(new URL("./sampler.ps1", import.meta.url));
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Groups", spec], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples: Sample[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end === -1) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line.length === 0) continue;
      const parsed = sampleSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const normalised: Record<string, readonly Proc[]> = {};
      for (const [name, value] of Object.entries(parsed.data.groups)) normalised[name] = value === null ? [] : Array.isArray(value) ? value : [value];
      samples.push({ t: parsed.data.t, groups: normalised });
    }
  });
  child.stderr.resume();

  // The window is bracketed by the last sample at or before `from` and the first at or after `to`. A process
  // that started inside it counts all of its CPU time; one that ended inside it is missed (rare: a renderer
  // swapped on navigation).
  const use = (from: number, to: number): Record<string, GroupUse> => {
    const startIndex = Math.max(0, samples.findLastIndex((sample) => sample.t <= from));
    const foundEnd = samples.findIndex((sample) => sample.t >= to);
    const endIndex = foundEnd === -1 ? samples.length - 1 : foundEnd;
    const start = samples[startIndex];
    const end = samples[endIndex];
    const span = samples.slice(startIndex, endIndex + 1);
    const result: Record<string, GroupUse> = {};
    for (const name of Object.keys(groups)) {
      let cpu = 0;
      if (start !== undefined && end !== undefined && end !== start) {
        const before = new Map((start.groups[name] ?? []).map((proc) => [proc.id, proc.cpu]));
        for (const proc of end.groups[name] ?? []) cpu += Math.max(0, proc.cpu - (before.get(proc.id) ?? 0));
      }
      let privMax = 0;
      let wsMax = 0;
      let procsMax = 0;
      for (const sample of span) {
        const procs = sample.groups[name] ?? [];
        privMax = Math.max(privMax, procs.reduce((sum, proc) => sum + proc.priv, 0));
        wsMax = Math.max(wsMax, procs.reduce((sum, proc) => sum + proc.ws, 0));
        procsMax = Math.max(procsMax, procs.length);
      }
      const seconds = start !== undefined && end !== undefined ? (end.t - start.t) / 1000 : 0;
      result[name] = {
        vcpu: seconds > 0 ? Number((cpu / seconds).toFixed(3)) : 0,
        privMaxMB: Math.round(privMax / 1_048_576),
        wsMaxMB: Math.round(wsMax / 1_048_576),
        procsMax,
      };
    }
    return result;
  };

  const tickMs = () => {
    const gaps = samples.slice(1).map((sample, index) => sample.t - (samples[index]?.t ?? sample.t));
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? 0;
  };

  return {
    use,
    tickMs,
    latest: () => samples.at(-1)?.t ?? 0,
    count: () => samples.length,
    stop: async () => {
      if (child.pid !== undefined) await killTree(child.pid);
    },
  };
};
