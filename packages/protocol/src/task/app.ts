import { z } from "zod";

import { serviceNameSchema } from "../common.ts";
import { utf8ByteLength } from "../json.ts";
import { runnerLimits } from "../runner/limits.ts";

// The running app's words (milestone 8, protocol minor 7, ADR 0068): an app process's name, port
// and path, a preview's target and key, and the viewports. A leaf module: the task spec, the
// events, the commands, the preview connection and the MCP tools all import it, and it imports
// none of them, so none of them import each other through it.

/** Whether a text holds a control character, which no path or label of an app may. */
const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

/**
 * An app process's name: lower-case letters, digits and dashes, unique in its environment. It
 * names the process's in-box address, `OSTRA_APP_<NAME>_URL` (`appAddressName`).
 */
export const appProcessNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lower-case letters, digits and dashes");
export type AppProcessName = z.infer<typeof appProcessNameSchema>;

/** A port an app process or a preview listens on: never below `appPortMin` (ADR 0068). */
export const appPortSchema = z.number().int().min(runnerLimits.appPortMin).max(65_535);

/** Any TCP port, for a tool's input: the tool refuses one below `appPortMin` in words (`portRefusal`). */
export const anyPortSchema = z.number().int().min(1).max(65_535);

/**
 * A path the app answers on, such as `/` or `/settings?tab=2`: from `/`, never `//` or `/\` (which
 * a browser reads as another host), with no whitespace or control character.
 */
export const appPathSchema = z
  .string()
  .min(1)
  .max(runnerLimits.appPathMaxChars)
  .regex(/^\/(?![/\\])\S*$/, "a path from /, on the app's own host")
  .refine((path) => !hasControlCharacter(path), "no control characters");
export type AppPath = z.infer<typeof appPathSchema>;

/** What people call a process or a preview, such as "Web", "API" or "Docs". */
export const appLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((label) => !hasControlCharacter(label), "no control characters");

/** A width the after-turn screenshots take: desktop (1440×900) or phone (390×844). */
export const screenshotWidthSchema = z.enum(["desktop", "phone"]);
export type ScreenshotWidth = z.infer<typeof screenshotWidthSchema>;

/** A viewport the tools and the pane name: desktop, tablet or phone (ADR 0068). */
export const viewportPresetSchema = z.enum(["desktop", "tablet", "phone"]);
export type ViewportPreset = z.infer<typeof viewportPresetSchema>;

/** A page's size in CSS pixels. */
export type ViewportSize = { readonly width: number; readonly height: number };

/** Each preset's size in CSS pixels. */
export const viewportPresetSizes = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
} as const satisfies Readonly<Record<ViewportPreset, ViewportSize>>;

/** A screenshot's size when the agent gives one: up to `screenshotMaxWidthPx` wide and `screenshotMaxHeightPx` high. */
export const screenshotSizeSchema = z.strictObject({
  width: z.number().int().min(200).max(runnerLimits.screenshotMaxWidthPx),
  height: z.number().int().min(200).max(runnerLimits.screenshotMaxHeightPx),
});

/** The browser view's viewport: at most `browserViewMaxWidth` by `browserViewMaxHeight`. */
export const previewViewportSchema = z.strictObject({
  width: z.number().int().min(200).max(runnerLimits.browserViewMaxWidth),
  height: z.number().int().min(200).max(runnerLimits.browserViewMaxHeight),
});
export type PreviewViewport = z.infer<typeof previewViewportSchema>;

// ---------- a preview's target and key ----------

/**
 * What a preview or a picture shows (ADR 0068): one of the environment's app processes, a port
 * the agent announced, or a service marked as a preview.
 */
export const previewTargetSchema = z.union([
  z.strictObject({ process: appProcessNameSchema }),
  z.strictObject({ port: appPortSchema }),
  z.strictObject({ service: serviceNameSchema }),
]);
export type PreviewTarget = z.infer<typeof previewTargetSchema>;

/** Which list a target comes from: the process it names, an announced port, or a service. */
export const previewTargetKindSchema = z.enum(["process", "port", "service"]);
export type PreviewTargetKind = z.infer<typeof previewTargetKindSchema>;

/** A target's kind. */
export const previewTargetKind = (target: PreviewTarget): PreviewTargetKind => {
  if ("process" in target) {
    return "process";
  }
  return "port" in target ? "port" : "service";
};

/**
 * A preview's key within its task: `app-<name>`, `port-<port>` or `service-<name>`. It's the same
 * on every box of the task, so a level, a link and a view name it across a reopen.
 */
export const previewKeySchema = z
  .string()
  .max(80)
  .regex(/^(?:app-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|port-\d{4,5}|service-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/, "a preview's key")
  .brand<"PreviewKey">();
export type PreviewKey = z.infer<typeof previewKeySchema>;

/** A target's key. */
export const previewKeyFor = (target: PreviewTarget): PreviewKey => {
  if ("process" in target) {
    return previewKeySchema.parse(`app-${target.process}`);
  }
  if ("port" in target) {
    return previewKeySchema.parse(`port-${String(target.port)}`);
  }
  return previewKeySchema.parse(`service-${target.service}`);
};

/** Where a preview comes from: the environment declared it (a process or a service), or the agent announced it. */
export const previewSourceSchema = z.enum(["declared", "announced"]);
export type PreviewSource = z.infer<typeof previewSourceSchema>;

/** A caption a member reads beside a picture, in UTF-8 bytes. The agent's words: never logged. */
export const captionSchema = z
  .string()
  .max(runnerLimits.captionMaxBytes)
  .refine((text) => utf8ByteLength(text) <= runnerLimits.captionMaxBytes, "a caption is at most 1 KiB")
  .describe("A caption. Never logged.");

// ---------- the box's browser and the pictures ----------

/** The box's browser, as a picture names it: Chromium, Chrome or Edge, and its version. */
export const boxBrowserSchema = z.strictObject({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
});
export type BoxBrowser = z.infer<typeof boxBrowserSchema>;

/** Why a box has no browser (ADR 0068): the image lacks one, the machine has none, or it failed to start. */
export const noBrowserReasonSchema = z.enum(["not-in-image", "not-found", "download-off", "download-failed", "failed-to-start"]);
export type NoBrowserReason = z.infer<typeof noBrowserReasonSchema>;

/**
 * "No browser in this box", with its fix, in the words the app tools give the agent and the panel
 * shows (ticket 11; the environment page's warning is ticket 17's). Settings' names only.
 */
export const noBrowserWords = (reason: NoBrowserReason): string => {
  switch (reason) {
    case "not-in-image":
      return "No browser in this box: the environment's image has no Chromium at /usr/bin/chromium. Build the image from ostra's base image, or install Debian's chromium package in it.";
    case "not-found":
      return "No browser in this box: the runner found no Chrome, Chromium or Edge, and has no headless shell for this machine. Install one, or set OSTRA_RUNNER_BROWSER to its program.";
    case "download-off":
      return "No browser in this box: the runner found no Chrome, Chromium or Edge, and OSTRA_RUNNER_BROWSER_DOWNLOAD is false. Install one, set OSTRA_RUNNER_BROWSER to its program, or allow the download.";
    case "download-failed":
      return "No browser in this box: the runner found no Chrome, Chromium or Edge, and couldn't download its pinned headless shell. Let it reach storage.googleapis.com, install a browser, or set OSTRA_RUNNER_BROWSER.";
    case "failed-to-start":
      return "No browser in this box: the browser didn't start or didn't answer. The runner's log says why; on a host pool, its sudoers rule needs closefrom_override.";
    default:
      return reason satisfies never;
  }
};

/** A screenshot or a recording (F-121). */
export const attachmentKindSchema = z.enum(["screenshot", "recording"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/** Who took a picture: the agent with its tools, ostra after a turn, or a member from the pane. */
export const attachmentSourceSchema = z.enum(["agent", "after-turn", "member"]);
export type AttachmentSource = z.infer<typeof attachmentSourceSchema>;

/** An app process's state in a box (F-140, ADR 0068). */
export const appProcessStateSchema = z.enum(["starting", "ready", "exited", "failed", "stopped"]);
export type AppProcessState = z.infer<typeof appProcessStateSchema>;

/** Why a process failed or stopped, in ostra's words: never its log. */
export const appProcessReasonSchema = z.enum([
  /** Its command couldn't start: the folder is missing, or the init refused it. */
  "start-failed",
  /** Its ready check didn't pass within `appReadyTimeoutSeconds`. */
  "ready-timeout",
  /** It exited on its own. */
  "exited",
  /** `app.stop`, or `start_app`'s restart, stopped it. */
  "stopped",
  /** The box stopped, and the process with it. */
  "box-stopped",
]);
export type AppProcessReason = z.infer<typeof appProcessReasonSchema>;

/** Where an app process's output goes, in the task's own folder and never in a repo (ADR 0068). */
export const APP_LOG_DIR = ".ostra/app";

/** An app process's log, relative to the task's folder. Its content is never logged. */
export const appLogPath = (name: string): string => `${APP_LOG_DIR}/${name}.log`;
