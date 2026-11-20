import path from "node:path";

import type { Db } from "@ostra/db";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { say } from "@ostra/e2e-m1/setup";
import type { LinearTool } from "@ostra/e2e-m2/linear";
import type { PanelApi } from "@ostra/e2e-m2-failures/api";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import type { Page } from "@playwright/test";

import type { InstalledCli, RunnerProcess } from "./runners.ts";
import type { M5Settings } from "./settings.ts";
import type { DevTool, Stack } from "./stack.ts";

// What every step of milestone 5's demo works with (ticket 37): the stack and its dev tools, the
// database the checks read, both members' browsers and their API, Linear and GitHub as the test
// tools see them, the installed CLI and the runners the steps started, and what the run made.

export type CheckResult = { readonly step: number; readonly name: string; readonly ok: boolean; readonly detail: string };

export type Project = { readonly id: ProjectId; readonly href: string; readonly repo: string };

export type Demo = {
  readonly settings: M5Settings;
  readonly stack: Stack;
  readonly tools: { readonly fakeKube: DevTool; readonly registry: DevTool; readonly npmRegistry: DevTool; readonly netProxies: DevTool };
  /** Each dev tool's environment, for its switches (`pnpm dev:fake-kube hold 40s`). */
  readonly toolEnv: NodeJS.ProcessEnv;
  readonly db: Db;
  readonly organizationId: OrganizationId;
  /** The first admin, Demo. */
  readonly demo: Page;
  readonly api: PanelApi;
  /** The invited member, Sam. */
  readonly sam: Page;
  readonly samApi: PanelApi;
  readonly tool: LinearTool;
  /** The test org's `test1` and `test2`, as the demo's own GitHub client sees them. */
  readonly github: { readonly test1: DemoGitHub; readonly test2: DemoGitHub };
  readonly test1: Project;
  readonly test2: Project;
  readonly boardId: string;
  readonly cli: InstalledCli;
  readonly logDir: string;
  readonly runners: Map<string, RunnerProcess>;
  /** Processes a step started that aren't pool runners (Sam's runner): stopped after the run. */
  readonly stopLater: (() => Promise<void>)[];
  /** Values the run handled that must appear nowhere: join tokens, registry credentials. Never printed. */
  readonly secrets: string[];
  /** What the run made, for the clean-up. */
  readonly made: { readonly tickets: { id: string; identifier: string }[]; readonly taskIds: TaskId[] };
  /** Step-to-step facts: pool IDs, runner IDs, task IDs. */
  readonly facts: Record<string, string>;
  readonly checks: CheckResult[];
  readonly timings: Record<string, number>;
  readonly check: (step: number, name: string, ok: boolean, detail: string) => void;
  /** What a step couldn't show on this machine, and why: recorded for demo.md, not a check. */
  readonly notes: { readonly step: number; readonly text: string }[];
  readonly note: (step: number, text: string) => void;
  readonly shot: (page: Page, name: string) => Promise<void>;
};

export const recordCheck = (checks: CheckResult[]) => (step: number, name: string, ok: boolean, detail: string): void => {
  checks.push({ step, name, ok, detail });
  say(`${ok ? "PASS" : "FAIL"} ${String(step)}. ${name}: ${detail}`);
};

/** A committed screenshot: this machine's folders and the members' addresses are masked. */
export const screenshotTo = (dir: string) => async (page: Page, name: string): Promise<void> => {
  const mask = [page.getByText(/[A-Za-z]:\\Users\\|\/home\/|\/Users\//), page.locator("#email")].map((locator) => locator.filter({ visible: true }));
  await page.screenshot({ path: path.join(dir, `${name}.png`), mask });
  say(`screenshot ${name}.png`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it answers something other than `null`, or throws after `timeoutMs`. */
export const waitFor = async <T,>(what: string, timeoutMs: number, read: () => Promise<T | null>, everyMs = 1000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for ${what}`);
    await sleep(everyMs);
  }
};

export { sleep };
