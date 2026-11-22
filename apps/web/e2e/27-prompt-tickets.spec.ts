import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-097/c2 (Q31, prompt-tickets.md): "Make a ticket for every prompt task" on a project's Boards
// page, and what New task says of it, through the panel, the API, the domain's use cases and the
// database, with the stack's fake Linear as the organization's connection. A prompt task makes no
// ticket unless the project's setting is on; on, a code task started from New task gets its
// ticket's create write on the board the setting names, as it starts.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (app-targets/m10-gaps/prompt-tickets*); without it none is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({
  username: z.string(),
  memberUsername: z.string(),
  projectId: z.string(),
  calculatorBoardId: z.string(),
  webBoardId: z.string(),
  oneProjectId: z.string(),
  noneProjectId: z.string(),
});
type World = z.infer<typeof worldSchema>;

const seed = async (input: Record<string, unknown>): Promise<unknown> => {
  const { databaseUrl, dataDir, linear } = await readStack();
  if (dataDir === null) throw new Error("the prompt-tickets seed needs the stack's data folder, for its secrets key");
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-prompt-tickets.ts"), JSON.stringify({ databaseUrl, dataDir, linear, ...input })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};
const seedWorld = async (): Promise<World> => worldSchema.parse(await seed({ scenario: "world", password: e2eAdmin.password, tag: `pt-${Date.now().toString(36)}` }));
const setConnection = async (state: "failed" | "active"): Promise<void> => { await seed({ scenario: "connection", state }); };
const writesOf = async (taskId: string) => z.object({ writes: z.array(z.object({ kind: z.string(), boardId: z.string() })) }).parse(await seed({ scenario: "writes", taskId })).writes;

const section = (page: Page): Locator => page.getByTestId("prompt-tickets");
const settingSwitch = (page: Page): Locator => section(page).getByRole("switch", { name: "Make a ticket for every prompt task" });
const picker = (page: Page): Locator => page.getByRole("combobox", { name: "Board for prompt tasks' tickets" });

const openBoards = async (page: Page, projectId: string, boardId?: string): Promise<void> => {
  await page.goto(`/projects/${projectId}/boards${boardId === undefined ? "" : `?board=${boardId}`}`);
  await expect(section(page)).toBeVisible();
  await hydrated(settingSwitch(page));
};

const pick = async (page: Page, name: string): Promise<void> => {
  await picker(page).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
};

/** The page in both themes at the target's size, as its pictures draw it. */
const shootPage = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** One state of the setting: its section (heading and row), and what's open under it. */
const shootState = async (page: Page, name: string, below = 0): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.waitForTimeout(250);
  const box = await section(page).locator("xpath=ancestor::section[1]").boundingBox();
  if (box === null) throw new Error("the Prompt tasks section isn't on the page");
  await page.screenshot({ path: path.join(shots, `state-${name}.png`), clip: { x: box.x - 8, y: box.y - 6, width: box.width + 16, height: box.height + 12 + below } });
};

const memberPage = async (browser: Browser, username: string, phone = false): Promise<Page> => {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 956 } });
  const page = await context.newPage();
  await signIn(page, username);
  return page;
};

test("F-097/c2: an admin turns on a ticket for every prompt task on Boards, picks its board, and New task says so; a code task started then has its ticket written on that board, and none once it's off", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(150_000);
  const world = await seedWorld();
  await signIn(page, world.username);

  // Off by default: the switch is off, and the line says Create ticket still makes one.
  await openBoards(page, world.projectId, world.calculatorBoardId);
  await expect(section(page)).toHaveAttribute("data-state", "off");
  await expect(settingSwitch(page)).not.toBeChecked();
  await expect(section(page)).toContainText("Off: a prompt task makes no ticket. A member can still use Create ticket on one.");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByTestId("board-properties")).not.toContainText("Get their tickets here");

  // On: the switch saves at once, on the board selected on the page, and the picker names it.
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");
  await expect(settingSwitch(page)).toBeChecked();
  await expect(section(page)).toContainText("Each task a member starts from a prompt gets a ticket on Calculator as it starts. Refine tasks make theirs from their draft.");
  await expect(picker(page)).toContainText("Calculator");
  await expect(picker(page)).toContainText("· CALC");
  await expect(page.getByTestId("board-properties")).toContainText("Get their tickets here");

  // The picker moves it to the other board, at once, and it holds after a reload.
  await pick(page, "Web platform");
  await expect(picker(page)).toContainText("Web platform");
  await expect(section(page)).toContainText("gets a ticket on Web platform as it starts");
  await expect(page.getByTestId("board-properties")).not.toContainText("Get their tickets here");
  await page.reload();
  await expect(picker(page)).toContainText("Web platform");

  // Detaching the board that takes them says the setting turns off; another board's says nothing new.
  const rows = page.getByTestId("boards").locator("li");
  await rows.filter({ hasText: "Web platform" }).getByRole("button", { name: "Detach" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Prompt tasks stop getting tickets: Make a ticket for every prompt task turns off.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await rows.filter({ hasText: "Calculator" }).getByRole("button", { name: "Detach" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("ostra stops polling CALC.");
  await expect(page.getByRole("alertdialog")).not.toContainText("Prompt tasks stop getting tickets");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  // Back on Calculator: New task says the next code task gets a ticket there.
  await pick(page, "Calculator");
  await expect(picker(page)).toContainText("Calculator");
  await page.goto(`/tasks/new?project=${world.projectId}`);
  await expect(page.getByTestId("next-ticket")).toHaveText("It gets a ticket on Calculator as it starts, linked to the task both ways.");
  await expect(page.getByTestId("new-task-properties")).toContainText(/Ticket\s*made on\s*CALC\s*when it starts/);
  // A refine task makes its ticket from its draft: New task says nothing of one.
  const kinds = page.getByTestId("pick-kind");
  await hydrated(kinds);
  await kinds.getByRole("radio", { name: "Refine" }).click();
  await expect(page.getByTestId("next-ticket")).toHaveCount(0);
  await expect(page.getByTestId("ticket-board-key")).toHaveCount(0);
  await kinds.getByRole("radio", { name: "Code" }).click();
  await expect(page.getByTestId("next-ticket")).toBeVisible();

  // A code task started from it has its ticket's create write on Calculator, from its start.
  const prompt = page.locator("#new-task-prompt");
  await hydrated(prompt);
  await prompt.fill("Round half up in percent mode, to the cent, on the final value only.");
  await page.locator("[data-action='start-task']").click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const started = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  // Core's ticket sync may already have made it and gone on (the move, the comment, the link): one create, all on Calculator.
  const writes = await writesOf(started);
  expect(writes[0]).toEqual({ kind: "create", boardId: world.calculatorBoardId });
  expect(writes.filter((write) => write.kind === "create")).toHaveLength(1);
  expect(writes.every((write) => write.boardId === world.calculatorBoardId)).toBe(true);

  // Off again: New task says nothing, and a task started then has no ticket write.
  await openBoards(page, world.projectId, world.calculatorBoardId);
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "off");
  await page.goto(`/tasks/new?project=${world.projectId}`);
  await expect(page.getByTestId("what-happens-next")).toBeVisible();
  await expect(page.getByTestId("next-ticket")).toHaveCount(0);
  await hydrated(page.locator("#new-task-prompt"));
  await page.locator("#new-task-prompt").fill("Keep the last 50 results.");
  await page.locator("[data-action='start-task']").click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  expect(await writesOf(new URL(page.url()).pathname.split("/").at(-1) ?? "")).toEqual([]);
});

test("F-097/c2: a member reads the setting and can't change it; with one board there's no picker, and with none the switch waits for one", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const world = await seedWorld();
  await signIn(page, world.username);
  await openBoards(page, world.projectId, world.calculatorBoardId);
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");

  const member = await memberPage(browser, world.memberUsername);
  await openBoards(member, world.projectId);
  await expect(member.getByText("Only the project's admins change boards.")).toBeVisible();
  await expect(settingSwitch(member)).toBeChecked();
  await expect(settingSwitch(member)).toBeDisabled();
  await expect(picker(member)).toHaveCount(0);
  await expect(member.getByTestId("prompt-tickets-board")).toContainText("Calculator");
  await member.context().close();

  // One board: on, the sentence names it, and there's nothing to pick.
  await openBoards(page, world.oneProjectId);
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");
  await expect(section(page)).toContainText("gets a ticket on Calculator as it starts");
  await expect(picker(page)).toHaveCount(0);

  // No board attached: off, and the switch waits for one.
  await openBoards(page, world.noneProjectId);
  await expect(section(page)).toHaveAttribute("data-state", "none");
  await expect(settingSwitch(page)).toBeDisabled();
  await expect(section(page)).toContainText("A ticket needs a board. Attach a team above, then turn it on.");
});

test("F-097/c2: while Linear's connection isn't active the setting is kept but paused, and a save the server refuses shows its reason and leaves the switch as saved", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedWorld();
  await signIn(page, world.username);
  await openBoards(page, world.projectId, world.calculatorBoardId);
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");
  try {
    await setConnection("failed");
    await openBoards(page, world.projectId, world.calculatorBoardId);
    await expect(section(page)).toHaveAttribute("data-state", "paused");
    await expect(settingSwitch(page)).toBeChecked();
    await expect(section(page)).toContainText("On, but the Linear connection isn't active, so prompt tasks get no ticket on Calculator until it is.");
    await expect(section(page).getByRole("link", { name: "Reconnect Linear" })).toHaveAttribute("href", "/organization/linear");
    await expect(picker(page)).toBeDisabled();
    // New task says nothing of a ticket while none would be made.
    await page.goto(`/tasks/new?project=${world.projectId}`);
    await expect(page.getByTestId("what-happens-next")).toBeVisible();
    await expect(page.getByTestId("next-ticket")).toHaveCount(0);

    // Turning it on elsewhere is refused while the connection is down: the reason, and the switch as saved.
    await openBoards(page, world.oneProjectId);
    await expect(section(page)).toHaveAttribute("data-state", "off");
    await settingSwitch(page).click();
    await expect(section(page).getByRole("alert")).toContainText("That isn't one of this project's boards, or its tracker connection isn't active");
    await expect(settingSwitch(page)).not.toBeChecked();
    await expect(section(page)).toHaveAttribute("data-state", "off");
  } finally {
    await setConnection("active");
  }
});

test("prompt-tickets.md: the Boards page, its states, New task and the phone, for the side-by-sides", { tag: "@desktop-only" }, async ({ page, browser }) => {
  test.skip(shots === undefined, "screenshots only");
  test.setTimeout(240_000);
  const world = await seedWorld();
  await page.setViewportSize({ width: 1440, height: 956 });
  await signIn(page, world.username);

  // The states, one board: off, then on.
  await openBoards(page, world.oneProjectId);
  await shootState(page, "one-off");
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");
  await shootState(page, "one-on");
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "off");
  // No board attached.
  await openBoards(page, world.noneProjectId);
  await shootState(page, "none");

  // The page: two boards, on, Calculator selected; then the picker open.
  await openBoards(page, world.projectId, world.calculatorBoardId);
  await settingSwitch(page).click();
  await expect(section(page)).toHaveAttribute("data-state", "on");
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await shootPage(page, "prompt-tickets");
  await picker(page).click();
  await expect(page.getByRole("option", { name: /^Web platform/ })).toBeVisible();
  await shootState(page, "several-open", 96);
  await page.keyboard.press("Escape");

  // The Detach dialog of the board that takes them.
  await page.getByTestId("boards").locator("li").filter({ hasText: "Calculator" }).getByRole("button", { name: "Detach" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Prompt tasks stop getting tickets");
  if (shots !== undefined) await dialog.screenshot({ path: path.join(shots, "state-detach.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A member's.
  const member = await memberPage(browser, world.memberUsername);
  await openBoards(member, world.projectId);
  await shootState(member, "member");
  await member.context().close();

  // Linear's connection isn't active, and a failed save.
  try {
    await setConnection("failed");
    await openBoards(page, world.projectId, world.calculatorBoardId);
    await expect(section(page)).toHaveAttribute("data-state", "paused");
    await shootState(page, "paused");
    await openBoards(page, world.oneProjectId);
    await settingSwitch(page).click();
    await expect(section(page).getByRole("alert")).toBeVisible();
    await shootState(page, "failed");
  } finally {
    await setConnection("active");
  }

  // New task in that project, a code task with the prompt of the target's.
  await page.goto(`/tasks/new?project=${world.projectId}`);
  const prompt = page.locator("#new-task-prompt");
  await hydrated(prompt);
  await prompt.fill("Percent mode rounds half-cents down: 12.5% of 845 shows 105.62 where finance expects 105.63. Round half up, to the cent, on the final value only, as finance's rules say. The screenshots show the desktop and the phone builds; the cases are in the csv.");
  // The target's files, as milestone 9's box takes them: two pictures, a docx and a csv.
  const shot = async (width: number, height: number): Promise<Buffer> => {
    const context = await browser.newContext({ viewport: { width, height } });
    const scratch = await context.newPage();
    await scratch.setContent(`<body style="margin:0;background:#f4f5f7;font:16px sans-serif"><header style="background:#1f6feb;color:#fff;padding:12px">Tally</header><p style="padding:16px">105.62</p></body>`);
    const bytes = await scratch.screenshot({ type: "png" });
    await context.close();
    return bytes;
  };
  await page.getByTestId("attach-input").setInputFiles([
    { name: "wrong-total.png", mimeType: "image/png", buffer: await shot(1280, 800) },
    { name: "phone-total.png", mimeType: "image/png", buffer: await shot(390, 844) },
    { name: "rounding-rules.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await readFile(path.join(import.meta.dirname, "..", "..", "..", "e2e", "m9-attachments", "fixtures", "history-panel-spec.docx")) },
    { name: "percent-cases.csv", mimeType: "text/csv", buffer: Buffer.from("expression,expected\n12.5% of 845,105.63\n") },
  ]);
  await expect(page.locator("[data-tray-item][data-state='ready']")).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByTestId("next-ticket")).toBeVisible();
  await shootPage(page, "prompt-tickets-new-task");

  // The phone: Boards, the setting under Attached, the picker full width.
  const phone = await memberPage(browser, world.username, true);
  await openBoards(phone, world.projectId, world.calculatorBoardId);
  await expectNoHorizontalScroll(phone);
  await shootPage(phone, "prompt-tickets-phone");
  await phone.context().close();
});
