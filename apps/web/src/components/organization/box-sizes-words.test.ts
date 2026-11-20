import { describe, expect, it } from "vitest";

import { cpuText, gibText, lastChangeLine, parseCpu, parseMemory, roomWarning, slotsOnlyLine } from "./box-sizes-words";

// F-095 (box-sizes.md): the Box sizes page's values, checks and sentences.

const bounds = { min: { cpuMillis: 500, memoryMiB: 1024 }, max: { cpuMillis: 256_000, memoryMiB: 2_097_152 } };

describe("box sizes' values", () => {
  it("F-095: vCPU in steps of 0.5 and whole GiB, within the bounds", () => {
    expect(cpuText(2000)).toBe("2");
    expect(cpuText(500)).toBe("0.5");
    expect(gibText(16_384)).toBe("16");
    expect(parseCpu("1.5", bounds)).toBe(1500);
    expect(parseCpu("0.3", bounds)).toBeNull();
    expect(parseCpu("0", bounds)).toBeNull();
    expect(parseCpu("257", bounds)).toBeNull();
    expect(parseCpu("two", bounds)).toBeNull();
    expect(parseMemory("32", bounds)).toBe(32_768);
    expect(parseMemory("1.5", bounds)).toBeNull();
    expect(parseMemory("0", bounds)).toBeNull();
  });

  it("F-095: warns when no runner that enforces sizes offers a size, memory first, with the projects on it", () => {
    const largest = { cpuMillis: { value: 15_000, runnerName: "build-01" }, memoryMiB: { value: 30_720, runnerName: "build-01" } };
    expect(roomWarning("large", { cpuMillis: 8000, memoryMiB: 32_768 }, largest, 0)).toBe("No runner offers 32 GiB yet: the most is 30 GiB, on build-01. A task on large would wait.");
    expect(roomWarning("large", { cpuMillis: 16_000, memoryMiB: 16_384 }, largest, 3)).toBe("No runner offers 16 vCPU yet: the most is 15 vCPU, on build-01. 3 projects use large, and their tasks would wait.");
    expect(roomWarning("small", { cpuMillis: 2000, memoryMiB: 4096 }, largest, 15)).toBeNull();
  });

  it("F-095: the panel's runners line and the last change", () => {
    expect(slotsOnlyLine({ enforce: 0, slotsOnly: 0, host: 0, behind: [] })).toBe("No runner yet.");
    expect(slotsOnlyLine({ enforce: 0, slotsOnly: 2, host: 2, behind: [] })).toBe("No runner enforces sizes yet: every runner is host.");
    expect(slotsOnlyLine({ enforce: 18, slotsOnly: 3, host: 2, behind: [{ name: "build-03" }] })).toBe("2 host runners, and build-03, which is one minor behind.");
    expect(lastChangeLine(undefined)).toBe("The defaults: 2 · 4, 4 · 8 and 8 · 16.");
    expect(lastChangeLine({ at: Date.UTC(2026, 10, 12, 12), actor: { name: "Alex Kim" }, data: { size: "large", cpuMillis: 8000, memoryMiB: 16_384 } })).toBe("Large set to 8 vCPU · 16 GiB by Alex Kim, 12 Nov");
  });
});
