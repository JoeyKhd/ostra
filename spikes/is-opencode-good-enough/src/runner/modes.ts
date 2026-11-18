// The two ways to run a set: a dry-run against the scripted stub model, and a
// real run against the endpoint in model.env. A real run spends tokens, so it
// is only ever started by a flag that says so (`--real`).

import { detectApiFormat, type Inputs, type ModelEndpoint } from "../harness/inputs.ts";
import type { OpenCodeBinary } from "../lib/opencode.ts";
import type { Ticket } from "../tickets/schema.ts";
import { dryRunVariant } from "../tickets/solutions.ts";
import { TICKETS } from "../tickets/tickets.ts";
import { STUB_PRICING } from "./pricing.ts";
import type { RunRecord } from "./schemas.ts";
import type { RunLimits, RunLogger } from "./run-ticket.ts";
import { STUB_MODEL } from "./run-ticket.ts";
import type { SetOptions } from "./run-set.ts";

export type CommonSetOptions = {
  readonly setDir: string;
  readonly tickets: readonly Ticket[];
  readonly runsPerTicket: number;
  readonly concurrency: number;
  readonly limits: RunLimits;
  readonly binary: OpenCodeBinary;
  readonly log: RunLogger;
  readonly onRecord?: (record: RunRecord) => void;
  readonly stopRequested?: () => boolean;
  readonly retryFailed?: boolean;
};

const passThrough = (common: CommonSetOptions): Pick<SetOptions, "onRecord" | "stopRequested" | "retryFailed"> => ({
  ...(common.onRecord === undefined ? {} : { onRecord: common.onRecord }),
  ...(common.stopRequested === undefined ? {} : { stopRequested: common.stopRequested }),
  ...(common.retryFailed === undefined ? {} : { retryFailed: common.retryFailed }),
});

/** The dry-run: scripted runs, the API formats alternating from one run to the next, four of them going wrong on purpose. */
export const dryOptions = (common: CommonSetOptions): SetOptions => ({
  setDir: common.setDir,
  label: "dry",
  mode: "dry",
  tickets: common.tickets,
  runsPerTicket: common.runsPerTicket,
  concurrency: common.concurrency,
  limits: common.limits,
  modelFor: (ticket, index) => ({ kind: "stub", format: (TICKETS.indexOf(ticket) + index) % 2 === 1 ? "anthropic" : "openai", variant: dryRunVariant(ticket.id, index) }),
  modelInfo: { id: STUB_MODEL, format: "both" },
  pricing: STUB_PRICING.source,
  binary: common.binary,
  log: common.log,
  ...passThrough(common),
});

export type RealOptions = CommonSetOptions & {
  readonly label: string;
  readonly endpoint: ModelEndpoint;
  readonly inputs: Inputs;
};

/** A real run set: every run goes to the endpoint, through the key proxy. */
export const realOptions = async (options: RealOptions): Promise<SetOptions> => {
  const format = await detectApiFormat(options.endpoint);
  return {
    setDir: options.setDir,
    label: options.label,
    mode: "real",
    tickets: options.tickets,
    runsPerTicket: options.runsPerTicket,
    concurrency: options.concurrency,
    limits: options.limits,
    modelFor: () => ({ kind: "endpoint", endpoint: options.endpoint, format, pricing: options.inputs.pricing, limits: options.inputs.limits }),
    modelInfo: { id: options.endpoint.modelId, format },
    pricing: options.inputs.pricing === undefined ? "none" : "configured",
    binary: options.binary,
    log: options.log,
    ...passThrough(options),
  };
};
