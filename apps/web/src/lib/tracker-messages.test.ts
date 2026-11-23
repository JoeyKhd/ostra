import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Milestone 11, ticket 14 (F-152/c1, F-008): each tracker's words live under its connection, so
// `linear.*` and `agentMode.*` have no place at the file's top level any more, and Jira's settings
// have their own group. A key left at the old place fails here, and the moved key is named.

const file = path.resolve(import.meta.dirname, "..", "..", "messages", "en.json");
const messages = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));

const trackers = z.record(z.string(), z.unknown()).parse(messages["trackers"]);

/** Whether a dotted key in the file holds a string. */
const has = (root: unknown, key: string): boolean => {
  let node: unknown = root;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = Reflect.get(node, segment);
  }
  return typeof node === "string";
};

describe("each tracker connection's words", () => {
  it("F-152/c1: Linear's and agent mode's words live under trackers.linear, and nothing is left at the top level", () => {
    expect(Object.hasOwn(messages, "linear")).toBe(false);
    expect(Object.hasOwn(messages, "agentMode")).toBe(false);
    expect(has(trackers, "linear.lede")).toBe(true);
    expect(has(trackers, "linear.connect.title")).toBe(true);
    expect(has(trackers, "linear.agentMode.title")).toBe(true);
    expect(has(trackers, "linear.agentMode.panel.sessions")).toBe(true);
    // Agent mode is Linear's alone, and it says so.
    expect(has(trackers, "linear.agentMode.linearOnly")).toBe(true);
  });

  it("F-008: Jira's settings have their own group, and no top-level tracker words are left behind", () => {
    expect(has(trackers, "jira.settings.events.title")).toBe(true);
    expect(has(trackers, "jira.settings.token.reaches")).toBe(true);
    expect(has(trackers, "jira.settings.disconnect.confirmTitle")).toBe(true);
    expect(has(trackers, "jira.settings.panel.cloudId")).toBe(true);
    // Jira has no agent sessions, so it gets no agent-mode group (choice 11).
    expect(has(trackers, "jira.settings.agentMode")).toBe(false);
  });
});
