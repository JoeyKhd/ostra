import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecider } from "../src/lib/acp-driver.ts";
import { insideWorkspace, newScopeTally, shellReach, withinWorkspace, type WorkspaceScope } from "../src/lib/deciders.ts";

type Request = Parameters<PermissionDecider>[0];

const host: WorkspaceScope = { workspace: path.resolve(import.meta.dirname, "..", ".runs", "box", "workspace"), posix: false };
const container: WorkspaceScope = { workspace: "/box/workspace", posix: true };

const request = (toolCall: Request["toolCall"]): Request => ({
  sessionId: "s1",
  toolCall,
  options: [
    { optionId: "yes", kind: "allow_once", name: "Allow" },
    { optionId: "no", kind: "reject_once", name: "Reject" },
  ],
});

const answer = async (scope: WorkspaceScope, toolCall: Request["toolCall"]): Promise<string> => {
  const response = await withinWorkspace(scope)(request(toolCall), new AbortController().signal);
  return response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
};

describe("the workspace-bound decider", () => {
  it("knows inside from outside, for host and container paths", () => {
    expect(insideWorkspace(host, "src/a.ts")).toBe(true);
    expect(insideWorkspace(host, path.join(host.workspace, "docs", "x.md"))).toBe(true);
    expect(insideWorkspace(host, host.workspace)).toBe(true);
    expect(insideWorkspace(host, `${host.workspace}-other`)).toBe(false);
    expect(insideWorkspace(host, "../home/x")).toBe(false);
    expect(insideWorkspace(container, "/box/workspace/src/a.ts")).toBe(true);
    expect(insideWorkspace(container, "/home/ostra/.config")).toBe(false);
    expect(insideWorkspace(container, "/box/workspace/../tmp")).toBe(false);
  });

  it("approves file tools inside the workspace and rejects them outside", async () => {
    expect(await answer(host, { toolCallId: "1", kind: "edit", locations: [{ path: path.join(host.workspace, "src", "a.ts") }] })).toBe("yes");
    expect(await answer(host, { toolCallId: "2", kind: "read", rawInput: { filePath: "README.md" } })).toBe("yes");
    expect(await answer(host, { toolCallId: "3", kind: "read", locations: [{ path: path.resolve(host.workspace, "..", "..", "model.env") }] })).toBe("no");
    expect(await answer(container, { toolCallId: "4", kind: "read", rawInput: { path: "/etc/passwd" } })).toBe("no");
    expect(await answer(host, { toolCallId: "5", kind: "fetch", rawInput: { url: "https://example.com" } })).toBe("no");
  });

  it("reads shell commands for paths outside the workspace", async () => {
    for (const ok of [
      `node -e "console.log('RESULT-'+(Date.now()%100000))"`,
      `node -e "setTimeout(()=>{},300000)" ostra-marker-abc`,
      "git add src/widget.ts",
      "git rm -q old.txt",
      "git log origin/main..HEAD",
      "git diff HEAD~1 2>/dev/null",
    ]) {
      expect(shellReach(container, ok)).toBeUndefined();
      expect(await answer(container, { toolCallId: "s", kind: "execute", rawInput: { command: ok } })).toBe("yes");
    }
    for (const bad of ["cat ~/.config/ostra-dev/model.env", "cat $HOME/x", "cd .. && ls", "cat ../../x", "cat /etc/passwd", "type C:\\Users\\someone\\x.env", "type %USERPROFILE%\\x"]) {
      expect(shellReach(container, bad)).toBeDefined();
      expect(await answer(container, { toolCallId: "s", kind: "execute", rawInput: { command: bad } })).toBe("no");
    }
    expect(shellReach(container, "ls /box/workspace/src")).toBeUndefined();
  });

  it("counts what it approved and rejected", async () => {
    const tally = newScopeTally();
    const decide = withinWorkspace(container, tally);
    await decide(request({ toolCallId: "1", kind: "execute", rawInput: { command: "ls" } }), new AbortController().signal);
    await decide(request({ toolCallId: "2", kind: "execute", rawInput: { command: "cat /etc/hosts" } }), new AbortController().signal);
    expect(tally).toEqual({ allowed: 1, rejected: 1, rejectedKinds: { execute: 1 } });
  });
});
