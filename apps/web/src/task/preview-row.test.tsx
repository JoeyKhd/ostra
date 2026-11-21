import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolBody } from "./renderers";
import type { ToolLikePart } from "./task-context";

// Milestone 8 (task-preview.md, "The thread's Preview row"): the agent's `show_preview` call is drawn
// as a Preview row with its label, port and path, and a Show that opens the pane on it; any other
// MCP tool keeps the generic row.

const call = (toolName: string, input: unknown): ToolLikePart => ({ type: "dynamic-tool", toolName, toolCallId: "call-1", state: "output-available", input, output: "shown" });

describe("the thread's Preview row", () => {
  it("show_preview draws Preview, the label and port, the path and a Show that opens the pane there", () => {
    const html = renderToStaticMarkup(<ToolBody part={call("ostra_show_preview", { port: 5173, label: "web", path: "/history" })} />);
    expect(html).toContain(">Preview<");
    expect(html).toContain("web");
    expect(html).toContain(":5173");
    expect(html).toContain("/history");
    expect(html).toContain('href="?pane=preview&amp;preview=port-5173&amp;path=%2Fhistory"');
    expect(html).toContain(">Show<");
  });

  it("another tool, or a show_preview whose input doesn't read, keeps the generic row", () => {
    expect(renderToStaticMarkup(<ToolBody part={call("ostra_take_note", { text: "x" })} />)).not.toContain("show-preview");
    expect(renderToStaticMarkup(<ToolBody part={call("show_preview", { port: "nope" })} />)).not.toContain("show-preview");
  });
});
