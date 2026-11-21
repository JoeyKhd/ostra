import { inputModalitySchema, isPromptImageContentType, runnerLimits } from "@ostra/protocol";
import type { ImagesNotSent, InputModality, MessageFileKind } from "@ostra/protocol";
import { z } from "zod";

// Which images go to the model as images (ADR 0070, Q332, Q335, Q339, spec section 5.4): only where
// the agent takes images in its prompt (its adapter's `promptImages`) and the model sees them
// (an organization admin's "Reads images", then models.dev's `modalities.input`; unknown counts as
// no); at most `promptImagesMax` of `promptImageMaxBytes` each. The rest, and every image an agent
// or a model can't take, go as files only, and the prompt and the thread say why.

/** Whether a model sees images: an admin's word, then the catalog's, else `unknown` (counted as no). */
export type ModelImageInput = "yes" | "no" | "unknown";

/** The catalog's inputs as the model row keeps them: models.dev's words, the ones ostra doesn't know dropped. */
const catalogInputsSchema = z.array(z.string()).transform((words) => words.filter((word): word is InputModality => inputModalitySchema.safeParse(word).success));

/** A model's inputs from the catalog's JSON, or `null` when it says nothing ostra can read. */
export const catalogInputModalities = (value: unknown): readonly InputModality[] | null => {
  const parsed = catalogInputsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Whether a model sees images: `adminImageInput` wins, then `catalogInputModalities`; neither is `unknown`. */
export const modelImageInput = (model: { readonly adminImageInput: boolean | null; readonly catalogInputModalities: unknown }): ModelImageInput => {
  if (model.adminImageInput !== null) {
    return model.adminImageInput ? "yes" : "no";
  }
  const inputs = catalogInputModalities(model.catalogInputModalities);
  if (inputs === null) {
    return "unknown";
  }
  return inputs.includes("image") ? "yes" : "no";
};

/**
 * The model's inputs as the spec's agent section names them (`agent.inputModalities`): the catalog's,
 * with `image` added or dropped by the admin's word. `text` is always there. Unknown is `["text"]`.
 */
export const modelInputModalities = (model: { readonly adminImageInput: boolean | null; readonly catalogInputModalities: unknown }): readonly InputModality[] => {
  const inputs = new Set<InputModality>(["text", ...(catalogInputModalities(model.catalogInputModalities) ?? [])]);
  if (model.adminImageInput === true) {
    inputs.add("image");
  } else if (model.adminImageInput === false) {
    inputs.delete("image");
  }
  return inputModalitySchema.options.filter((input) => inputs.has(input));
};

/** A message's file as the decision weighs it. */
export type ImageCandidate<Id> = { readonly fileId: Id; readonly kind: MessageFileKind; readonly contentType: string; readonly size: number };

/** Which of a message's files go as images too, and why images went as files only (`null`: none did for the agent's or the model's sake). */
export type PromptImages<Id> = { readonly images: readonly Id[]; readonly notSent: ImagesNotSent | null };

/**
 * The image decision (ADR 0070): the message's images (PNG, JPEG, GIF, WebP), in its order, go as
 * images when the model sees images and the agent takes them in its prompt, at most
 * `promptImagesMax` and each at most `promptImageMaxBytes`; the rest as files. When the model
 * can't (or isn't known to) see images, none go, and `notSent` is `model`; when the agent can't
 * take them, `agent`. A message with no image has `null`.
 */
export const promptImagesFor = <Id>(
  files: readonly ImageCandidate<Id>[],
  options: { readonly agentTakesImages: boolean; readonly modelImageInput: ModelImageInput },
): PromptImages<Id> => {
  const candidates = files.filter((file) => file.kind === "image" && isPromptImageContentType(file.contentType));
  if (candidates.length === 0) {
    return { images: [], notSent: null };
  }
  if (options.modelImageInput !== "yes") {
    return { images: [], notSent: "model" };
  }
  if (!options.agentTakesImages) {
    return { images: [], notSent: "agent" };
  }
  const images = candidates.filter((file) => file.size <= runnerLimits.promptImageMaxBytes).slice(0, runnerLimits.promptImagesMax);
  return { images: images.map((file) => file.fileId), notSent: null };
};
