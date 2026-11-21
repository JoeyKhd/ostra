import { randomBytes } from "node:crypto";
import type { Logger } from "@ostra/adapter-sdk";
import {
  appPictureFailureText,
  appToolRefusal,
  appToolRefusalText,
  attachmentIdSchema,
  attachmentResultText,
  inBoxAppAddress,
  inBoxServiceAddress,
  noBrowserWords,
  RECORD_APP_TOOL,
  runnerLimits,
  TAKE_SCREENSHOT_TOOL,
  viewportPresetSizes,
} from "@ostra/protocol";
import type {
  AppPictureFailure,
  AppToolRefusal,
  AppToolTarget,
  AttachmentId,
  AttachmentKind,
  AttachmentSkipReason,
  BlobId,
  BoxBrowser,
  CommandBody,
  ExecutorKind,
  NoBrowserReason,
  PreviewTarget,
  RecordAppInput,
  TakeScreenshotInput,
  TaskEventOf,
  TaskSpec,
  TaskSpecAppProcess,
  ViewportPreset,
} from "@ostra/protocol";
import type { BoxBrowserHolder } from "../browser/box-browser.ts";
import type { DevToolsClient } from "../browser/devtools-client.ts";
import type { Viewport } from "../browser/page.ts";
import { defaultPictureTiming, recordApp, takeScreenshot } from "../browser/pictures.ts";
import type { PictureFailure, PictureTiming } from "../browser/pictures.ts";
import type { AppProcesses } from "./app-processes.ts";

// The running app's pictures in one box (milestone 8's ticket 13, F-121, ADR 0068): the same code
// on every executor, beside the box's app (`app-processes.ts`) and its browser (`box-browser.ts`).
//
// - **The agent's tools.** `take_screenshot` and `record_app` check the call first (a process the
//   environment lacks, a port below 1024 or one of the box's own, the turn's 20 pictures), then the
//   box's browser (started on first use), then the target: a process is started with those before
//   it in the list and must get ready; a port is opened as it is. The answer names the picture's ID,
//   which a finding may name, or why there's none, in the protocol's words.
// - **After a turn** that changed a repo, with a primary and "Screenshots after each turn" on:
//   what isn't running starts, the primary gets at most the ready check's time, and each route is
//   taken at each width, with the source `after-turn`. Those that can't be taken (the turn's limit,
//   no browser, a primary that didn't get ready, a page that didn't load) go up as one
//   `attachment.skipped` per reason, the thread's note.
// - **A member's screenshot** (`screenshot.take`) is one of a preview's at its path and width, with
//   the member's ID and the request's, and never counts toward the turn's limit; one that fails
//   goes up as `attachment.skipped` with the request's ID.
// - **Each picture** is a blob of the task on the bulk path (`app-screenshot`, a PNG within 8 MiB;
//   `app-recording`, a frame reel within 32 MiB), then `attachment.added` with the browser's name
//   and version. One picture at a time in the box's browser, each in a page of its own.
// - **Never logged:** a caption, a step, a path, an address or a page's words. Log lines carry IDs,
//   kinds, sources, sizes and counts.

/** The events the pictures send, when the server reads them. */
export type PictureEvent = TaskEventOf<"attachment.added"> | TaskEventOf<"attachment.skipped">;

/** A tool's answer, in words for the agent. */
export type ToolText = { readonly text: string; readonly isError: boolean };

export type AppPicturesOptions = {
  readonly browser: BoxBrowserHolder;
  readonly app: AppProcesses;
  readonly spec: TaskSpec;
  /** Where the box runs: a service's address in the box (`host` runs none). */
  readonly executorKind: ExecutorKind;
  /** Uploads a picture as a blob of the task; `null` when it couldn't. Never logged. */
  readonly upload: (kind: AttachmentKind, bytes: Uint8Array) => Promise<BlobId | null>;
  readonly emit: (event: PictureEvent) => Promise<void>;
  readonly logger: Logger;
  readonly timing?: Partial<PictureTiming>;
  /** A new attachment's ID: unique in the task, across its boxes. Default: random. */
  readonly attachmentId?: () => AttachmentId;
};

export type AppPictures = {
  /** `take_screenshot`: the picture's ID, or why there's none. */
  readonly screenshotForTool: (input: TakeScreenshotInput) => Promise<ToolText>;
  /** `record_app`: the recording's ID and what it holds, or why there's none. */
  readonly recordForTool: (input: RecordAppInput) => Promise<ToolText>;
  /** After a turn's work is saved: `changed` when the turn changed a repo. Resolves once its pictures are up, or skipped. */
  readonly afterTurn: (changed: boolean) => Promise<void>;
  /** Whether a member's screenshot names one of the task's previews; `null` when it does, else the reason for the ack. */
  readonly memberRefusal: (body: CommandBody<"screenshot.take">) => string | null;
  /** `screenshot.take`: a member's screenshot of a preview. Resolves once it's up, or skipped. */
  readonly memberScreenshot: (body: CommandBody<"screenshot.take">) => Promise<void>;
  /** A new turn: its pictures count from 0. */
  readonly turnStarted: () => void;
  /** The pictures this turn added. */
  readonly thisTurn: () => number;
};

/** A preset's page: desktop is a mouse's, tablet and phone a finger's (`mobile`). */
const presetViewport = (preset: ViewportPreset): Viewport => ({ ...viewportPresetSizes[preset], mobile: preset !== "desktop" });

/** What a start takes beside its ready check (the port's check, the spawn, the stop of one that timed out). */
const START_SLACK_MS = 15_000;

const newAttachmentId = (): AttachmentId => attachmentIdSchema.parse(`att-${randomBytes(9).toString("base64url")}`);

/** A promise's value, or `null` once `ms` have passed first. The promise carries on either way. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, ms).unref();
    }),
  ]);

/** Where a picture's page goes, and what its event names. */
type Aim = { readonly origin: string; readonly target: PreviewTarget };

type Opened = { readonly client: DevToolsClient; readonly browser: BoxBrowser };

/** A picture's outcome: its attachment's numbers, or why there's none. */
type Taken =
  | { readonly ok: true; readonly attachmentId: AttachmentId; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly failure: AppPictureFailure };

/** The skip reason a failure is noted under. */
const skipReasonOf = (failure: AppPictureFailure): AttachmentSkipReason => {
  switch (failure.code) {
    case "page-failed":
      return "page-failed";
    case "too-large":
      return "too-large";
    case "browser-failed":
    case "upload-failed":
    case "nothing-recorded":
      return "failed";
    default:
      return failure satisfies never;
  }
};

const pictureFailure = (failure: PictureFailure, url: string): AppPictureFailure =>
  failure.code === "page-failed" ? { code: "page-failed", url, detail: failure.detail } : { code: "browser-failed" };

export const createAppPictures = (options: AppPicturesOptions): AppPictures => {
  const log = options.logger.child({ component: "app-pictures" });
  const timing: PictureTiming = { ...defaultPictureTiming, ...options.timing };
  const processes: readonly TaskSpecAppProcess[] = options.spec.environment.appProcesses ?? [];
  const nextId = options.attachmentId ?? newAttachmentId;
  let count = 0;
  /** One picture at a time in the box's browser: a tab of its own each, never more than one of ours open. */
  let chain: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };

  // The box's own ports are `refusePort`'s, checked first; the rest of the rule is the protocol's.
  const context = (): Parameters<typeof appToolRefusal>[1] => ({
    reservedPorts: { "key-proxy": null, "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null },
    processNames: processes.map((process) => process.name),
    previews: options.app.previews(),
    attachmentsThisTurn: count,
    browser: true,
  });

  const openBrowser = async (): Promise<{ readonly ok: true; readonly value: Opened } | { readonly ok: false; readonly reason: NoBrowserReason }> => {
    const opened = await options.browser.open();
    return opened.available ? { ok: true, value: { client: opened.client, browser: opened.browser } } : { ok: false, reason: opened.reason };
  };

  /**
   * A process's start, with those before it in the list (by convention what it needs, such as its
   * API): `null` once it's ready, or when its port answers something the agent started itself
   * (`port-in-use`); else why not, with its log's path.
   */
  const startUpTo = async (name: string, boundMs: number | null): Promise<AppToolRefusal | null> => {
    const index = processes.findIndex((process) => process.name === name);
    const names = processes.slice(0, index + 1).map((process) => process.name);
    const starting = options.app.start(names);
    const views = boundMs === null ? await starting : await within(starting, boundMs);
    const view = views?.find((each) => each.name === name);
    if (view !== undefined && (view.state === "ready" || (view.state === "failed" && view.reason === "port-in-use"))) {
      return null;
    }
    const logPath = view?.logPath ?? options.app.views().find((each) => each.name === name)?.logPath ?? "";
    return { code: "not-ready", name, logPath };
  };

  /** A tool's or a member's target, where the box's browser opens it; a process is started first. */
  const aimAt = async (target: AppToolTarget | PreviewTarget): Promise<{ readonly ok: true; readonly value: Aim } | { readonly ok: false; readonly refusal: AppToolRefusal }> => {
    if ("process" in target) {
      const process = processes.find((each) => each.name === target.process);
      if (process === undefined) {
        return { ok: false, refusal: { code: "unknown-process", name: target.process } };
      }
      const notReady = await startUpTo(process.name, null);
      return notReady === null ? { ok: true, value: { origin: inBoxAppAddress(process.port), target: { process: process.name } } } : { ok: false, refusal: notReady };
    }
    if ("port" in target) {
      const refused = options.app.refusePort(target.port);
      return refused === null ? { ok: true, value: { origin: inBoxAppAddress(target.port), target: { port: target.port } } } : { ok: false, refusal: refused };
    }
    const service = (options.spec.services ?? []).find((each) => each.name === target.service);
    const origin = service === undefined ? null : inBoxServiceAddress({ name: service.name, port: service.port ?? null }, options.executorKind);
    return origin === null ? { ok: false, refusal: { code: "unknown-process", name: target.service } } : { ok: true, value: { origin, target } };
  };

  /** Uploads a picture and sends its event: the attachment, or `upload-failed`. */
  const keep = async (
    opened: Opened,
    picture: {
      readonly kind: AttachmentKind;
      readonly bytes: Uint8Array;
      readonly aim: Aim;
      readonly path: string;
      readonly width: number;
      readonly height: number;
      readonly durationMs: number | null;
      readonly frameCount: number | null;
      readonly caption: string | null;
      readonly source: "agent" | "after-turn" | "member";
      readonly member: { readonly memberId: CommandBody<"screenshot.take">["memberId"]; readonly requestId: CommandBody<"screenshot.take">["requestId"] } | null;
    },
  ): Promise<Taken> => {
    const blobId = await options.upload(picture.kind, picture.bytes);
    if (blobId === null) {
      log.warn("a picture wasn't uploaded", { kind: picture.kind, source: picture.source });
      return { ok: false, failure: { code: "upload-failed" } };
    }
    const attachmentId = nextId();
    await options.emit({
      kind: "attachment.added",
      attachmentId,
      attachmentKind: picture.kind,
      blobId,
      source: picture.source,
      target: picture.aim.target,
      path: picture.path,
      width: picture.width,
      height: picture.height,
      durationMs: picture.durationMs,
      frameCount: picture.frameCount,
      caption: picture.caption,
      browser: opened.browser,
      memberId: picture.member?.memberId ?? null,
      requestId: picture.member?.requestId ?? null,
    });
    // A member's screenshot is the member's: it doesn't count toward the turn's pictures.
    if (picture.source !== "member") {
      count += 1;
    }
    // IDs, kinds and sizes: never the caption, the path or the address.
    log.info("picture taken", {
      taskId: options.spec.taskId,
      attachmentId,
      blobId,
      kind: picture.kind,
      source: picture.source,
      width: picture.width,
      height: picture.height,
      bytes: picture.bytes.length,
      frames: picture.frameCount,
      durationMs: picture.durationMs,
      thisTurn: count,
    });
    return { ok: true, attachmentId, width: picture.width, height: picture.height };
  };

  /** One screenshot of `aim` at `path`, kept: the shared steps of the tool, the after-turn ones and a member's. */
  const screenshot = async (
    opened: Opened,
    input: {
      readonly aim: Aim;
      readonly path: string;
      readonly viewport: Viewport;
      readonly fullPage: boolean;
      readonly caption: string | null;
      readonly source: "agent" | "after-turn" | "member";
      readonly member?: { readonly memberId: CommandBody<"screenshot.take">["memberId"]; readonly requestId: CommandBody<"screenshot.take">["requestId"] };
    },
  ): Promise<Taken> => {
    const url = `${input.aim.origin}${input.path}`;
    const shot = await takeScreenshot(opened.client, { url, viewport: input.viewport, fullPage: input.fullPage }, timing);
    if (!shot.ok) {
      log.info("a screenshot wasn't taken", { source: input.source, code: shot.failure.code });
      return { ok: false, failure: pictureFailure(shot.failure, url) };
    }
    if (shot.value.png.length > runnerLimits.screenshotMaxBytes) {
      log.info("a screenshot wasn't kept", { source: input.source, code: "too-large", bytes: shot.value.png.length });
      return { ok: false, failure: { code: "too-large", kind: "screenshot" } };
    }
    return keep(opened, {
      kind: "screenshot",
      bytes: shot.value.png,
      aim: input.aim,
      path: input.path,
      width: shot.value.width,
      height: shot.value.height,
      durationMs: null,
      frameCount: null,
      caption: input.caption,
      source: input.source,
      member: input.member ?? null,
    });
  };

  const noBrowserText = (reason: NoBrowserReason): ToolText => ({ text: `${appToolRefusalText({ code: "no-browser" })} ${noBrowserWords(reason)}`, isError: true });

  const refusedText = (tool: string, refusal: AppToolRefusal): ToolText => {
    log.info("an app tool refused", { tool, code: refusal.code, thisTurn: count });
    return { text: appToolRefusalText(refusal), isError: true };
  };

  const screenshotForTool = (input: TakeScreenshotInput): Promise<ToolText> =>
    serially(async () => {
      const refused = ("port" in input.target ? options.app.refusePort(input.target.port) : null) ?? appToolRefusal({ tool: TAKE_SCREENSHOT_TOOL, input }, context());
      if (refused !== null) {
        return refusedText(TAKE_SCREENSHOT_TOOL, refused);
      }
      const opened = await openBrowser();
      if (!opened.ok) {
        log.info("an app tool refused", { tool: TAKE_SCREENSHOT_TOOL, code: "no-browser", reason: opened.reason });
        return noBrowserText(opened.reason);
      }
      const aim = await aimAt(input.target);
      if (!aim.ok) {
        return refusedText(TAKE_SCREENSHOT_TOOL, aim.refusal);
      }
      const viewport = input.size === undefined ? presetViewport(input.width ?? "desktop") : { ...input.size, mobile: false };
      const taken = await screenshot(opened.value, {
        aim: aim.value,
        path: input.path ?? "/",
        viewport,
        fullPage: input.fullPage === true,
        caption: input.caption ?? null,
        source: "agent",
      });
      if (!taken.ok) {
        return { text: appPictureFailureText(taken.failure), isError: true };
      }
      return {
        text: attachmentResultText({ attachmentId: taken.attachmentId, kind: "screenshot", width: taken.width, height: taken.height, durationMs: null, frameCount: null }),
        isError: false,
      };
    });

  const recordForTool = (input: RecordAppInput): Promise<ToolText> =>
    serially(async () => {
      const refused = ("port" in input.target ? options.app.refusePort(input.target.port) : null) ?? appToolRefusal({ tool: RECORD_APP_TOOL, input }, context());
      if (refused !== null) {
        return refusedText(RECORD_APP_TOOL, refused);
      }
      const opened = await openBrowser();
      if (!opened.ok) {
        log.info("an app tool refused", { tool: RECORD_APP_TOOL, code: "no-browser", reason: opened.reason });
        return noBrowserText(opened.reason);
      }
      const aim = await aimAt(input.target);
      if (!aim.ok) {
        return refusedText(RECORD_APP_TOOL, aim.refusal);
      }
      const viewport = presetViewport("desktop");
      const maxMs = (input.seconds ?? runnerLimits.recordingMaxSeconds) * 1000;
      const recorded = await recordApp(opened.value.client, { origin: aim.value.origin, viewport, steps: input.steps, maxMs }, timing);
      if (!recorded.ok) {
        const failure: AppPictureFailure =
          recorded.failure.code === "nothing-recorded" ? recorded.failure : pictureFailure(recorded.failure, `${aim.value.origin}/`);
        log.info("a recording wasn't taken", { code: failure.code, steps: input.steps.length });
        return { text: appPictureFailureText(failure), isError: true };
      }
      const { value } = recorded;
      if (value.reel.length > runnerLimits.recordingMaxBytes) {
        return { text: appPictureFailureText({ code: "too-large", kind: "recording" }), isError: true };
      }
      const firstPath = input.steps[0]?.action === "goto" ? input.steps[0].path : "/";
      const taken = await keep(opened.value, {
        kind: "recording",
        bytes: value.reel,
        aim: aim.value,
        path: firstPath,
        width: value.width,
        height: value.height,
        durationMs: value.durationMs,
        frameCount: value.frameCount,
        caption: input.caption ?? null,
        source: "agent",
        member: null,
      });
      if (!taken.ok) {
        return { text: appPictureFailureText(taken.failure), isError: true };
      }
      if (value.failedStep !== null) {
        log.info("a recording ended at a failed step", { attachmentId: taken.attachmentId, step: value.failedStep.number, reason: value.failedStep.reason });
      }
      return {
        text: attachmentResultText({
          attachmentId: taken.attachmentId,
          kind: "recording",
          width: value.width,
          height: value.height,
          durationMs: value.durationMs,
          frameCount: value.frameCount,
          failedStep: value.failedStep,
        }),
        // A recording cut short is still kept: the agent reads which step failed.
        isError: false,
      };
    });

  const skipped = async (source: "after-turn" | "member", reason: AttachmentSkipReason, skippedCount: number, requestId: CommandBody<"screenshot.take">["requestId"] | null): Promise<void> => {
    if (skippedCount <= 0) {
      return;
    }
    log.info("pictures skipped", { taskId: options.spec.taskId, source, reason, count: skippedCount });
    await options.emit({ kind: "attachment.skipped", source, reason, count: skippedCount, requestId });
  };

  const afterTurn = (changed: boolean): Promise<void> =>
    serially(async () => {
      const settings = options.spec.environment.screenshots;
      const primary = processes.find((process) => process.primary);
      if (!changed || settings?.afterTurn !== true || primary === undefined) {
        return;
      }
      const wanted = settings.routes.flatMap((route) => settings.widths.map((width) => ({ route, width })));
      if (count >= runnerLimits.attachmentsPerTurnMax) {
        await skipped("after-turn", "limit-reached", wanted.length, null);
        return;
      }
      const opened = await openBrowser();
      if (!opened.ok) {
        await skipped("after-turn", "no-browser", wanted.length, null);
        return;
      }
      // What isn't running starts, in the list's order; the turn's end waits for the primary at most
      // the ready check's time, and the start's own few seconds, so its failure goes up first.
      const notReady = await startUpTo(primary.name, options.app.readyTimeoutMs + START_SLACK_MS);
      if (notReady !== null) {
        await skipped("after-turn", "not-ready", wanted.length, null);
        return;
      }
      // Those after the primary start behind the pictures, which don't wait for them.
      const after = processes.slice(processes.indexOf(primary) + 1).map((process) => process.name);
      if (after.length > 0) {
        void options.app.start(after).catch(() => undefined);
      }
      const aim: Aim = { origin: inBoxAppAddress(primary.port), target: { process: primary.name } };
      const failures = new Map<AttachmentSkipReason, number>();
      for (const [index, { route, width }] of wanted.entries()) {
        if (count >= runnerLimits.attachmentsPerTurnMax) {
          failures.set("limit-reached", wanted.length - index);
          break;
        }
        const taken = await screenshot(opened.value, { aim, path: route, viewport: presetViewport(width), fullPage: false, caption: null, source: "after-turn" });
        if (!taken.ok) {
          const reason = skipReasonOf(taken.failure);
          failures.set(reason, (failures.get(reason) ?? 0) + 1);
        }
      }
      for (const [reason, skippedCount] of failures) {
        await skipped("after-turn", reason, skippedCount, null);
      }
    });

  const memberRefusal = (body: CommandBody<"screenshot.take">): string | null =>
    options.app.previews().some((item) => item.key === body.key) ? null : "unknown-preview";

  const memberScreenshot = (body: CommandBody<"screenshot.take">): Promise<void> =>
    serially(async () => {
      const item = options.app.previews().find((each) => each.key === body.key);
      if (item === undefined) {
        return;
      }
      const opened = await openBrowser();
      if (!opened.ok) {
        await skipped("member", "no-browser", 1, body.requestId);
        return;
      }
      const aim = await aimAt(item.target);
      if (!aim.ok) {
        await skipped("member", aim.refusal.code === "not-ready" ? "not-ready" : "failed", 1, body.requestId);
        return;
      }
      const taken = await screenshot(opened.value, {
        aim: aim.value,
        path: body.path,
        viewport: presetViewport(body.width),
        fullPage: false,
        caption: null,
        source: "member",
        member: { memberId: body.memberId, requestId: body.requestId },
      });
      if (!taken.ok) {
        await skipped("member", skipReasonOf(taken.failure), 1, body.requestId);
      }
    });

  return {
    screenshotForTool,
    recordForTool,
    afterTurn,
    memberRefusal,
    memberScreenshot,
    turnStarted: () => {
      count = 0;
    },
    thisTurn: () => count,
  };
};
