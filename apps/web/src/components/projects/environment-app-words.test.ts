import { describe, expect, it } from "vitest";

import { appProcessListIssues, appProcessSchema } from "@ostra/domain/app-processes";
import { repoIdSchema } from "@ostra/protocol";

import { addressRows, emptyForm, formOf, issuesFromRules, lastBoxWords, listWith, processFormIssues, processOf, readyWords, whereText } from "./environment-app-words";
import type { ProcessForm, SavedProcess } from "./environment-app-words";

// Milestone 8's ticket 17 (F-140): the App tab's editor checks a process as the API's `save` does,
// with the same schema and list rules, so what the sheet refuses is what the API refuses.

const repo = repoIdSchema.parse("0196f1a0-0000-7000-8000-0000000000a1");
const otherRepo = repoIdSchema.parse("0196f1a0-0000-7000-8000-0000000000a2");

const web: SavedProcess = { name: "web", repoId: repo, folder: ".", command: "pnpm dev", port: 5173, ready: { kind: "http", path: "/" }, label: "Web", primary: true, hostRewrite: true };
const api: SavedProcess = { name: "api", repoId: repo, folder: "api", command: "pnpm start:dev", port: 3001, ready: { kind: "http", path: "/health" }, label: "API", primary: false, hostRewrite: true };

const good: ProcessForm = formOf(api);

/** Whether the API's own checks refuse the process in the list: its schema, then the list's rules. */
const apiRefuses = (form: ProcessForm, others: readonly SavedProcess[]): boolean => {
  const parsed = appProcessSchema.safeParse(processOf(form));
  if (!parsed.success) return true;
  const list = [...others.map((other) => (parsed.data.primary ? { ...other, primary: false } : other)), parsed.data];
  return appProcessListIssues(list, [repo]).length > 0;
};

describe("the App tab's editor (F-140)", () => {
  it("F-140/c2: each field the API refuses is refused in the sheet under its field, in words, and what the API takes the sheet takes", () => {
    const cases: readonly { readonly form: ProcessForm; readonly field: keyof ReturnType<typeof processFormIssues> | null; readonly words: string | null }[] = [
      { form: good, field: null, words: null },
      { form: { ...good, name: "My API" }, field: "name", words: "Lowercase letters, digits and dashes only." },
      { form: { ...good, label: " " }, field: "label", words: "Give it a label people see in the pane." },
      { form: { ...good, folder: "../outside" }, field: "folder", words: "A folder inside the repo, such as apps/web." },
      { form: { ...good, folder: "/etc" }, field: "folder", words: "A folder inside the repo, such as apps/web." },
      { form: { ...good, command: "   " }, field: "command", words: "Give it a command that starts the app." },
      { form: { ...good, port: "80" }, field: "port", words: "Ports below 1024 can't be previewed." },
      { form: { ...good, port: "70000" }, field: "port", words: "A port from 1024 to 65535." },
      { form: { ...good, port: "abc" }, field: "port", words: "A port from 1024 to 65535." },
      { form: { ...good, readyKind: "http", readyPath: "health" }, field: "ready", words: "A path starts with /, such as /health." },
      { form: { ...good, readyKind: "command", readyCommand: " " }, field: "ready", words: "Give the check a command." },
      { form: { ...good, readyKind: "port" }, field: null, words: null },
    ];
    for (const { form, field, words } of cases) {
      const issues = processFormIssues(form, [web], [repo]);
      expect(Object.keys(issues).length > 0).toBe(apiRefuses(form, [web]));
      expect(field === null ? issues : issues[field]).toEqual(field === null ? {} : words);
    }
  });

  it("F-140/c2: a rule the list breaks is refused in the API's own words, for the field it's about", () => {
    const sameName = processFormIssues({ ...good, name: "web" }, [web], [repo]);
    expect(sameName.name).toBe("Two app processes are named web: each name is used once.");
    const samePort = processFormIssues({ ...good, port: "5173" }, [web], [repo]);
    expect(samePort.port).toBe("Two app processes listen on port 5173: each port is used once.");
    const reserved = processFormIssues({ ...good, port: "7101" }, [web], [repo]);
    expect(reserved.port).toBe("Port 7101 is kept by the box itself: pick another for the app.");
    const unknownRepo = processFormIssues({ ...good, repoId: otherRepo }, [web], [repo]);
    expect(unknownRepo.repo).toBe("The app process api names a repo this project doesn't have.");
    for (const form of [{ ...good, name: "web" }, { ...good, port: "5173" }, { ...good, port: "7101" }]) expect(apiRefuses(form, [web])).toBe(true);
    // The rules the API's save sends back land on the same fields.
    expect(issuesFromRules([{ rule: "unique-name", message: "n" }, { rule: "unique-port", message: "p" }, { rule: "reserved-port", message: "r" }, { rule: "one-primary", message: "o" }])).toEqual({ name: "n", port: "p" });
  });

  it("F-140/c1,c2: a saved process keeps its place in the start order, a new one goes last, and turning the primary on moves it there", () => {
    expect(listWith([web, api], { ...api, command: "pnpm dev:api" }, "api").map((process) => [process.name, process.command])).toEqual([
      ["web", "pnpm dev"],
      ["api", "pnpm dev:api"],
    ]);
    const docs: SavedProcess = { ...api, name: "docs", port: 4000, primary: true };
    expect(listWith([web, api], docs, null).map((process) => [process.name, process.primary])).toEqual([
      ["web", false],
      ["api", false],
      ["docs", true],
    ]);
    // A second primary is never sent: the sheet's primary moves it, as the API's rule wants.
    expect(processFormIssues({ ...formOf(docs) }, [web, api], [repo])).toEqual({});
    expect(appProcessListIssues(listWith([web, api], docs, null), [repo])).toEqual([]);
  });

  it("F-140/c2: a new process starts empty in the first repo, primary only when there's none", () => {
    expect(emptyForm(repo, true)).toMatchObject({ repoId: repo, folder: ".", readyKind: "http", readyPath: "/", primary: true, hostRewrite: true });
    expect(Object.keys(processFormIssues(emptyForm(repo, false), [web], [repo])).sort()).toEqual(["command", "label", "name", "port"]);
  });

  it("F-140/c5: the last box's words: ready with its time, exited with its code, didn't answer, not run yet", () => {
    expect(lastBoxWords({ state: "ready", exitCode: null, reason: null, readyAfterMs: 6200 })).toEqual({ word: "ready", tone: "green", extra: "6 s" });
    expect(lastBoxWords({ state: "exited", exitCode: 1, reason: "exited", readyAfterMs: null })).toEqual({ word: "exited 1", tone: "red", extra: null });
    expect(lastBoxWords({ state: "failed", exitCode: null, reason: "ready-timeout", readyAfterMs: null })).toEqual({ word: "didn't answer", tone: "red", extra: null });
    expect(lastBoxWords(null)).toEqual({ word: "not run yet", tone: null, extra: null });
  });

  it("F-140/c6: each process gets the others' in-box addresses, a service its docker one with the kubernetes one beside it, and none is for a browser", () => {
    expect(addressRows([web, api], [{ name: "mailpit", port: 8025 }, { name: "redis-cache", port: null }])).toEqual([
      { name: "OSTRA_APP_WEB_URL", value: "http://localhost:5173", other: null, kind: "app" },
      { name: "OSTRA_APP_API_URL", value: "http://localhost:3001", other: null, kind: "app" },
      { name: "OSTRA_SERVICE_MAILPIT_URL", value: "http://mailpit:8025", other: "http://localhost:8025", kind: "service" },
    ]);
    expect(readyWords({ kind: "http", path: "/health" })).toEqual({ words: "HTTP", mono: "/health" });
    expect(whereText("acme/calculator-web", "api")).toBe("calculator-web/api");
    expect(whereText("acme/calculator-web", ".")).toBe("calculator-web");
  });
});
