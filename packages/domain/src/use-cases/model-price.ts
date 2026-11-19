import type { Tx } from "@ostra/db";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { UseCaseResult } from "./common.ts";
import type { M4Deps, SetModelPrice } from "./m4-signatures.ts";

// F-037 (ticket 27, ADR 0055): an organization admin's four prices for a model. Prices come from
// the endpoint's list, models.dev, then an admin's price; an admin's price is last and wins, so a
// catalog refresh keeps it (`priceSource: "admin"`). A price applies from its change on: spend
// already counted in `SpendDaily` is never repriced.

/** Most a price can be: the column holds `Decimal(12, 6)` dollars per million tokens. */
export const MAX_PRICE_MICRO_USD_PER_MTOK = 999_999_000_000;

type SetModelPriceError = "forbidden" | "not-found" | "invalid-input";
type SetModelPriceResult = UseCaseResult<{ readonly priceChangedAt: number }, SetModelPriceError>;

const dollarsOfMicro = (micro: number | null): string | null => (micro === null ? null : (micro / 1_000_000).toFixed(6));

/** The four prices in micro-USD per million tokens, each `null` when unknown. */
export const setModelPrice = async (
  deps: Pick<M4Deps, "db" | "audit" | "clock" | "notices">,
  scope: MemberScope,
  input: Parameters<SetModelPrice>[2],
): Promise<SetModelPriceResult> => {
  const organizationId = scope.organizationId;
  const access = requireOrganizationAdmin(scope, organizationId);
  if (!access.ok) {
    return access.code === "not-found"
      ? { ok: false, error: "not-found", message: "No such organization" }
      : { ok: false, error: "forbidden", message: "Only an organization admin sets a model's price" };
  }
  const prices = [input.inputPerMTok, input.outputPerMTok, input.cacheReadPerMTok, input.cacheWritePerMTok];
  if (prices.some((price) => price !== null && (!Number.isInteger(price) || price < 0 || price > MAX_PRICE_MICRO_USD_PER_MTOK))) {
    return { ok: false, error: "invalid-input", message: "A price is from $0 to $999,999 per million tokens" };
  }
  return deps.db.$transaction(async (tx: Tx): Promise<SetModelPriceResult> => {
    const model = await tx.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, providerId: true } });
    if (model === null) {
      return { ok: false, error: "not-found", message: "No such model" };
    }
    const at = deps.clock.now();
    await tx.model.update({
      where: { id: model.id },
      data: {
        inputPricePerMTok: dollarsOfMicro(input.inputPerMTok),
        outputPricePerMTok: dollarsOfMicro(input.outputPerMTok),
        cacheReadPricePerMTok: dollarsOfMicro(input.cacheReadPerMTok),
        cacheWritePricePerMTok: dollarsOfMicro(input.cacheWritePerMTok),
        priceSource: "admin",
        priceChangedAt: new Date(at),
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "model.price-changed",
      entity: "model",
      entityId: modelIdSchema.parse(model.id),
      data: {
        inputPerMTok: input.inputPerMTok,
        outputPerMTok: input.outputPerMTok,
        cacheReadPerMTok: input.cacheReadPerMTok,
        cacheWritePerMTok: input.cacheWritePerMTok,
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "model-provider", entityId: providerIdSchema.parse(model.providerId) });
    return { ok: true, priceChangedAt: at };
  });
};
