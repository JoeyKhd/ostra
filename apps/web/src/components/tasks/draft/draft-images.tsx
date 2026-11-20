"use client";

import { CheckIcon, ImageIcon, UploadIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/messages";

import { FieldLabel } from "./draft-field-list";

// The draft's images (refine-draft.md, "Images"): a 52px row per image, its thumbnail, its name and
// size in mono and its `x`; then "Upload", which also takes a drop or a paste anywhere on the tab.
// The panel serves no stored image back, so a thumbnail shows for a file uploaded in this visit
// (its object URL) and a plain tile for the others. Once applied, each says "attached".

export type DraftImage = { readonly imageId: string; readonly name: string; readonly size: number; readonly attachedAt: number | null };

/** The types a draft takes (the API's), and its 10 MiB cap. */
export const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const sizeText = (bytes: number): string => (bytes < 1024 * 1024 ? t("draft.sizeKb", { n: Math.max(1, Math.round(bytes / 1024)) }) : t("draft.sizeMb", { n: (bytes / (1024 * 1024)).toFixed(1) }));

export const DraftImages = ({ images, max, editable, applied, thumbs, uploading, error, onUpload, onRemove }: {
  readonly images: readonly DraftImage[];
  readonly max: number;
  readonly editable: boolean;
  readonly applied: boolean;
  /** Object URLs of the files uploaded in this visit, by image. */
  readonly thumbs: ReadonlyMap<string, string>;
  /** The names being uploaded now. */
  readonly uploading: readonly string[];
  readonly error: string | null;
  readonly onUpload: (files: readonly File[]) => void;
  readonly onRemove: (imageId: string) => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const full = images.length + uploading.length >= max;
  return (
    <section data-field="images" aria-label={t("draft.images")}>
      <FieldLabel label={t("draft.images")} count={t("draft.imagesCount", { n: images.length, max })} />
      <ul>
        {images.map((image) => {
          const thumb = thumbs.get(image.imageId);
          return (
            <li key={image.imageId} className="flex h-[52px] items-center gap-3" data-image={image.name}>
              <span className="grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-surface text-faint">
                {thumb === undefined ? <ImageIcon aria-hidden className="size-4 stroke-[1.75]" /> : <img src={thumb} alt="" className="size-full object-cover" />}
              </span>
              <span className="min-w-0 truncate font-mono text-[12.5px] text-text">{image.name}</span>
              <span className="shrink-0 font-mono text-sm text-faint">{sizeText(image.size)}</span>
              <span className="flex-1" />
              {applied ? (
                image.attachedAt === null ? null : (
                  <span className="flex shrink-0 items-center gap-1.5 text-ui text-muted"><CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" /> {t("draft.attached")}</span>
                )
              ) : editable ? (
                <button type="button" className="grid size-6 shrink-0 place-items-center rounded-sm text-faint hover:bg-sel hover:text-text" aria-label={t("draft.removeImage", { name: image.name })} onClick={() => { onRemove(image.imageId); }}>
                  <XIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                </button>
              ) : null}
            </li>
          );
        })}
        {uploading.map((name) => (
          <li key={`uploading-${name}`} className="flex h-[52px] items-center gap-3" aria-busy>
            <span className="h-10 w-16 shrink-0 rounded-[4px] bg-surface" />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[12.5px] text-text">{name}</span>
              <span className="mt-1 block h-0.5 w-24 overflow-hidden rounded-sm bg-line-2"><i className="block h-full w-1/2 animate-pulse bg-muted" /></span>
            </span>
            <span className="text-sm text-faint">{t("draft.uploading")}</span>
          </li>
        ))}
      </ul>
      {editable ? (
        <div className="mt-1.5">
          <input
            ref={input}
            type="file"
            accept={imageTypes.join(",")}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="draft-upload-input"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length > 0) onUpload(files);
            }}
          />
          <Button size="sm" disabled={full} {...(full ? { title: t("draft.imagesMax", { max }) } : {})} onClick={() => input.current?.click()}>
            <UploadIcon aria-hidden /> {t("draft.upload")}
          </Button>
        </div>
      ) : null}
      {error === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{error}</p>}
    </section>
  );
};
