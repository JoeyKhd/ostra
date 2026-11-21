import type { Db } from "@ostra/db";
import { providerIdSchema } from "@ostra/protocol";
import type { ModelId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { catalogInputModalities, modelImageInput } from "./images.ts";
import type { ModelImageInput } from "./images.ts";

// A model's "Reads images" (F-148/c5, ADR 0070, Q335, ticket 14): an organization admin says
// whether one provider's model sees images, or clears it (`null`) so the catalog's
// `modalities.input` applies again. The admin's word wins over the catalog's, which the catalog
// sync keeps writing beside it, so a refresh never undoes it. One transaction with its audit entry
// (F-073) and the provider's change notice; a rollback leaves neither.

/** A model's image input as the panel shows it: what applies, what the catalog says, and the admin's word. */
export type ModelImageInputView = {
  /** What a message's images go by: the admin's word, then the catalog's; `unknown` counts as no. */
  readonly imageInput: ModelImageInput;
  /** What models.dev's `modalities.input` says: `unknown` when it says nothing (a custom model). */
  readonly catalogImageInput: ModelImageInput;
  /** The admin's "Reads images": `null` follows the catalog. */
  readonly adminImageInput: boolean | null;
};

/** A model row's image input, for the providers' page, a task's box and the new task's. */
export const modelImageInputView = (model: { readonly adminImageInput: boolean | null; readonly catalogInputModalities: unknown }): ModelImageInputView => {
  const catalog = catalogInputModalities(model.catalogInputModalities);
  return {
    imageInput: modelImageInput(model),
    catalogImageInput: catalog === null ? "unknown" : catalog.includes("image") ? "yes" : "no",
    adminImageInput: model.adminImageInput,
  };
};

export type SetModelImageInputInput = {
  readonly modelId: ModelId;
  /** The admin's word: it reads images, it doesn't, or `null` to follow the catalog again. */
  readonly imageInput: boolean | null;
};

export type SetModelImageInputResult = UseCaseResult<{ readonly changed: boolean } & ModelImageInputView, "not-found" | "forbidden">;

/** What the audit entry says of a word: never more than the switch. */
const wordOf = (value: boolean | null): string => (value === null ? "catalog" : value ? "reads-images" : "no-images");

/** Sets or clears an organization admin's "Reads images" on a model of their organization. */
export const setModelImageInput = (deps: { readonly db: Db } & Pick<Ports, "audit" | "notices">, scope: MemberScope, input: SetModelImageInputInput): Promise<SetModelImageInputResult> =>
  deps.db.$transaction(async (tx) => {
    const model = await tx.model.findFirst({
      where: { id: input.modelId, organizationId: scope.organizationId },
      select: { id: true, providerId: true, adminImageInput: true, catalogInputModalities: true },
    });
    if (model === null) {
      return { ok: false, error: "not-found", message: "No such model" };
    }
    const admin = requireOrganizationAdmin(scope, scope.organizationId);
    if (!admin.ok) {
      return { ok: false, error: "forbidden", message: "Only an organization admin can say whether a model reads images" };
    }
    if (model.adminImageInput === input.imageInput) {
      return { ok: true, changed: false, ...modelImageInputView(model) };
    }
    await tx.model.update({ where: { id: model.id }, data: { adminImageInput: input.imageInput } });
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "model.image-input-changed",
      entity: "model",
      entityId: input.modelId,
      data: { from: wordOf(model.adminImageInput), to: wordOf(input.imageInput) },
    });
    await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: null, entity: "model-provider", entityId: providerIdSchema.parse(model.providerId) });
    return { ok: true, changed: true, ...modelImageInputView({ ...model, adminImageInput: input.imageInput }) };
  });
