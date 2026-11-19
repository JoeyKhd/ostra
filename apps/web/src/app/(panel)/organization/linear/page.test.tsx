import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { t } from "@/lib/messages";

// Ticket 33, "Decided 2026-11-19": the Linear page is for admins; a member gets `AdminOnly`.

vi.mock("next/navigation", () => ({ usePathname: () => "/organization/linear", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/server/viewer", () => ({ isAdmin: () => Promise.resolve(false) }));
vi.mock("@/components/linear/linear-view", () => ({ LinearView: () => "the admin's view" }));

const { default: LinearPage } = await import("./page");

describe("the Linear page", () => {
  it("F-005: tells a member it's for admins, with no controls", async () => {
    const html = renderToStaticMarkup(await LinearPage());
    expect(html).toContain(t("linear.title"));
    expect(html).toContain(t("common.adminsOnly"));
    expect(html).not.toContain("the admin&#x27;s view");
    expect(html).not.toContain(t("linear.connect.step1.action"));
    expect(html).not.toContain(t("linear.disconnect.action"));
  });
});
