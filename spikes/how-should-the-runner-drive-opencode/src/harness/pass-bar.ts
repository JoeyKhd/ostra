// The pass bar's own bullets (context/build-order.md, spike 1), built from
// the case results. B3 and B4 come straight from their case; B1, B2 and B5
// are assembled here.

import { access } from "node:fs/promises";
import os from "node:os";
import { pass, skip, statusOf, type Check, type Criterion, type Status } from "./report.ts";

export const T_CASES = ["T1", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T13", "T14", "T16"] as const;

const byId = (results: readonly Criterion[], id: string): Criterion | undefined => results.find((r) => r.id === id);

const fromStatus = (name: string, status: Status, note: string): Check => ({ name, status, note });

const inContainer = async (): Promise<boolean> => {
  try {
    await access("/.dockerenv");
    return true;
  } catch {
    return process.env["container"] !== undefined || process.env["OSTRA_SPIKE_CONTAINER"] === "1";
  }
};

type Platform =
  | { readonly kind: "windows-11"; readonly release: string }
  | { readonly kind: "windows-other"; readonly release: string }
  | { readonly kind: "macos"; readonly release: string }
  | { readonly kind: "linux-container"; readonly release: string }
  | { readonly kind: "linux-host"; readonly release: string }
  | { readonly kind: "other"; readonly release: string };

/** Windows 11 is Windows NT 10.0 with build 22000 or later. */
const windowsBuild = (release: string): number => Number(release.split(".")[2] ?? "0");

export const platformOf = async (): Promise<Platform> => {
  const release = os.release();
  if (process.platform === "win32") return { kind: windowsBuild(release) >= 22000 ? "windows-11" : "windows-other", release };
  if (process.platform === "darwin") return { kind: "macos", release };
  if (process.platform === "linux") return { kind: (await inContainer()) ? "linux-container" : "linux-host", release };
  return { kind: "other", release };
};

export const passBar = async (results: readonly Criterion[]): Promise<Criterion[]> => {
  const here = await platformOf();

  // B1: every listed T-case, on each of the three platforms.
  const caseChecks: Check[] = T_CASES.map((id) => {
    const r = byId(results, id);
    if (r === undefined) return skip(`${id} on this machine`, "not run in this invocation (--only)");
    const status = statusOf(r.checks);
    const failed = r.checks.filter((c) => c.status === "FAIL").map((c) => c.name);
    const skipped = r.checks.filter((c) => c.status === "SKIPPED").map((c) => `${c.name} (${c.note})`);
    const note =
      status === "PASS"
        ? `${String(r.checks.length)} checks passed`
        : status === "FAIL"
          ? `failed: ${failed.join("; ")}`
          : `skipped: ${skipped.join("; ")}`;
    return fromStatus(`${id} on this machine`, status, note);
  });
  const hereStatus = statusOf(caseChecks);
  const machine = `this machine: ${here.kind}, release ${here.release}`;
  const platforms: Check[] = [
    here.kind === "linux-container"
      ? fromStatus("on Linux in a container (this machine)", hereStatus, `see the T-case lines (${machine})`)
      : skip("on Linux in a container", "a Linux container: `container/run.sh` (Docker with NET_ADMIN and NET_RAW)"),
    here.kind === "windows-11"
      ? fromStatus("on Windows 11 without WSL (this machine)", hereStatus, `see the T-case lines (${machine}; the harness runs natively, not under WSL)`)
      : skip("on Windows 11 without WSL", `a Windows 11 machine without WSL (${machine})`),
    here.kind === "macos" ? fromStatus("on macOS (this machine)", hereStatus, `see the T-case lines (${machine})`) : skip("on macOS", "a macOS machine: `pnpm spike` there"),
  ];

  // B2: the long turn, the question round trip, the cancel.
  const t4 = byId(results, "T4");
  const t8 = byId(results, "T8");
  const t9 = byId(results, "T9");
  const t14 = byId(results, "T14");
  const pick = (r: Criterion | undefined, includes: string, name: string): Check => {
    const c = r?.checks.find((x) => x.name.includes(includes));
    return c === undefined ? skip(name, "its case did not run in this invocation") : { ...c, name };
  };
  const b2: Check[] = [
    pick(t4, "1,200 s tool step", "a 20-minute turn ends cleanly (a 20-minute tool step)"),
    pick(t4, "model call streams for >= 20 min", "a 20-minute turn ends cleanly (a 20-minute model call, through the key proxy)"),
    pick(t8, "arrives as elicitation/create", "a question reaches the driver"),
    pick(t8, "answer reaches the model", "its answer reaches the model"),
    pick(t9, "within 5 s", "a cancel returns within 5 s"),
    pick(t9, "no process of the cancelled turn is left", "and leaves no process behind (a foreground tool)"),
    pick(t14, "no marked process survives any cancel", "and leaves no process behind (a background tool, 10 cancels)"),
  ];

  // B5: recorded numbers.
  const b3 = byId(results, "B3");
  const t5 = byId(results, "T5");
  const steer = byId(results, "STEER");
  const realRate = b3?.recorded?.["events per minute (model.env endpoint)"];
  const stubRate = t5?.recorded?.["events per minute (stub, scripted)"];
  const b5: Check[] = [
    realRate !== undefined
      ? pass("recorded: events per minute", `${String(realRate)} events/min on the model.env endpoint (stub, scripted: ${String(stubRate ?? "n/a")})`)
      : skip("recorded: events per minute", `a real model (OSTRA_DEV_MODEL_*); the scripted stub rate is ${String(stubRate ?? "n/a")} events/min, which says nothing about a real model's pace`),
    pick(steer, "HTTP API can steer", "recorded: whether OpenCode's own HTTP API can steer mid-turn"),
  ];

  return [
    { id: "B1", title: "Cases T1, T3–T11, T13, T14 and T16 of research/rivet.md pass on Linux in a container, on Windows 11 without WSL, and on macOS.", checks: [...caseChecks, ...platforms] },
    { id: "B2", title: "A 20-minute turn ends cleanly. A question reaches the driver, and its answer reaches the model. A cancel returns within 5 s and leaves no process behind.", checks: b2 },
    ...(b3 === undefined ? [] : [b3]),
    ...results.filter((r) => r.id === "B4"),
    { id: "B5", title: "Recorded: events per minute, and whether OpenCode's own HTTP API can steer mid-turn.", checks: b5 },
  ];
};
