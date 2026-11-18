import { createAcpDriver } from "@ostra/adapter-sdk";
import type { AcpDriverOptions, AgentAdapter, DriverPort } from "@ostra/adapter-sdk";
import { OpenCodeAdapter } from "@ostra/adapter-opencode";

// The agent adapters this runner can run, by the name the task spec gives (`agent.adapter`). Each
// task gets its own adapter around its own driver, so the driver's partial text goes to that
// task's session (ADR 0035).

export type AgentFactory = (driver: DriverPort) => AgentAdapter;

export type AgentRegistry = {
  readonly create: (name: string, driverOptions: AcpDriverOptions) => AgentAdapter | undefined;
  readonly names: () => readonly string[];
};

export const createAgentRegistry = (factories: Readonly<Record<string, AgentFactory>>): AgentRegistry => ({
  create: (name, driverOptions) => {
    const factory = factories[name];
    return factory === undefined ? undefined : factory(createAcpDriver(driverOptions));
  },
  names: () => Object.keys(factories),
});

/** What milestone 1 ships: OpenCode (ADR 0032). */
export const defaultAgents = (): AgentRegistry =>
  createAgentRegistry({
    opencode: (driver) => new OpenCodeAdapter({ driver }),
  });
