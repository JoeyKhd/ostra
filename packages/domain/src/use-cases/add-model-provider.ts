import type { Tx } from "@ostra/db";
import { addModelProviderInputSchema } from "@ostra/protocol";
import type { AddModelProviderInput, ProviderId } from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-088, ADR 0033: an admin adds a model provider. The token goes to the secret store, the row keeps
// its reference, and a `provider.refresh-models` job lists the models. Personal runners may use it
// only when the admin allows it (off by default). Written by ticket 31.

export { addModelProviderInputSchema };
export type { AddModelProviderInput };

export type AddModelProviderResult = UseCaseResult<
  { readonly providerId: ProviderId },
  "forbidden" | "name-taken" | "connection-failed"
>;

export type AddModelProviderDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type AddModelProvider = (deps: AddModelProviderDeps, input: AddModelProviderInput) => Promise<AddModelProviderResult>;

export const addModelProvider: AddModelProvider = () => notImplemented("31");
