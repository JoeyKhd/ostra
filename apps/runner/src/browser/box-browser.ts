import type { AdapterResult, BrowserStart } from "@ostra/adapter-sdk";
import type { BoxBrowser, NoBrowserReason } from "@ostra/protocol";
import { createDevToolsClient } from "./devtools-client.ts";
import type { DevToolsClient, DevToolsClientOptions } from "./devtools-client.ts";

// Milestone 8 (ticket 11, F-121, ADR 0068): a box's one browser, as the runner (on `host`) or the
// sidecar (in a box) holds it for the tools of ticket 13 and the view of ticket 18. It starts when
// something first needs it, never with the box, so a task that takes no picture costs no browser;
// it's reported once per box as `app.browser`, its name and version or why there's none; a browser
// that died is started again for the next caller, without a second report; and it ends with the box.

/** What `app.browser` carries: the browser's name and version, or why the box has none. */
export type BoxBrowserReport = ({ readonly available: true } & BoxBrowser) | { readonly available: false; readonly reason: NoBrowserReason };

export type OpenBoxBrowser =
  | { readonly available: true; readonly browser: BoxBrowser; readonly client: DevToolsClient }
  | { readonly available: false; readonly reason: NoBrowserReason };

export type BoxBrowserHolder = {
  /** The box's browser, started on first use, or why there's none. */
  readonly open: () => Promise<OpenBoxBrowser>;
  /** Ends the browser and its profile, if one is running. Later calls to `open` start none. */
  readonly close: () => Promise<void>;
};

export type BoxBrowserOptions = {
  /** The executor's `startBrowser` for this box. */
  readonly start: () => Promise<AdapterResult<BrowserStart>>;
  /** Sends `app.browser`: called once per box, whatever happens after. */
  readonly report: (browser: BoxBrowserReport) => void;
  readonly client?: DevToolsClientOptions;
};

type Held = { readonly opened: OpenBoxBrowser; readonly close: (() => Promise<void>) | null };

export const boxBrowser = (options: BoxBrowserOptions): BoxBrowserHolder => {
  let reported = false;
  let ended = false;
  let current: Promise<Held> | null = null;

  const report = (browser: BoxBrowserReport): void => {
    if (reported) return;
    reported = true;
    options.report(browser);
  };

  const start = async (forget: () => void): Promise<Held> => {
    const started = await options.start();
    if (!started.ok) {
      // No box to start one in (it's stopping, or not ready yet): none now, nothing reported, and
      // the next caller tries again.
      forget();
      return { opened: { available: false, reason: "failed-to-start" }, close: null };
    }
    if (!started.value.available) {
      report({ available: false, reason: started.value.reason });
      // A browser that failed to start may start for the next caller; an image or a machine without one won't.
      if (started.value.reason === "failed-to-start" || started.value.reason === "download-failed") forget();
      return { opened: { available: false, reason: started.value.reason }, close: null };
    }
    const { channel, name, version } = started.value.browser;
    report({ available: true, name, version });
    // Once it's gone, the next caller starts a new one.
    void channel.closed.then(forget);
    return { opened: { available: true, browser: { name, version }, client: createDevToolsClient(channel, options.client) }, close: channel.close };
  };

  return {
    open: async () => {
      if (ended) return { available: false, reason: "failed-to-start" };
      if (current === null) {
        const attempt: Promise<Held> = start(() => {
          if (current === attempt) current = null;
        });
        current = attempt;
      }
      return (await current).opened;
    },
    close: async () => {
      ended = true;
      const running = current;
      current = null;
      const held = await running;
      await held?.close?.();
    },
  };
};
