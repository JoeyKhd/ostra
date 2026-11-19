import { describe, expect, it } from "vitest";

import { followedBy, keyLogoPath } from "@/components/models/keys-words";
import { keysText, matchesQuery, noKeyText, sortOptions } from "@/components/agent-profiles/model-picker-words";
import { adminNames } from "@/components/tasks/no-key-words";

import { followDescription, listChanged, listMark, savedLine, whatHappens } from "./project-models-words";

// F-135 (ticket 53): the words of keys per project, on Models, a project's Models and keys, the
// profile's model picker and "no key".

describe("keys per project, in words", () => {
  it("F-135: a project's list marks what was ticked or unticked against the saved one, and knows when it changed", () => {
    const saved = new Set(["a", "b"]);
    const draft = new Set(["b", "c"]);
    expect([listMark("a", saved, draft), listMark("b", saved, draft), listMark("c", saved, draft)]).toEqual(["removed", null, "added"]);
    expect(listChanged({ own: true, ids: saved }, { own: true, ids: new Set(["b", "a"]) })).toBe(false);
    expect(listChanged({ own: true, ids: saved }, { own: true, ids: draft })).toBe(true);
    expect(listChanged({ own: false, ids: saved }, { own: true, ids: saved })).toBe(true);
    // Following the default: which keys were ticked before doesn't matter.
    expect(listChanged({ own: false, ids: saved }, { own: false, ids: draft })).toBe(false);
  });

  it("F-135: the follow row names the default's keys, the preview says what happens, the save what moved", () => {
    expect(followDescription(["acme-anthropic"])).toBe("Today: acme-anthropic.");
    expect(followDescription([])).toBe("Today: no key.");
    expect(whatHappens({ boxes: 1, providerNames: ["globex-openrouter"] }, [{ model: "Kimi K3.1 Pro", tasks: 2 }])).toBe(
      "1 idle box holding globex-openrouter's key is released now. 2 tasks using Kimi K3.1 Pro wait queued until an organization admin picks a key.",
    );
    expect(whatHappens({ boxes: 0, providerNames: [] }, [{ model: "Kimi K3.1 Pro", tasks: 0 }])).toBeNull();
    expect(savedLine(1, 1)).toBe("Saved. 1 model moved, 1 has no key.");
    expect(savedLine(0, 0)).toBe("Saved.");
  });

  it("F-135: the default list names its followers, past four the first three and how many more", () => {
    expect(followedBy([])).toEqual({ lead: "Followed by no project.", names: [], more: null });
    expect(followedBy(["a", "b", "c"])).toEqual({ lead: "Followed by 3 projects:", names: ["a", "b", "c"], more: null });
    expect(followedBy(["a", "b", "c", "d", "e"])).toEqual({ lead: "Followed by 5 projects:", names: ["a", "b", "c"], more: "and 2 more" });
    expect(keyLogoPath("api.anthropic.com")).toBe("/model-logos/anthropic.svg");
    expect(keyLogoPath("models.acme.internal")).toBeNull();
  });

  it("F-135: the model picker lists every project served first, says where no key serves it, and names at most two keys", () => {
    const option = (name: string, projectsWithout: readonly string[]) => ({ displayName: name, text: `x/${name.toLowerCase()}`, projectsWithout });
    expect(sortOptions([option("Zed", []), option("Alpha", ["p"]), option("Beta", [])]).map((row) => row.displayName)).toEqual(["Beta", "Zed", "Alpha"]);
    expect(matchesQuery(option("Claude Sonnet", []), "x/claude")).toBe(true);
    expect(matchesQuery(option("Claude Sonnet", []), "gpt")).toBe(false);
    expect(keysText(["a", "b", "c", "d"])).toBe("a, b +2");
    expect(noKeyText([])).toBeNull();
    expect(noKeyText(["globex-shop"])).toBe("No key in globex-shop");
    expect(noKeyText(["a", "b", "c"])).toBe("No key in 3 projects");
  });

  it("F-135: who can fix a missing key is named by name, never by address", () => {
    expect(adminNames(["Alex Kim", "Priya Nair"])).toBe("Organization admins: Alex Kim, Priya Nair.");
    expect(adminNames(["Alex Kim", "Priya Nair", "Dana Ortiz"])).toBe("Organization admins: Alex Kim, Priya Nair and Dana Ortiz.");
  });
});
