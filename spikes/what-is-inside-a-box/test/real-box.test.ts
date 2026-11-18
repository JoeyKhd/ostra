// The real-box mode's pure helpers, on this machine: the pod template filler
// (against the real box-pod.yaml) and the size parser for docker stats /
// kubectl top. The mode itself needs Docker or a cluster.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillTemplate, parseMegabytes } from "../src/harness/real-box.ts";
import { DEPLOY_DIR } from "../src/harness/validate-files.ts";

/** The manifest without its comments (they mention the placeholders by name). */
const body = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("fillTemplate on box-pod.yaml", () => {
  it("fills every placeholder and keeps the runtime class when set", async () => {
    const text = await readFile(path.join(DEPLOY_DIR, "k8s", "box-pod.yaml"), "utf8");
    const filled = body(fillTemplate(text, { OSTRA_BOX_ID: "box-1234abcd", OSTRA_RUNTIME_CLASS: "gvisor" }));
    expect(filled).not.toContain("${");
    expect(filled).toContain("runtimeClassName: gvisor");
    expect(filled).toContain("name: ostra-box-box-1234abcd");
  });
  it("drops runtimeClassName when the class is empty (the node's default runtime)", async () => {
    const text = await readFile(path.join(DEPLOY_DIR, "k8s", "box-pod.yaml"), "utf8");
    expect(body(fillTemplate(text, { OSTRA_BOX_ID: "box-1234abcd", OSTRA_RUNTIME_CLASS: "" }))).not.toMatch(/runtimeClassName/);
  });
  it("throws on a placeholder it has no value for", () => {
    expect(() => fillTemplate("a: ${OSTRA_UNKNOWN}", {})).toThrow();
  });
});

describe("parseMegabytes", () => {
  it("reads docker stats and kubectl top sizes", () => {
    expect(parseMegabytes("45.5MiB")).toBeCloseTo(45.5);
    expect(parseMegabytes("45Mi")).toBe(45);
    expect(parseMegabytes("1.5GiB")).toBe(1536);
    expect(parseMegabytes("512KiB")).toBe(0.5);
    expect(parseMegabytes("n/a")).toBeUndefined();
  });
});
