import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { paletteActions } from "@ostra/domain/palette";
import type { PaletteActionId } from "@ostra/domain/palette";

import { signIn } from "./helpers.ts";
import { expectFacts, focusedMark, seedKeysTask, tabTo } from "./keys.ts";
import { focusRailItem } from "./shell.ts";

// F-081 (milestone 7, tickets 13 and 16): the core actions from the command palette and from their
// shortcuts, with the keyboard only, end to end on seeded tasks (seed-keys.ts), each checked in the
// database (read-keys.ts); the `?` sheet against the one registry; no shortcut while typing; the
// core actions by Tab, arrows and Enter on their own screens; focus back on its trigger after each
// dialog; and the live region for a new needs-you item. Desktop only: a phone has no keyboard to teach.

const run = String(Date.now()).slice(-6);
const title = (what: string) => `Keys ${run}: ${what}`;

const palette = (page: Page) => page.getByTestId("search-palette");
const toast = (page: Page) => page.getByTestId("shell-toast");

/** Opens the palette with the keys and types `words`, as a member would. */
const command = async (page: Page, words: string) => {
  await page.keyboard.press("Control+KeyK");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(words);
};

/** The task page, loaded: its title is drawn. */
const openTask = async (page: Page, taskId: string, name: string) => {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
};

test.describe("F-081: the core actions by keyboard", { tag: "@desktop-only" }, () => {
  test("F-081/c1: jump to needs you, approve, answer, take over and reopen, each from the palette with the keyboard only", async ({ page }) => {
    const approval = await seedKeysTask("approval", title("palette approval"));
    const question = await seedKeysTask("question", title("palette question"));
    const other = await seedKeysTask("running-other", title("palette take over"));
    const stopped = await seedKeysTask("stopped", title("palette reopen"));
    await signIn(page);

    // Jump to "needs you".
    await command(page, "needs");
    await expect(palette(page).getByTestId("palette-action").first()).toHaveAttribute("data-action", "go-needs-you");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/needs-you$/);
    await expect(palette(page)).toHaveCount(0);

    // Approve…: the second step lists the open approvals; Enter approves once.
    await command(page, "approve");
    await expect(palette(page).getByTestId("palette-action").first()).toHaveAttribute("data-action", "approve");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveAttribute("data-step", "approve-pick");
    await page.keyboard.type(approval.key);
    await expect(palette(page).getByTestId("palette-step-row").first()).toHaveAttribute("data-step-row", approval.approvalId ?? "");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Approved ${approval.key}'s request.`);
    await expectFacts(approval.taskId, (facts) => facts.approvals[0]?.decision === "allow_once" && facts.openItems === 0);

    // Answer…: a question of one choice list is answered in place.
    await command(page, "answer");
    await expect(palette(page).getByTestId("palette-action").first()).toHaveAttribute("data-action", "answer");
    await page.keyboard.press("Enter");
    await page.keyboard.type(question.key);
    await expect(palette(page).getByTestId("palette-step-row").first()).toHaveAttribute("data-step-row", question.questionId ?? "");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveAttribute("data-step", "answer-choice");
    await page.keyboard.press("ArrowDown");
    await expect(palette(page).getByTestId("palette-step-row").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Answered ${question.key}'s question.`);
    await expectFacts(question.taskId, (facts) => (facts.events["question.answered"] ?? 0) === 1);

    // Take over, on the task's page.
    await openTask(page, other.taskId, title("palette take over"));
    await command(page, "take");
    await expect(palette(page).getByTestId("palette-action").first()).toHaveAttribute("data-action", "take-over");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Took over ${other.key}.`);
    await expectFacts(other.taskId, (facts) => facts.drivenByAdmin);

    // Reopen…: straight to the message for this task; ⌘↵ or Ctrl+↵ sends.
    await openTask(page, stopped.taskId, title("palette reopen"));
    await command(page, "reopen");
    await expect(palette(page).getByTestId("palette-action").first()).toHaveAttribute("data-action", "reopen");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveAttribute("data-step", "reopen-message");
    await expect(palette(page).getByRole("textbox", { name: "Message to the agent" })).toBeFocused();
    await page.keyboard.type("Carry on with the README.");
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toHaveText(`Reopened ${stopped.key}.`);
    await expectFacts(stopped.taskId, (facts) => facts.state === "queued" && (facts.events["user.message"] ?? 0) >= 2);
  });

  test("F-081/c1: the ? sheet lists every shortcut of the registry, and every line on it is a working shortcut", async ({ page }) => {
    await signIn(page);
    await page.keyboard.press("?");
    const sheet = page.getByTestId("shortcut-sheet");
    await expect(sheet).toBeVisible();
    const lines = await sheet.locator("[data-sheet-line]").evaluateAll((nodes) => nodes.map((node) => ({ id: node.getAttribute("data-sheet-line") ?? "", keys: node.getAttribute("data-keys") ?? "" })));
    const registry = paletteActions.flatMap((entry) => (entry.shortcut === null ? [] : [{ id: entry.id, keys: entry.shortcut.join(" ") }]));
    // Every shortcut has its line, and every line but ⌘K's is a shortcut of the registry.
    expect(lines.filter((line) => line.id !== "palette").sort((a, b) => a.id.localeCompare(b.id))).toEqual([...registry].sort((a, b) => a.id.localeCompare(b.id)));
    expect(lines.find((line) => line.id === "palette")?.keys).toMatch(/^(Control|Meta)\+k$/);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    const press = async (keys: string) => {
      for (const key of keys.split(" ")) await page.keyboard.press(key === "?" ? "Shift+Slash" : key === "/" ? "Slash" : key);
    };
    // What each shortcut does, checked where it applies; a line with no check here fails the test.
    const checks: Partial<Record<PaletteActionId, (keys: string) => Promise<void>>> = {
      "go-needs-you": async (keys) => { await page.goto("/"); await press(keys); await page.waitForURL(/\/needs-you$/); },
      "go-home": async (keys) => { await page.goto("/needs-you"); await press(keys); await page.waitForURL((url) => url.pathname === "/"); },
      "go-tasks": async (keys) => { await page.goto("/"); await press(keys); await page.waitForURL(/\/search$/); },
      // F-147: the rail's Projects and Organization spaces, and `[` that hides and shows the context panel.
      "go-projects": async (keys) => { await page.goto("/"); await press(keys); await page.waitForURL(/\/projects\//); },
      "go-organization": async (keys) => { await page.goto("/"); await press(keys); await page.waitForURL(/\/organization\/insights$/); },
      "toggle-sidebar": async (keys) => {
        await page.goto("/");
        const panel = page.getByTestId("context-panel");
        await expect(panel).toHaveAttribute("data-collapsed", "false");
        await press(keys);
        await expect(panel).toHaveAttribute("data-collapsed", "true");
        await press(keys);
        await expect(panel).toHaveAttribute("data-collapsed", "false");
      },
      search: async (keys) => { await page.goto("/"); await press(keys); await expect(palette(page)).toBeVisible(); await page.keyboard.press("Escape"); },
      "shortcut-sheet": async (keys) => { await page.goto("/"); await press(keys); await expect(sheet).toBeVisible(); await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); },
      "new-task": async (keys) => { await page.goto("/"); await press(keys); await page.waitForURL(/\/tasks\/new$/); },
      approve: async (keys) => {
        const seeded = await seedKeysTask("approval", title("key approve"));
        await openTask(page, seeded.taskId, title("key approve"));
        await expect(page.getByTestId("approval")).toBeFocused();
        await press(keys);
        await expect(toast(page)).toHaveText(`Approved ${seeded.key}'s request.`);
        await expectFacts(seeded.taskId, (facts) => facts.approvals[0]?.decision === "allow_once");
      },
      deny: async (keys) => {
        const seeded = await seedKeysTask("approval", title("key deny"));
        await openTask(page, seeded.taskId, title("key deny"));
        await expect(page.getByTestId("approval")).toBeFocused();
        await press(keys);
        await expect(page.locator("[data-part='deny'] textarea")).toBeFocused();
      },
      answer: async (keys) => {
        const seeded = await seedKeysTask("question", title("key answer"));
        await openTask(page, seeded.taskId, title("key answer"));
        await expect(page.getByTestId("question")).toBeFocused();
        await press(keys);
        await expect(page.getByRole("radio", { name: "vitest" })).toBeFocused();
        await page.keyboard.press("Space");
        await page.keyboard.press("Tab");
        await expect(page.locator("[data-action='answer-question']")).toBeFocused();
        await page.keyboard.press("Enter");
        await expectFacts(seeded.taskId, (facts) => (facts.events["question.answered"] ?? 0) === 1);
      },
      "take-over": async (keys) => {
        const seeded = await seedKeysTask("running-other", title("key take over"));
        await openTask(page, seeded.taskId, title("key take over"));
        await expect(page.locator("[data-part='watcher-bar']")).toBeVisible();
        await press(keys);
        await expect(toast(page)).toHaveText(`Took over ${seeded.key}.`);
        await expectFacts(seeded.taskId, (facts) => facts.drivenByAdmin);
      },
      reopen: async (keys) => {
        const seeded = await seedKeysTask("stopped", title("key reopen"));
        await openTask(page, seeded.taskId, title("key reopen"));
        await expect(page.locator("[data-action='reopen']")).toBeVisible();
        await press(keys);
        await expect(palette(page)).toHaveAttribute("data-step", "reopen-message");
        await page.keyboard.type("Carry on.");
        await page.keyboard.press("Control+Enter");
        await expectFacts(seeded.taskId, (facts) => facts.state !== "stopped");
      },
      stop: async (keys) => {
        const seeded = await seedKeysTask("approval", title("key stop"));
        await openTask(page, seeded.taskId, title("key stop"));
        await expect(page.locator("[data-action='stop']")).toBeVisible();
        // `s` asks to confirm: Escape keeps the task; the second time, Stop task stops it.
        await press(keys);
        const confirm = page.getByRole("alertdialog");
        await expect(confirm).toContainText(`Stop ${seeded.key}?`);
        await page.keyboard.press("Escape");
        await expect(confirm).toHaveCount(0);
        await expectFacts(seeded.taskId, (facts) => facts.state === "needs_you");
        await press(keys);
        await expect(confirm).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(confirm.getByRole("button", { name: "Stop task" })).toBeFocused();
        await page.keyboard.press("Enter");
        await expectFacts(seeded.taskId, (facts) => facts.state === "stopped");
      },
    };
    for (const line of lines) {
      if (line.id === "palette") {
        await page.goto("/");
        await page.keyboard.press(line.keys);
        await expect(palette(page)).toBeVisible();
        await page.keyboard.press("Escape");
        continue;
      }
      const check = Object.entries(checks).find(([id]) => id === line.id)?.[1];
      expect(check, `no check for the sheet line ${line.id}`).toBeDefined();
      await check?.(line.keys);
    }
  });

  test("F-081/c1: no shortcut fires while typing in the composer, a field or the palette", async ({ page }) => {
    const seeded = await seedKeysTask("approval", title("typing"));
    await signIn(page);
    await openTask(page, seeded.taskId, title("typing"));
    const composer = page.locator("[data-part='composer'] textarea");
    await composer.focus();
    await page.keyboard.type("g n a d r t o s c / ?");
    await expect(composer).toHaveValue("g n a d r t o s c / ?");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByTestId("shortcut-pending")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/tasks/${seeded.taskId}`);
    // Escape leaves the composer; the keys are shortcuts again.
    await page.keyboard.press("Escape");
    await expect(composer).not.toBeFocused();

    // In the palette's own field, `a` types an `a`.
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("a");
    await expect(palette(page).getByRole("combobox")).toHaveValue("a");
    await page.keyboard.press("Escape");
    await expectFacts(seeded.taskId, (facts) => facts.approvals[0]?.state === "open" && facts.state === "needs_you");
  });

  test("F-081/c2: approve, answer, take over and reopen with Tab, arrows and Enter alone on their screens", async ({ page }) => {
    const approval = await seedKeysTask("approval", title("tab approve"));
    const listed = await seedKeysTask("approval", title("list approve"));
    const question = await seedKeysTask("question", title("tab answer"));
    const other = await seedKeysTask("running-other", title("tab take over"));
    const stopped = await seedKeysTask("stopped", title("tab reopen"));
    await signIn(page);

    // The approval card takes the focus when it appears; its buttons follow in order.
    await openTask(page, approval.taskId, title("tab approve"));
    await expect(page.getByTestId("approval")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='approval'] [data-action='deny']")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='approval'] [data-action='approve-once']")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='approval'] [data-action='approve-task']")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expectFacts(approval.taskId, (facts) => facts.approvals[0]?.decision === "allow_once");

    // The Needs you list: Tab reaches one row, the arrows move between rows, Enter opens one.
    await page.goto("/needs-you");
    const row = page.getByTestId("needs-you-row").filter({ hasText: listed.key });
    await expect(row).toBeVisible();
    const first = page.getByTestId("needs-you-row").first();
    await tabTo(page, first);
    const rows = await page.getByTestId("needs-you-row").count();
    for (let i = 0; i < rows && !(await row.evaluate((node) => node === document.activeElement)); i += 1) await page.keyboard.press("ArrowDown");
    await expect(row).toBeFocused();
    const item = page.locator("li", { has: row });
    if ((await item.locator("[data-action='deny']").count()) === 0) await page.keyboard.press("Enter");
    await tabTo(page, item.getByRole("button", { name: "Approve once" }), 10);
    await page.keyboard.press("Enter");
    await expectFacts(listed.taskId, (facts) => facts.approvals[0]?.decision === "allow_once");

    // A question's form: the card has the focus, Tab reaches the choice, the arrows choose, Tab sends.
    await openTask(page, question.taskId, title("tab answer"));
    await expect(page.getByTestId("question")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: "vitest" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "jest" })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-action='answer-question']")).toBeFocused();
    await page.keyboard.press("Enter");
    await expectFacts(question.taskId, (facts) => (facts.events["question.answered"] ?? 0) === 1);

    // The take-over bar.
    await openTask(page, other.taskId, title("tab take over"));
    await tabTo(page, page.locator("[data-part='watcher-bar'] [data-action='take-over']"));
    await page.keyboard.press("Enter");
    await expectFacts(other.taskId, (facts) => facts.drivenByAdmin);

    // The reopen composer: Tab to it, type, Enter sends (Shift+Enter is a new line).
    await openTask(page, stopped.taskId, title("tab reopen"));
    const composer = page.locator("[data-part='composer'] textarea");
    await tabTo(page, composer);
    await page.keyboard.type("Pick it up again.");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Then run the tests.");
    await expect(composer).toHaveValue("Pick it up again.\nThen run the tests.");
    await page.keyboard.press("Enter");
    await expectFacts(stopped.taskId, (facts) => facts.state === "queued" && (facts.events["user.message"] ?? 0) >= 2);
  });

  test("F-081/c2: focus returns to its trigger after every dialog: the palette, the sheet, Stop's confirmation and the account menu", async ({ page }) => {
    const seeded = await seedKeysTask("approval", title("focus return"));
    await signIn(page);

    // The palette, from the rail's Search: the rail is one tab stop, and its arrows reach Search (F-147).
    const search = page.locator("[data-action='open-palette']").filter({ visible: true });
    await focusRailItem(page, search);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    await expect(search).toBeFocused();

    // The sheet, from `?` with the focus on the same button.
    await page.keyboard.press("Shift+Slash");
    await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();

    // Stop's confirmation, from `s` with the focus on the approval card.
    await openTask(page, seeded.taskId, title("focus return"));
    await expect(page.getByTestId("approval")).toBeFocused();
    await page.keyboard.press("s");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("approval")).toBeFocused();

    // The account menu, with its own trigger at the rail's foot.
    const account = page.getByTestId("user-menu").filter({ visible: true });
    await focusRailItem(page, account);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Radix moves the focus back in a timer once the menu has unmounted: wait for it.
    await expect.poll(() => focusedMark(page)).toBe("user-menu");
  });

  test("F-081/c2: the live region announces a new needs-you item", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("[data-action='open-palette']")).toBeVisible();
    // Let the shell read the count once, then something new waits.
    await page.waitForTimeout(1_500);
    await seedKeysTask("approval", title("announced"));
    const region = page.getByTestId("shell-toast");
    await expect(region).toHaveAttribute("aria-live", "polite");
    await expect(region).toContainText(/Something new needs you\. \d+ waiting\./, { timeout: 25_000 });
  });
});
