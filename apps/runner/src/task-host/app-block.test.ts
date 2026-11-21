import type { LaunchApp } from "@ostra/adapter-sdk";
import { appInstructionsBlock } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";
import { appProcessesFixture, taskSpecAppFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { inBoxServiceAddress, launchAppOf } from "./app-block.ts";

// The app's block's input from the task's spec (F-140, ADR 0068, ticket 14): each app process by
// its label, name and port, and each service with a port at its address on this executor.

const mailpit = { name: "mailpit", port: 8025 } as const;

describe("the app's block from the task's spec (F-140)", () => {
  it("F-140/c10: names each app process by its label, name, port and primary, and each service at its address on docker and kubernetes; host has none", () => {
    const processes = appProcessesFixture.map((process) => ({ name: process.name, label: process.label, port: process.port, primary: process.primary }));
    expect(launchAppOf(taskSpecAppFixture, "docker")).toEqual({ processes, services: [{ name: "mailpit", label: "Mail", address: "http://mailpit:8025" }] });
    expect(launchAppOf(taskSpecAppFixture, "kubernetes")).toEqual({ processes, services: [{ name: "mailpit", label: "Mail", address: "http://localhost:8025" }] });
    // ADR 0029, difference 1: a host runner runs no services, so its block names none.
    expect(launchAppOf(taskSpecAppFixture, "host")).toEqual({ processes, services: [] });
    // An executor ostra doesn't know reaches no service either.
    expect(launchAppOf(taskSpecAppFixture, "fake-executor")).toEqual({ processes, services: [] });
  });

  it("F-140/c10: a service without a port, or without a preview label, is named by its address alone or not at all", () => {
    expect(inBoxServiceAddress(mailpit, "docker")).toBe("http://mailpit:8025");
    expect(inBoxServiceAddress(mailpit, "kubernetes")).toBe("http://localhost:8025");
    expect(inBoxServiceAddress(mailpit, "host")).toBeNull();
    expect(inBoxServiceAddress({ name: "worker", port: null }, "docker")).toBeNull();
    const spec: TaskSpec = {
      ...taskSpecAppFixture,
      services: [
        { name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: "pg_isready" },
        { name: "worker", image: "acme/worker:1", port: null, variables: [], healthCheck: null, preview: null },
      ],
    };
    expect(launchAppOf(spec, "docker")?.services).toEqual([{ name: "postgres", label: null, address: "http://postgres:5432" }]);
  });

  it("F-140/c10: a task whose environment has no app process gets no app, and so no block", () => {
    expect(launchAppOf(taskSpecFixture, "docker")).toBeNull();
    expect(launchAppOf({ ...taskSpecAppFixture, environment: { ...taskSpecAppFixture.environment, appProcesses: [] } }, "docker")).toBeNull();
  });

  it("F-140/c10: the block holds labels, names and ports only: no process's command reaches it", () => {
    const app: LaunchApp | null = launchAppOf(taskSpecAppFixture, "docker");
    if (app === null) throw new Error("the fixture has app processes");
    const block = appInstructionsBlock({ ...app, tools: true });
    expect(block).toContain(`- "Web" (web, the primary preview): http://localhost:5173, also in OSTRA_APP_WEB_URL`);
    expect(block).toContain("start_app");
    for (const process of appProcessesFixture) {
      expect(block).not.toContain(process.command);
    }
  });
});
