// Whether OpenCode takes images in its prompt (F-148, ADR 0070, Q332), without the adapter's process
// code: the adapter's `promptImages` capability reads this, and so does the panel's API, which
// decides a message's images when it sends one (`@ostra/adapter-opencode/prompt-images`). OpenCode
// advertises `promptCapabilities.image`, and shows an image to a model whose inputs its config and
// catalog name (`modelInputModalities`, ticket 09); to one they don't, it sends an error line, so
// the driver sends images only to such a model.

export const OPENCODE_PROMPT_IMAGES = true;
