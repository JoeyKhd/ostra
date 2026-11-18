import type { Tx } from "@ostra/db";
import { environmentConfigSchema, projectIdSchema } from "@ostra/protocol";
import type { EnvironmentId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-050, ADR 0038: a project admin saves the environment (reviewed from its draft): the setup
// script, and each repo's variables, secrets and files. Secret values go to the secret store and
// the entries keep references. Written by ticket 32.

export const saveEnvironmentInputSchema = z.strictObject({
  projectId: projectIdSchema,
  environment: environmentConfigSchema,
});
export type SaveEnvironmentInput = z.infer<typeof saveEnvironmentInputSchema>;

export type SaveEnvironmentResult = UseCaseResult<
  { readonly environmentId: EnvironmentId },
  "not-found" | "forbidden" | "unknown-repo" | "duplicate-entry"
>;

export type SaveEnvironmentDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type SaveEnvironment = (deps: SaveEnvironmentDeps, input: SaveEnvironmentInput) => Promise<SaveEnvironmentResult>;

export const saveEnvironment: SaveEnvironment = () => notImplemented("32");
