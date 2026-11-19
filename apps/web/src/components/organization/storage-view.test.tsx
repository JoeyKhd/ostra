import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { BlobStoreSection, RetentionSection, StorageProperties } from "./storage-view";
import type { Storage } from "./storage-view";
import { canSave, confirmation, draftDays, formatBytes } from "./storage-words";

// F-114, F-079: storage and retention (storage-settings.md), rendered without a browser.

const now = Date.UTC(2026, 10, 19, 12);

const storage: Storage = {
  store: { name: "postgres", health: { status: "ok" }, s3Configured: false },
  blobCount: 1284,
  totalBytes: Math.round(2.31 * 1024 ** 3),
  capBytes: 64 * 1024 ** 2,
  retention: { days: null, source: "default", savedAt: null },
  lastSweep: null,
};

const retention = (data: Storage | undefined, draft: Parameters<typeof RetentionSection>[0]["draft"], saved = false) =>
  renderToStaticMarkup(<RetentionSection storage={data} draft={draft} saved={saved} onDraft={() => undefined} />);

describe("the blob store", () => {
  it("F-114: the store in use, its health, the organization's count and size, the cap and S3", () => {
    const html = renderToStaticMarkup(<BlobStoreSection storage={storage} />);
    expect(html).toContain(t("storage.store.postgres"));
    expect(html).toContain(t("storage.store.healthy"));
    expect(html).toContain("1,284");
    expect(html).toContain("2.31 GiB");
    expect(html).toContain("64 MiB");
    expect(html).toContain(t("storage.store.s3NotConfigured"));
    expect(html).toContain("OSTRA_BLOB_STORE=s3");
  });

  it("with S3 in use, says so and that old blobs stay readable", () => {
    const html = renderToStaticMarkup(<BlobStoreSection storage={{ ...storage, store: { name: "s3", health: { status: "ok" }, s3Configured: true } }} />);
    expect(html).toContain(t("storage.store.s3"));
    expect(html).toContain(t("storage.store.s3InUse"));
    expect(html).toContain(t("storage.store.helpS3"));
  });

  it("an unreachable store is red, with its error as an alert, never amber", () => {
    const html = renderToStaticMarkup(<BlobStoreSection storage={{ ...storage, store: { ...storage.store, health: { status: "down", reason: "connection refused" } } }} />);
    expect(html).toContain(t("storage.store.unreachable"));
    expect(html).toContain('role="alert"');
    expect(html).toContain("connection refused");
    expect(html).not.toContain("amber");
  });

  it("no blobs yet reads 0 and 0 B", () => {
    const html = renderToStaticMarkup(<BlobStoreSection storage={{ ...storage, blobCount: 0, totalBytes: 0 }} />);
    expect(html).toContain(">0<");
    expect(html).toContain("0 B");
  });

  it("loading shows skeletons", () => {
    expect(renderToStaticMarkup(<BlobStoreSection storage={undefined} />)).toContain("animate-pulse");
  });
});

describe("retention", () => {
  it("F-079: off by default: no deletion block", () => {
    const html = retention(storage, { mode: "keep" });
    expect(html).toContain(t("storage.retention.keep"));
    expect(html).not.toContain('data-testid="retention-deletes"');
  });

  it("delete after: says what goes and what stays, with the typed days", () => {
    const html = retention(storage, { mode: "delete", days: "90" });
    expect(html).toContain("more than 90 days ago");
    expect(html).toContain(t("storage.retention.willDelete2"));
    expect(html).toContain("A reopened task says its history was removed.");
  });

  it("an invalid number is refused in words", () => {
    expect(retention(storage, { mode: "delete", days: "0" })).toContain(t("storage.retention.invalid"));
    expect(draftDays({ mode: "delete", days: "3651" })).toBe("invalid");
    expect(draftDays({ mode: "delete", days: "" })).toBe("invalid");
    expect(draftDays({ mode: "delete", days: "3650" })).toBe(3650);
  });

  it("set by OSTRA_RETENTION_DAYS: says saving here overrides it", () => {
    const fromEnv: Storage = { ...storage, retention: { days: 30, source: "env", savedAt: null } };
    expect(retention(fromEnv, { mode: "delete", days: "30" })).toContain(t("storage.retention.fromEnv"));
  });

  it("says Saved. as a status after saving", () => {
    expect(retention(storage, { mode: "keep" }, true)).toContain('role="status"');
  });

  it("enables Save only for a valid change", () => {
    expect(canSave({ mode: "keep" }, null)).toBe(false);
    expect(canSave({ mode: "delete", days: "90" }, null)).toBe(true);
    expect(canSave({ mode: "delete", days: "90" }, 90)).toBe(false);
    expect(canSave({ mode: "keep" }, 90)).toBe(true);
    expect(canSave({ mode: "delete", days: "x" }, null)).toBe(false);
  });

  it("the confirmation says what turning on deletes, or that turning off deletes nothing more", () => {
    expect(confirmation(90)).toEqual({ title: "Delete history after 90 days?", action: "Delete after 90 days", turnsOff: false });
    expect(confirmation(null).title).toBe(t("storage.retention.confirmOffTitle"));
    expect(confirmation(null).turnsOff).toBe(true);
  });
});

describe("the panel", () => {
  it("shows the settings, the sweeps and that retention never changed", () => {
    const html = renderToStaticMarkup(<StorageProperties storage={storage} now={now} />);
    expect(html).toContain("OSTRA_BLOB_STORE");
    expect(html).toContain("postgres");
    expect(html).toContain(t("storage.panel.unset"));
    expect(html).toContain(t("storage.panel.never"));
    expect(html).toContain(t("storage.panel.neverChanged"));
    expect(html).toContain(t("storage.retention.source.default"));
  });

  it("names a saved change and the last sweep", () => {
    const saved: Storage = { ...storage, retention: { days: 90, source: "saved", savedAt: Date.UTC(2026, 10, 12) }, lastSweep: { at: now - 6 * 3_600_000, data: {} } };
    const html = renderToStaticMarkup(<StorageProperties storage={saved} now={now} />);
    expect(html).toContain("Set to 90 days, 12 Nov");
    expect(html).toContain("6h ago");
    expect(html).toContain(t("storage.retention.source.saved"));
  });
});

describe("sizes", () => {
  it("in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812 * 1024 ** 2)).toBe("812 MiB");
    expect(formatBytes(2.31 * 1024 ** 3)).toBe("2.31 GiB");
  });
});
