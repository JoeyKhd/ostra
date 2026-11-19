import { z } from "zod";

// The model by name (F-135, F-021, ADR 0065, ADR 0049 amended): a profile names its model by its
// models.dev catalog ID, or by a custom model's endpoint ID, and pins no provider. The project's
// provider list decides which provider's row serves it.

export const modelNameSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("catalog"), catalogId: z.string().min(1).max(256) }),
    z.strictObject({ kind: z.literal("custom"), endpointModelId: z.string().min(1).max(256) }),
  ])
  .brand<"ModelName">();
export type ModelName = z.infer<typeof modelNameSchema>;

/** A `Model` row's name: its catalog ID when it matched one, else its endpoint ID. */
export const modelNameOfModel = (model: { readonly catalogId: string | null; readonly endpointModelId: string }): ModelName =>
  modelNameSchema.parse(model.catalogId === null ? { kind: "custom", endpointModelId: model.endpointModelId } : { kind: "catalog", catalogId: model.catalogId });

/** The key `ModelChoice`'s unique index uses: `catalog:<id>` or `custom:<id>`. */
export const modelNameKey = (name: ModelName): string => {
  switch (name.kind) {
    case "catalog":
      return `catalog:${name.catalogId}`;
    case "custom":
      return `custom:${name.endpointModelId}`;
    default:
      return name satisfies never;
  }
};

/** The two columns a profile or a choice stores the name in. */
export const modelNameColumns = (name: ModelName): { readonly modelCatalogId: string | null; readonly modelCustomName: string | null } => {
  switch (name.kind) {
    case "catalog":
      return { modelCatalogId: name.catalogId, modelCustomName: null };
    case "custom":
      return { modelCatalogId: null, modelCustomName: name.endpointModelId };
    default:
      return name satisfies never;
  }
};

/** A profile's or a choice's name, from its two columns; `null` when neither is set. */
export const modelNameOfColumns = (columns: { readonly modelCatalogId: string | null; readonly modelCustomName: string | null }): ModelName | null => {
  if (columns.modelCatalogId !== null) {
    return modelNameSchema.parse({ kind: "catalog", catalogId: columns.modelCatalogId });
  }
  return columns.modelCustomName === null ? null : modelNameSchema.parse({ kind: "custom", endpointModelId: columns.modelCustomName });
};

/** The name as people read it: the catalog ID, or the endpoint's model ID. */
export const modelNameText = (name: ModelName): string => (name.kind === "catalog" ? name.catalogId : name.endpointModelId);
