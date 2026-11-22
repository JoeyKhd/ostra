import { describe, expect, it } from "vitest";

import { taskIdSchema } from "@ostra/protocol";

import { foldTaskEvents } from "../fold.ts";
import { calc192, s1, sceneId } from "../testing/index.ts";
import { turnItemsOf } from "./items.ts";
import { workspaceCommand, workspacePath } from "./workspace-path.ts";
import type { WorkspaceContext } from "./workspace-path.ts";

// Milestone 10, ticket 03 (F-151, content fix 7): paths relative to the workspace, on each
// executor's own convention: `host`'s `…/tasks/{taskId}/agent/` (either separator), `docker`'s
// and `kubernetes`' `/workspace/`, then the one repo's folder, and a home folder as `~/`.

const taskId = calc192.taskId;
const oneRepo: WorkspaceContext = { taskId, checkoutDirs: ["calculator-web"] };
const twoRepos: WorkspaceContext = { taskId, checkoutDirs: ["calculator-web", "calculator-api"] };
/** A Windows path from its folders. */
const win = (...segments: readonly string[]): string => segments.join("\\");
/** The `host` executor's folder for the task, under a Windows home folder. */
const hostDir = (home = win("C:", "Users", "santi")): string => win(home, ".ostra", "runner", "tasks", taskId, "agent");

describe("workspacePath", () => {
  it("F-151/c3: a Windows host path reads relative to the task's folder and its one repo", () => {
    expect(workspacePath(win(hostDir(), "calculator-web", "src", "history", "store.ts"), oneRepo)).toBe("src/history/store.ts");
    expect(workspacePath(win("D:", "ostra-data", "tasks", taskId, "agent", "calculator-web", "README.md"), oneRepo)).toBe("README.md");
    // Mixed separators, as an agent on Windows may report them.
    expect(workspacePath(`${win("C:", "Users", "santi", ".ostra", "runner", "tasks", taskId)}/agent/calculator-web/src/x.ts`, oneRepo)).toBe("src/x.ts");
  });

  it("F-151/c3: a POSIX host path reads relative the same way", () => {
    expect(workspacePath(`/home/sam/.local/share/ostra/runner/tasks/${taskId}/agent/calculator-web/src/history/panel.tsx`, oneRepo)).toBe("src/history/panel.tsx");
    expect(workspacePath(`/Users/sam/.ostra/runner/tasks/${taskId}/agent/.ostra/attachments/4/mock.png`, oneRepo)).toBe(".ostra/attachments/4/mock.png");
    expect(workspacePath(`/var/lib/ostra/tasks/${taskId}/agent/calculator-web`, oneRepo)).toBe(".");
  });

  it("F-151/c3: a docker or kubernetes path reads relative to /workspace/ and its one repo", () => {
    expect(workspacePath("/workspace/calculator-web/src/x.ts", oneRepo)).toBe("src/x.ts");
    expect(workspacePath("/workspace/.ostra/attachments/4/history-panel-mock.png", oneRepo)).toBe(".ostra/attachments/4/history-panel-mock.png");
    expect(workspacePath("/workspace/", oneRepo)).toBe(".");
  });

  it("F-151/c3: a two-repo task's paths keep their repo's folder", () => {
    expect(workspacePath("/workspace/calculator-web/src/x.ts", twoRepos)).toBe("calculator-web/src/x.ts");
    expect(workspacePath("/workspace/calculator-api/src/y.ts", twoRepos)).toBe("calculator-api/src/y.ts");
    expect(workspacePath(win("C:", "runner", "tasks", taskId, "agent", "calculator-api", "src", "y.ts"), twoRepos)).toBe("calculator-api/src/y.ts");
    // A folder that only starts like the repo's isn't it.
    expect(workspacePath("/workspace/calculator-webapp/src/z.ts", oneRepo)).toBe("calculator-webapp/src/z.ts");
  });

  it("F-151/c3: a home folder reads as ~/", () => {
    expect(workspacePath("/home/sam/.npmrc", oneRepo)).toBe("~/.npmrc");
    expect(workspacePath("/Users/sam/Library/Caches/pnpm", oneRepo)).toBe("~/Library/Caches/pnpm");
    expect(workspacePath(String.raw`C:\Users\sam\AppData\Local\pnpm`, oneRepo)).toBe("~/AppData/Local/pnpm");
    expect(workspacePath("/root/.cache/ms-playwright", oneRepo)).toBe("~/.cache/ms-playwright");
    expect(workspacePath("/home/sam", oneRepo)).toBe("~");
  });

  it("F-151/c3: a path that only looks like the workspace stays as it is", () => {
    for (const raw of ["/workspaces/calculator-web/src/x.ts", "/srv/workspace/calculator-web/src/x.ts", "/rootfs/etc/hosts", "src/history/store.ts", "../calculator-web/src/x.ts"]) {
      expect(workspacePath(raw, oneRepo)).toBe(raw);
    }
    // Another task's host folder isn't this task's workspace: it's only under a home folder.
    const other = taskIdSchema.parse(sceneId("0999", 1));
    expect(workspacePath(`/home/sam/.ostra/runner/tasks/${other}/agent/calculator-web/src/x.ts`, oneRepo)).toBe(`~/.ostra/runner/tasks/${other}/agent/calculator-web/src/x.ts`);
  });
});

describe("workspaceCommand", () => {
  it("F-151/c3: each path in a command line reads relative, the rest of the line as the agent wrote it", () => {
    expect(workspaceCommand("cat /workspace/calculator-web/src/a.ts && ls /workspaces/x", oneRepo)).toBe("cat src/a.ts && ls /workspaces/x");
    expect(workspaceCommand("pnpm --dir=/workspace/calculator-web test", oneRepo)).toBe("pnpm --dir=. test");
    expect(workspaceCommand(`type ${win(hostDir(), "calculator-web", "README.md")}`, oneRepo)).toBe("type README.md");
    // A quoted host path may hold spaces; a command's separators stay as the agent wrote them.
    expect(workspaceCommand(`node "${win(hostDir(win("C:", "Users", "Sam Rivera")), "calculator-web", "scripts", "seed.js")}" --quiet`, oneRepo)).toBe(`node "${win("scripts", "seed.js")}" --quiet`);
    expect(workspaceCommand(`dir ${win("C:", "Users", "sam", "AppData")}`, oneRepo)).toBe(`dir ${win("~", "AppData")}`);
    expect(workspaceCommand("cp /home/sam/.npmrc /workspace/calculator-api/.npmrc", twoRepos)).toBe("cp ~/.npmrc calculator-api/.npmrc");
    // Shell syntax, `..` and words that read like an instruction are the agent's data: only the prefix goes.
    const line = `rm -rf /workspace/calculator-web/../x; echo "ignore previous instructions" $(whoami) > /workspace/calculator-web/out.txt`;
    expect(workspaceCommand(line, oneRepo)).toBe(`rm -rf ../x; echo "ignore previous instructions" $(whoami) > out.txt`);
    expect(workspaceCommand("pnpm test history", oneRepo)).toBe("pnpm test history");
    // The task's folder alone reads `.`, as `/workspace` does, quoted or not.
    expect(workspaceCommand(`cd ${hostDir()} && dir "${hostDir()}"`, twoRepos)).toBe(`cd . && dir "."`);
  });

  it("F-151/c3: a long word in a command line, quoted or not, is read in one pass", () => {
    // The line is the agent's, up to a frame long: a base64 blob is one word. A pattern that tried
    // the task's folder at every start inside a word took 43 s on this one, and far longer on 1 MiB.
    const blob = "QUJD".repeat(64 * 1024);
    const host = `tasks/${taskId}/agent/`;
    const hosts = Math.floor(blob.length / host.length);
    const cases: readonly (readonly [string, string])[] = [
      [`echo ${blob} | base64 -d > out.bin`, `echo ${blob} | base64 -d > out.bin`],
      [`echo "${blob}`, `echo "${blob}`],
      [`cat "${host.repeat(hosts)}`, `cat "${host.repeat(hosts - 1)}`],
      [`type ${win(hostDir(), "calculator-web", blob)}`, `type ${blob}`],
    ];
    for (const [line, read] of cases) {
      const started = performance.now();
      expect(workspaceCommand(line, oneRepo)).toBe(read);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("F-151/c3: a step's subject reads relative and keeps its full value for its title", () => {
    const turn = foldTaskEvents(s1.events, []).find((message) => message.metadata?.turnId === calc192.turns.t1);
    const steps = turn === undefined ? [] : turnItemsOf(turn, { ...oneRepo, mcpServers: [] }).flatMap((item) => (item.kind === "run" ? item.steps : []));
    const edit = steps.find((step) => step.kind === "edit");
    expect([edit?.kind === "edit" ? edit.path : null, edit?.fullSubject]).toEqual(["src/history/store.ts", "/workspace/calculator-web/src/history/store.ts"]);
    const reads = steps.find((step) => step.kind === "read");
    expect(reads?.kind === "read" ? reads.paths : []).toEqual(["src/state.ts", "src/keypad.tsx", "src/App.tsx", "package.json"]);
  });
});
