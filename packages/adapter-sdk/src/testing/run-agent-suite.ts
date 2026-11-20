import { describe, it } from "vitest";

import type { AgentAdapter } from "../agent/base.ts";
import { defineAgentContractSuite } from "./agent-suite.ts";
import type { AgentFixture } from "./agent-suite.ts";

// The agent contract suite by adapter (milestone 7, ticket 03; spec section 5.2): every case of
// milestones 1 to 7 run on the adapter named, so a second agent after v1 runs the same cases by
// passing its own adapter and fixture. A case a capability rules out runs its declared fallback
// instead (the suite's cases each check the capability), and the parity table (`parity.ts`) names
// which case proves each feature on each adapter.

/** Where the model calls go: the stub endpoint, or the `OSTRA_DEV_MODEL_*` provider. */
export type AgentSuiteModel = "stub" | "live";

export type RunAgentSuiteOptions = {
  readonly model: AgentSuiteModel;
  /** The adapter's fixture for that model. A live fixture is built only when the provider is loaded. */
  readonly fixture: () => Promise<AgentFixture>;
  /** Told apart from another run of the same adapter, such as another API format. */
  readonly variant?: string;
};

/** The development provider's variables (`docs/development.md`): a live run needs all three. */
export const LIVE_MODEL_ENV = ["OSTRA_DEV_MODEL_BASE_URL", "OSTRA_DEV_MODEL_API_KEY", "OSTRA_DEV_MODEL_ID"] as const;

/** Whether the live provider is loaded in this environment. */
export const liveModelLoaded = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  LIVE_MODEL_ENV.every((name) => (env[name] ?? "") !== "");

/** The suite's title for an adapter: its name, the model and the variant. */
export const agentSuiteName = (adapter: Pick<AgentAdapter, "name">, options: Pick<RunAgentSuiteOptions, "model" | "variant">): string =>
  `${adapter.name}, ${options.model} model${options.variant === undefined ? "" : `, ${options.variant}`}`;

/**
 * Runs every agent contract case on `adapter`. With `model: "live"` and no provider loaded, the
 * suite is listed as skipped, never as passed.
 */
export const runAgentSuite = (adapter: AgentAdapter, options: RunAgentSuiteOptions): void => {
  const name = agentSuiteName(adapter, options);
  if (options.model === "live" && !liveModelLoaded()) {
    describe.skip(`agent contract: ${name}`, () => {
      it("needs the live provider's OSTRA_DEV_MODEL_* variables", () => undefined);
    });
    return;
  }
  defineAgentContractSuite({ name, create: async () => ({ adapter, fixture: await options.fixture() }) });
};
