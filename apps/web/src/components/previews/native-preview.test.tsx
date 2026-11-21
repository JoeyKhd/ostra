import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { previewKeySchema, previewViewIdSchema } from "@ostra/protocol";

import { PreviewsBody } from "@/components/instance/previews-view";
import type { PreviewsBodyProps } from "@/components/instance/previews-view";
import { checkRowsOf, passedCount, PreviewDomainCheckRows, rowAnnouncement } from "@/components/instance/preview-domain-check";
import type { InstancePreviews } from "@/components/instance/preview-domain-check";
import { hostParts, nativeOffered, nativeOfferOf, nativePaneStateOf, paneModeOf, paneStateOf } from "@/components/tasks/preview-pane-state";
import type { NativeView, PreviewList } from "@/components/tasks/preview-pane-state";

import { NATIVE_FRAME_SANDBOX, PreviewFrame } from "./preview-frame";
import { PreviewFramingNotice } from "./preview-framing-notice";
import { viewerOf } from "./viewer-state";

// Milestone 8, ticket 26 (F-144, F-142; preview-native.md, instance-preview-domain.md): the native
// preview's own rules in the panel, each alone. The pane frames the preview host's one-time URL in a
// sandboxed frame; it opens there by default once the preview domain's check passed; the footer says
// why there's no native preview on the HTTP carrier; the framing notice names the header core
// replaced; and Instance › Previews names the record and certificate to add and shows the check's
// rows. The browser spec (`e2e/25-native-preview.spec.ts`) drives them against core's real proxy.

type Listing = Pick<PreviewList, "previews" | "box" | "can" | "native" | "carrier">;

const web = {
  key: previewKeySchema.parse("app-web"),
  target: { process: "web" },
  port: 5173,
  label: "web",
  primary: true,
  path: "/",
  source: "declared",
  sharing: { level: "members", memberIds: [], links: [] },
  watchers: 0,
  framing: null,
} satisfies PreviewList["previews"][number];

const listing = (over: Partial<Listing> = {}): Listing => ({
  previews: [web],
  box: "running",
  can: { stream: true, tunnel: true, native: true },
  native: "passed",
  carrier: "websocket",
  ...over,
});

const words = { failed: (reason: string) => `failed: ${reason}` };

describe("the native frame (ticket 26)", () => {
  it("F-144/c1: frames the preview host's one-time URL, sandboxed to run the app and never to move the panel", () => {
    const url = "https://5173-k3f9d2abcdefghijklmnopqrst.preview.acme.dev/.ostra/enter?code=abc&path=%2Fhistory";
    const html = renderToStaticMarkup(<PreviewFrame mode="native" host="5173-k3f9d2abcdefghijklmnopqrst.preview.acme.dev" enterUrl={url} name="web :5173 at /history, in your browser" onLoad={() => undefined} />);
    expect(html).toContain(`src="${url.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(`sandbox="${NATIVE_FRAME_SANDBOX}"`);
    expect(NATIVE_FRAME_SANDBOX.split(" ").sort()).toEqual(["allow-downloads", "allow-forms", "allow-modals", "allow-popups", "allow-same-origin", "allow-scripts"]);
    expect(html).not.toContain("allow-top-navigation");
    expect(html).toContain('title="web :5173 at /history, in your browser"');
    expect(html).toContain('data-mode="native"');
    // No canvas, no input relay: the member's own browser runs the app.
    expect(html).not.toContain("preview-canvas");
  });
});

describe("the pane's view (ticket 26)", () => {
  it("F-144/c1: opens in your browser by default once the preview domain's check passed; the address and the member's own choice win", () => {
    expect(nativeOffered(listing())).toBe(true);
    expect(paneModeOf(true, null, null)).toBe("native");
    expect(paneModeOf(true, null, "stream")).toBe("stream");
    expect(paneModeOf(true, "stream", "native")).toBe("stream");
    expect(paneModeOf(true, "native", "stream")).toBe("native");
    expect(paneModeOf(true, "nonsense", null)).toBe("native");
  });

  it("F-144/c2: without a working preview domain the pane keeps the box's browser, whatever the address or the choice says", () => {
    for (const native of ["not-set", "unchecked", "failing"] as const) {
      expect(nativeOffered(listing({ native }))).toBe(false);
    }
    // A box whose runner can't tunnel (`can.native` false), and a runner that can't preview at all.
    expect(nativeOffered(listing({ can: { stream: true, tunnel: false, native: false } }))).toBe(false);
    expect(nativeOffered(listing({ can: { refused: "runner-needs-upgrade" } }))).toBe(false);
    expect(paneModeOf(false, "native", "native")).toBe("stream");
  });

  it("F-144/c1: signs in until the frame loads the preview host, then it's live; a refusal or a 10 s wait is a failure with its words; the box decides first", () => {
    const state = (view: NativeView, over: Partial<Listing> = {}) => nativePaneStateOf(listing(over), "running", view, words);
    expect(state({ kind: "idle" })).toEqual({ kind: "signing-in" });
    expect(state({ kind: "entering" })).toEqual({ kind: "signing-in" });
    expect(state({ kind: "framed", url: "https://x/.ostra/enter?code=1", host: "x", loaded: false })).toEqual({ kind: "signing-in" });
    expect(state({ kind: "framed", url: "https://x/.ostra/enter?code=1", host: "x", loaded: true })).toEqual({ kind: "live" });
    expect(state({ kind: "failed", reason: "timeout" })).toEqual({ kind: "native-failed", words: "failed: timeout" });
    expect(state({ kind: "failed", reason: "watch-only" })).toEqual({ kind: "native-failed", words: "failed: watch-only" });
    // The box first, as in the stream: asleep, starting, nothing to preview.
    expect(state({ kind: "framed", url: "u", host: "x", loaded: true }, { box: "stopped" })).toEqual({ kind: "stopped", asleep: true });
    expect(state({ kind: "entering" }, { box: "starting" })).toEqual({ kind: "starting" });
    expect(state({ kind: "entering" }, { previews: [] })).toEqual({ kind: "none" });
    // A box with no browser still shows the native preview; the stream refuses it.
    const noBrowser = { can: { stream: false, tunnel: true, native: true } } as const;
    expect(state({ kind: "framed", url: "u", host: "x", loaded: true }, noBrowser)).toEqual({ kind: "live" });
    expect(paneStateOf(listing(noBrowser), "running", { kind: "idle" }, { failed: () => "" })).toEqual({ kind: "too-old", reason: "runner-cannot-preview" });
  });

  it("F-144/c9: in the box's browser, the footer offers the native preview once it works, says why not on the HTTP carrier, and sends an instance admin to its settings while the check fails", () => {
    expect(nativeOfferOf(listing(), false)).toEqual({ kind: "open-here" });
    expect(nativeOfferOf(listing({ carrier: "http", can: { stream: true, tunnel: false, native: false } }), false)).toEqual({ kind: "http-only" });
    expect(nativeOfferOf(listing({ native: "failing" }), true)).toEqual({ kind: "settings" });
    expect(nativeOfferOf(listing({ native: "unchecked" }), true)).toEqual({ kind: "settings" });
    expect(nativeOfferOf(listing({ native: "failing" }), false)).toEqual({ kind: "none" });
    expect(nativeOfferOf(listing({ native: "not-set" }), true)).toEqual({ kind: "none" });
    expect(nativeOfferOf(listing({ box: "stopped" }), true)).toEqual({ kind: "none" });
  });

  it("F-144/c1: the footer's host is cut in its middle: the preview's own part shrinks, the domain stays whole", () => {
    expect(hostParts("5173-k3f9d2abcdefghijklmnopqrst.preview.acme.dev")).toEqual({ head: "5173-k3f9d2abcdefghijklmnopqrst", tail: ".preview.acme.dev" });
    expect(hostParts("5173-k3f9d2.preview.localhost:3102")).toEqual({ head: "5173-k3f9d2", tail: ".preview.localhost:3102" });
    expect(hostParts("localhost")).toEqual({ head: "localhost", tail: "" });
  });
});

describe("the framing notice (ticket 26)", () => {
  it("F-144/c4: names the framing header core replaced, with its value in the line's title, and a dismiss", () => {
    const xfo = renderToStaticMarkup(<PreviewFramingNotice label="web" framing={{ header: "x-frame-options", value: "DENY" }} onDismiss={() => undefined} />);
    expect(xfo).toContain("web sent ");
    expect(xfo).toContain(">X-Frame-Options</span>. ostra replaced it: only this panel can frame the preview.");
    expect(xfo).toContain('title="web sent X-Frame-Options: DENY. ostra replaced it: only this panel can frame the preview."');
    expect(xfo).toContain('aria-label="Dismiss"');
    const ancestors = renderToStaticMarkup(<PreviewFramingNotice label="web" framing={{ header: "frame-ancestors", value: "frame-ancestors 'none'" }} onDismiss={() => undefined} />);
    expect(ancestors).toContain(">frame-ancestors</span> policy. ostra replaced it");
  });
});

describe("the viewer page (ticket 26)", () => {
  it("F-142/c1: a link that allows input, where the native preview works, frames the preview host; a watch-only link streams", () => {
    const shown = { label: "web", port: 5173, organizationName: "Acme Corp", expiresAt: null };
    expect(viewerOf({ state: "native", ...shown, input: true, url: "https://h/.ostra/enter?code=1", origin: "https://h", host: "h" })).toEqual({
      kind: "native",
      url: "https://h/.ostra/enter?code=1",
      host: "h",
      attempt: 0,
      shown: { ...shown, input: true },
    });
    const viewId = previewViewIdSchema.parse("0196f2d1-0000-7000-8000-000000000001");
    expect(viewerOf({ state: "live", ...shown, input: false, viewId })).toMatchObject({ kind: "live", viewId });
  });
});

// ---------- Instance › Previews ----------

const checked = (over: Partial<Extract<InstancePreviews["status"], { readonly state: "checked" }>["check"]> = {}) => ({
  state: "checked" as const,
  name: "ostra-check-0a1b2c3d4e5f.preview.acme.dev",
  at: Date.UTC(2026, 10, 21, 14, 32),
  dns: { state: "failed" as const, reason: "ostra-check-0a1b2c3d4e5f.preview.acme.dev doesn't resolve." },
  certificate: { state: "skipped" as const, needs: "Not checked: it needs the DNS record." },
  proxy: { state: "skipped" as const, needs: "Not checked: it needs the certificate." },
  upgrade: { state: "skipped" as const, needs: "Not checked: it needs the certificate." },
  passed: false,
  ...over,
});

const page = (over: Partial<InstancePreviews> = {}): InstancePreviews => ({
  domain: "preview.acme.dev",
  defaulted: false,
  localhost: false,
  panelHost: "ostra.acme.dev",
  coreHost: "core.acme.dev",
  sharedSite: "acme.dev",
  sameSite: "lax",
  record: { name: "*.preview.acme.dev", type: "CNAME", value: "core.acme.dev" },
  exampleHost: null,
  status: { state: "checked", domain: "preview.acme.dev", check: checked(), at: Date.UTC(2026, 10, 21, 14, 32), byName: "Alex Kim", passed: false },
  organization: { name: "Acme Corp", admin: true, publicPreviewLinks: false },
  linkMaxDays: 7,
  docs: "https://ostra.dev/docs/install/preview-domain/",
  ...over,
});

const body = (data: InstancePreviews, over: Partial<PreviewsBodyProps> = {}): string =>
  renderToStaticMarkup(<PreviewsBody data={data} checking={false} checkError={null} onCheck={() => undefined} publicLinks={<span data-testid="public-links-stub" />} {...over} />);

describe("Instance › Previews (ticket 26)", () => {
  it("F-144/c8: with a domain, names the one DNS record and the wildcard certificate to add, and warns, never blocking, on the panel's own site", () => {
    const html = body(page());
    expect(html).toContain("OSTRA_PREVIEW_DOMAIN");
    expect(html).toContain(">preview.acme.dev<");
    expect(html).toMatch(/data-testid="preview-dns-record"[^>]*>.*\*\.preview\.acme\.dev.*CNAME.*core\.acme\.dev/);
    expect(html).toContain('data-copy="*.preview.acme.dev CNAME core.acme.dev"');
    expect(html).toContain("A wildcard certificate for ");
    expect(html).toContain("Let&#x27;s Encrypt issues one only through DNS-01");
    expect(html).toContain("WebSocket upgrades on those hosts");
    expect(html).toContain('data-testid="preview-domain-warning"');
    expect(html).toContain(" is on the panel&#x27;s own site, ");
    expect(html).toContain("acme-preview.dev");
    // A domain of its own: no warning. Core on an IP: an A record.
    const own = body(page({ domain: "acme-preview.dev", sharedSite: null, sameSite: "none-partitioned", record: { name: "*.acme-preview.dev", type: "A", value: "203.0.113.24" } }));
    expect(own).not.toContain("preview-domain-warning");
    expect(own).toContain('data-copy="*.acme-preview.dev A 203.0.113.24"');
  });

  it("F-144/c8: the check's rows: a missing record failed first, the rows after it not run, and the line says who checked and that previews stream until it passes", () => {
    const html = body(page());
    expect(html).toContain('data-row="dns" data-state="failed"');
    expect(html).toContain('data-row="certificate" data-state="skipped"');
    expect(html).toContain('data-row="proxy" data-state="skipped"');
    expect(html).toContain('data-row="upgrade" data-state="skipped"');
    expect(html).toContain("doesn&#x27;t resolve.");
    expect(html).toMatch(/Checked at \d\d:\d\d by Alex Kim\. Until it passes, previews stream from the box&#x27;s browser\./);
    expect(html).toContain("Check again");
    // While it runs, every row spins and the button says so; never checked, a plain `Check`.
    expect(body(page(), { checking: true })).toContain("Checking…");
    expect(body(page({ status: { state: "unchecked", domain: "preview.acme.dev" } }))).toMatch(/data-action="preview-check"[^>]*>.*Check</);
  });

  it("F-144/c8: each row's result is announced, and the rows not needed under localhost count as passed", () => {
    const status = page().status;
    const rows = checkRowsOf(status, false);
    expect(rows.map(({ id, row }) => [id, row.state])).toEqual([["dns", "failed"], ["certificate", "skipped"], ["proxy", "skipped"], ["upgrade", "skipped"]]);
    expect(rowAnnouncement("dns", rows[0]?.row ?? { state: "running" })).toBe("DNS record: failed. ostra-check-0a1b2c3d4e5f.preview.acme.dev doesn't resolve.");
    expect(checkRowsOf(status, true).every(({ row }) => row.state === "running")).toBe(true);
    const local = checked({
      dns: { state: "not-needed", detail: "Not needed for preview.localhost." },
      certificate: { state: "not-needed", detail: "Not needed for preview.localhost." },
      proxy: { state: "passed", detail: "Core's preview proxy answered." },
      upgrade: { state: "passed", detail: "An upgrade went through." },
      passed: true,
    });
    expect(passedCount(local)).toBe(4);
    expect(passedCount(checked())).toBe(0);
    const html = renderToStaticMarkup(<PreviewDomainCheckRows rows={checkRowsOf({ state: "checked", domain: "preview.localhost", check: local, at: local.at, byName: null, passed: true }, false)} />);
    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(4);
  });

  it("F-144/c2: with no domain, says what works without it and the four steps to turn it on, preview.localhost included, and no check", () => {
    const html = body(page({ domain: null, localhost: false, sharedSite: null, sameSite: null, record: null, status: { state: "not-set" } }));
    expect(html).toContain("not set");
    expect(html).toContain("Previews work without it");
    for (const step of ["Pick a domain of its own", "Add one DNS record", "Get a wildcard certificate, and pass WebSocket upgrades", "Set the domain, restart core, and check it here"]) {
      expect(html).toContain(step);
    }
    expect(html).toContain('data-copy="*.acme-preview.dev CNAME core.acme.dev"');
    expect(html).toContain('data-copy="OSTRA_PREVIEW_DOMAIN=acme-preview.dev"');
    expect(html).toContain("preview.localhost");
    expect(html).not.toContain('data-testid="preview-domain-check"');
    expect(html).toContain('data-testid="public-links-stub"');
  });

  it("F-144/c10: a one-machine install's preview.localhost says it's the default, checked by core at its start, and how to turn it off; a set domain doesn't", () => {
    const local = { domain: "preview.localhost", localhost: true, sharedSite: null, sameSite: "none-partitioned", record: null } as const;
    const html = body(page({ ...local, defaulted: true }));
    expect(html).toContain('data-testid="preview-domain-default"');
    expect(html).toMatch(/data-testid="preview-domain-default"[^>]*>The setting is unset, and the panel and core are on this machine, so previews use <span[^>]*>preview\.localhost<\/span> by default, and core checks it when it starts\. <span[^>]*>OSTRA_PREVIEW_DOMAIN=off<\/span> turns it off\./);
    expect(body(page({ ...local, defaulted: false }))).not.toContain("preview-domain-default");
    expect(body(page())).not.toContain("preview-domain-default");
  });
});
