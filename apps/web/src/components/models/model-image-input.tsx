"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ModelImageInput } from "@ostra/domain";
import type { ModelId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// A model's image input (F-148, ADR 0070, Q335; ticket 16): whether it reads images, from models.dev's
// `modalities.input` as the catalog keeps it, and an organization admin's "Reads images", which
// wins (`providers.setModelImageInput`). Unknown counts as no: the agent gets images as files.

/** The catalog's word on a model's images. */
export const catalogImagesText = (input: ModelImageInput): string => {
  switch (input) {
    case "yes":
      return t("models.images.catalogYes");
    case "no":
      return t("models.images.catalogNo");
    case "unknown":
      return t("models.images.catalogUnknown");
    default:
      return input satisfies never;
  }
};

export type ModelImages = { readonly imageInput: ModelImageInput; readonly catalogImageInput: ModelImageInput; readonly adminImageInput: boolean | null };

export const ImageInputGroup = ({ modelId, modelName, providerId, images, canEdit }: {
  readonly modelId: ModelId;
  readonly modelName: string;
  readonly providerId: string;
  readonly images: ModelImages;
  /** An organization admin sets it. */
  readonly canEdit: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const set = useMutation(
    trpc.providers.setModelImageInput.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.providers.models.queryKey({ providerId }) }),
    }),
  );
  const reads = images.imageInput === "yes";
  return (
    <div data-testid="model-images">
      <PropGroup title={t("models.images.title")}>
        <PropRow label={t("models.images.reads")}>
          <Switch
            checked={reads}
            disabled={!canEdit || set.isPending}
            aria-label={t("models.images.switch", { model: modelName })}
            onCheckedChange={(on) => { set.mutate({ modelId, imageInput: on }); }}
            data-action="reads-images"
          />
          <span data-testid="model-reads-images">{reads ? t("models.images.yes") : t("models.images.no")}</span>
        </PropRow>
        <PropRow label={t("models.images.catalog")}><span className="truncate">{catalogImagesText(images.catalogImageInput)}</span></PropRow>
        {images.adminImageInput === null ? null : (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-faint">
            {t("models.images.setByAdmin")}
            {canEdit ? (
              <Button variant="link" className="h-auto px-0 text-sm" disabled={set.isPending} onClick={() => { set.mutate({ modelId, imageInput: null }); }} data-action="images-use-catalog">
                {t("models.images.useCatalog")}
              </Button>
            ) : null}
          </p>
        )}
        {set.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{errorText(set.error)}</p>}
      </PropGroup>
    </div>
  );
};
