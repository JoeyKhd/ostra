import { secretRefSchema } from "@ostra/adapter-sdk";
import { envNameSchema, runnerLimits } from "@ostra/protocol";
import type { ExecutorKind } from "@ostra/protocol";
import { z } from "zod";

// An environment's services (F-094, ADR 0038 as amended, ADR 0029): containers the `docker`
// executor starts beside each box. A `Service` row keeps its variables as JSON: each a plain value,
// or a secret by its reference in the secret store. The spec carries the plain ones; the secrets
// reach the runner through the credentials endpoint after the lease check, never the spec.

export const serviceVariableSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), name: envNameSchema, value: z.string().max(65_536) }),
  z.strictObject({ kind: z.literal("secret"), name: envNameSchema, secretRef: secretRefSchema }),
]);
export type ServiceVariable = z.infer<typeof serviceVariableSchema>;

/** `Service.variables`: ostra's own format, so an unknown field is refused. */
export const serviceVariablesSchema = z.array(serviceVariableSchema).max(200);

/** A row's variables, read from storage: an unreadable value reads as none, so one bad row never stops a dispatch. */
export const serviceVariablesFromDb = (value: unknown): readonly ServiceVariable[] => {
  const parsed = serviceVariablesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

/**
 * Whether a runner can start an environment's services, from what its `hello` said: its executor
 * and its protocol minor. Services are a minor-2 spec section, and only `docker` starts them:
 * `host` declares `services: false` (ADR 0029), and `kubernetes` gets them with F-093
 * (milestone 5). This mirrors each executor adapter's `services` capability, which a runner
 * doesn't send: a declared capability is a promise the scheduler acts on.
 */
export const runnerStartsServices = (runner: { readonly executor: ExecutorKind; readonly minor: number }): boolean =>
  runner.executor === "docker" && runner.minor >= 2;

/** The most services one environment holds: the spec's own cap. */
export const SERVICES_MAX = runnerLimits.servicesMax;
