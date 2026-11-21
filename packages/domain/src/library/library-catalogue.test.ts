import { libraryItemIdSchema, organizationIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { auditActions, isAuditAction } from "../audit/actions.ts";
import { jobKey, jobSending, libraryUpdateWindowStart, parseJobPayload } from "../jobs.ts";
import { parseServerSettings, SKILLS_SEARCH_URL } from "../settings.ts";

// Milestone 8 (ticket 06): the library's settings, jobs and audit actions.

const organizationId = organizationIdSchema.parse("org-1");
const itemId = libraryItemIdSchema.parse("item-1");

describe("the library's settings", () => {
  it("F-145, F-146: each has its working default with only the required settings set", () => {
    const parsed = parseServerSettings({});
    expect(parsed.ok && parsed.settings.library).toEqual({ updateHours: 24, marketplaceSearch: true, skillsSearchUrl: SKILLS_SEARCH_URL });
    expect(SKILLS_SEARCH_URL).toBe("https://skills.sh/api/search");
  });

  it("F-146: takes the install's switch off, another hour count and another search address, and refuses what isn't one", () => {
    const other = parseServerSettings({ OSTRA_MARKETPLACE_SEARCH: "false", OSTRA_LIBRARY_UPDATE_HOURS: "6", OSTRA_SKILLS_SEARCH_URL: "https://search.acme.dev/api" });
    expect(other.ok && other.settings.library).toEqual({ updateHours: 6, marketplaceSearch: false, skillsSearchUrl: "https://search.acme.dev/api" });
    expect(parseServerSettings({ OSTRA_LIBRARY_UPDATE_HOURS: "0" }).ok).toBe(false);
    expect(parseServerSettings({ OSTRA_LIBRARY_UPDATE_HOURS: "1.5" }).ok).toBe(false);
    expect(parseServerSettings({ OSTRA_SKILLS_SEARCH_URL: "skills.sh" }).ok).toBe(false);
    expect(parseServerSettings({ OSTRA_MARKETPLACE_SEARCH: "maybe" }).ok).toBe(false);
  });
});

describe("the library's jobs", () => {
  it("F-145: keys the update check by the organization and its window, or by the item an admin checks, and the seeding by the organization", () => {
    const day = Date.UTC(2026, 10, 21);
    const windowStart = libraryUpdateWindowStart(day + 5 * 3_600_000, 24);
    expect(windowStart).toBe(day);
    expect(libraryUpdateWindowStart(day + 5 * 3_600_000, 6)).toBe(day);
    expect(libraryUpdateWindowStart(day + 7 * 3_600_000, 6)).toBe(day + 6 * 3_600_000);
    expect(jobKey("library.check-updates", { organizationId, windowStart })).toBe(`organization:org-1:library-check-updates:${String(day)}`);
    expect(jobKey("library.check-updates", { organizationId, itemId })).toBe("library-item:item-1:check-updates");
    expect(jobKey("library.seed-sources", { organizationId })).toBe("organization:org-1:library-seed-sources");
    expect(jobSending["library.check-updates"]).toEqual({ kind: "event" });
  });

  it("F-145: carries IDs only: a payload with anything else is refused", () => {
    expect(parseJobPayload("library.check-updates", { organizationId, itemId }).ok).toBe(true);
    expect(parseJobPayload("library.check-updates", { organizationId, windowStart: 1 }).ok).toBe(true);
    expect(parseJobPayload("library.check-updates", { organizationId, itemId, reference: "acme/skills" }).ok).toBe(false);
    expect(parseJobPayload("library.check-updates", { organizationId }).ok).toBe(false);
    expect(parseJobPayload("library.seed-sources", { organizationId, registry: "https://api.mcp.github.com" }).ok).toBe(false);
  });
});

describe("the library's audit actions", () => {
  it("F-145: names every library change and the two switches, each by its entity", () => {
    expect(
      Object.entries(auditActions)
        .filter(([action]) => action.startsWith("library.") || action.startsWith("organization.marketplace") || action.startsWith("organization.public_preview"))
        .sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual([
      ["library.attached", "library-item"],
      ["library.detached", "library-item"],
      ["library.every_profile_changed", "library-item"],
      ["library.installed", "library-item"],
      ["library.read_only_changed", "library-item"],
      ["library.removed", "library-item"],
      ["library.source_added", "library-source"],
      ["library.source_removed", "library-source"],
      ["library.suggestion_decided", "library-suggestion"],
      ["library.update_accepted", "library-item"],
      ["library.update_dismissed", "library-item"],
      ["organization.marketplace_search_changed", "organization"],
      ["organization.public_preview_links_changed", "organization"],
    ]);
    expect(isAuditAction("library.updated")).toBe(false);
  });
});
