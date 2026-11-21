import { z } from "zod";
import type { Cdp, CdpEvent } from "./pipe.ts";

// One page of the browser, attached with a flat session: every command for it carries its sessionId.

const createTargetSchema = z.looseObject({ targetId: z.string() });
const attachSchema = z.looseObject({ sessionId: z.string() });
const evaluateSchema = z.looseObject({
  result: z.looseObject({ type: z.string(), value: z.unknown().optional() }),
  exceptionDetails: z.looseObject({ text: z.string() }).optional(),
});
const screenshotSchema = z.looseObject({ data: z.string() });

export type Viewport = { readonly width: number; readonly height: number; readonly mobile: boolean };

export type Page = {
  readonly sessionId: string;
  readonly targetId: string;
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly onEvent: (method: string, listener: (params: unknown) => void) => () => void;
  readonly setViewport: (viewport: Viewport) => Promise<void>;
  readonly navigate: (url: string, timeoutMs?: number) => Promise<void>;
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly screenshot: (format: "png" | "jpeg", quality?: number) => Promise<Buffer>;
  readonly close: () => Promise<void>;
};

export const openPage = async (cdp: Cdp, viewport: Viewport): Promise<Page> => {
  const { targetId } = createTargetSchema.parse(await cdp.send("Target.createTarget", { url: "about:blank" }));
  const { sessionId } = attachSchema.parse(await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);

  const onEvent = (method: string, listener: (params: unknown) => void) =>
    cdp.onEvent((event: CdpEvent) => {
      if (event.sessionId === sessionId && event.method === method) listener(event.params);
    });

  const setViewport = async (next: Viewport) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: 1,
      mobile: next.mobile,
      screenWidth: next.width,
      screenHeight: next.height,
    });
    await send("Emulation.setTouchEmulationEnabled", { enabled: next.mobile });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await setViewport(viewport);

  const navigate = async (url: string, timeoutMs = 20_000) => {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`load timed out for ${url}`));
      }, timeoutMs);
      const off = onEvent("Page.loadEventFired", () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    await send("Page.navigate", { url });
    await loaded;
  };

  const evaluate = async (expression: string): Promise<unknown> => {
    const reply = evaluateSchema.parse(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
    if (reply.exceptionDetails !== undefined) throw new Error(`evaluate failed: ${reply.exceptionDetails.text}`);
    return reply.result.value;
  };

  const screenshot = async (format: "png" | "jpeg", quality?: number) => {
    const params: Record<string, unknown> = quality === undefined ? { format } : { format, quality };
    const { data } = screenshotSchema.parse(await send("Page.captureScreenshot", params));
    return Buffer.from(data, "base64");
  };

  const close = async () => {
    await cdp.send("Target.closeTarget", { targetId });
  };

  return { sessionId, targetId, send, onEvent, setViewport, navigate, evaluate, screenshot, close };
};
