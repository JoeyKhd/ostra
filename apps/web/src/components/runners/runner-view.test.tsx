import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { projectIdSchema, taskIdSchema } from "@ostra/protocol";

import { boxSizeText, boxTaskKey } from "./runner-page-words";
import { Boxes, Capacity } from "./runner-view";

// F-092 (ticket 31, runner.md "Capacity" and "Boxes"): a runner's room as bars of use against what
// it offers, and each box by its task's key, its size and its limits.

const now = Date.UTC(2026, 10, 19, 16, 16);
const project = { id: projectIdSchema.parse("01900000-0000-7000-8000-0000000000a1"), name: "calculator" };

const box = (id: string, key: string | null, title: string) => ({
  id,
  state: "ready" as const,
  size: "small",
  cpuMillis: 2000,
  memoryMiB: 4096,
  waitingReason: null,
  createdAt: now - 12 * 60_000,
  task: { id: taskIdSchema.parse(`01900000-0000-7000-8000-00000000${id}`), key, title, project },
});

describe("a runner's Capacity and Boxes", () => {
  it("F-092: CPU and memory show a bar and what the boxes take of what the runner offers", () => {
    const html = renderToStaticMarkup(
      <Capacity page={{ busy: 3, slots: 4, executor: "docker", resources: { cpuMillis: 15_000, memoryMiB: 30_720 }, used: { cpuMillis: 8000, memoryMiB: 16_384 } }} />,
    );
    expect(html).toContain("3 of 4 busy");
    expect(html).toContain("8 of 15 vCPU");
    expect(html).toContain("16 of 30 GiB");
    expect(html).toContain('aria-label="CPU" aria-valuemin="0" aria-valuemax="15000" aria-valuenow="8000"');
    expect(html).toContain('aria-label="Memory" aria-valuemin="0" aria-valuemax="30720" aria-valuenow="16384"');
  });

  it("F-092: a slots-only runner shows the Slots bar alone", () => {
    const html = renderToStaticMarkup(<Capacity page={{ busy: 1, slots: 2, executor: "host", resources: null, used: null }} />);
    expect(html).toContain("1 of 2 busy");
    expect(html).not.toContain("vCPU");
    expect(html).toContain("host counts slots only");
  });

  it("F-092: each box shows its task's key and title, and its size with its limits", () => {
    const html = renderToStaticMarkup(
      <Boxes page={{ executor: "docker", state: "online", resources: { cpuMillis: 15_000, memoryMiB: 30_720 }, boxes: [box("0b01", "CALC-212", "Fix the rounding"), box("0b02", null, "Add a dark mode")] }} now={now} />,
    );
    expect(html).toContain("CALC-212");
    expect(html).toContain("Fix the rounding");
    expect(html).toContain("small · 2 vCPU · 4 GiB");
    // A prompt task, by its short ID.
    expect(html).toContain("0000b02");
    // The key, then the title, in the task's link.
    expect(html).toMatch(/CALC-212<\/span><span class="truncate text-text">Fix the rounding</);
  });

  it("F-092: the size reads slot on host and the bare name without limits", () => {
    const sized = { size: "medium", cpuMillis: 4000, memoryMiB: 8192 };
    expect(boxSizeText(sized, "docker")).toBe("medium · 4 vCPU · 8 GiB");
    expect(boxSizeText({ size: "small", cpuMillis: 1500, memoryMiB: 3072 }, "kubernetes")).toBe("small · 1.5 vCPU · 3 GiB");
    expect(boxSizeText(sized, "host")).toBe("slot");
    expect(boxSizeText({ size: "small", cpuMillis: null, memoryMiB: null }, "docker")).toBe("small");
    expect(boxTaskKey({ id: taskIdSchema.parse("01900000-0000-7000-8000-000000abcdef"), key: null })).toBe("0abcdef");
  });
});
