import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { z } from "zod";

import { checkContrast, prepareA11y, walkByTab } from "./a11y/checks.ts";
import { hydrated, readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eAdmin, e2eBaseUrl } from "./settings.ts";

// Milestone 9's tickets 15 and 16 (F-148, F-149, F-150): files in the message box and the new-task
// box, in the thread, in the viewer, and the ticket's context, on a world `seed-files-world.ts`
// seeds (a task waiting on its driver's reply, a task whose message carried files, tasks on a
// text-only model and on a runner too old for files, and four tasks from a Linear ticket). Every
// upload goes through the panel's route to the stack's real core, which reads a document's text.
// A press of Retry or "Send ticket updates" is answered as core's job answers it (the seed's
// `round`): the fake tracker isn't connected here. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets (app-targets/m9/), at their sizes in both themes.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixtures = path.join(repoRoot, "e2e", "m9-attachments", "fixtures");

const worldSchema = z.object({
  username: z.string(),
  projectId: z.string(),
  composerTaskId: z.string(),
  threadTaskId: z.string(),
  textOnlyTaskId: z.string(),
  oldRunnerTaskId: z.string(),
  ticketTaskId: z.string(),
  skippedTaskId: z.string(),
  failedTaskId: z.string(),
  noneTaskId: z.string(),
  claudeModelId: z.string(),
  deepseekModelId: z.string(),
  providerId: z.string(),
});
type World = z.infer<typeof worldSchema>;
type Pictures = { readonly mock: string; readonly pasted: string; readonly wrong: string; readonly right: string; readonly phone: string };

/** A small demo app, in its own colours: a calculator with its history beside it, showing `display`. */
const demoApp = (display: string, ring: string | null): string => `<!doctype html><html><head><style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f5f8;color:#1c2333}
  header{display:flex;gap:16px;align-items:center;padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee} header b{color:#2f5be0}
  main{display:flex;flex-wrap:wrap;gap:16px;padding:16px} .calc{flex:1 1 280px;background:#fff;border-radius:8px;padding:16px;position:relative}
  .display{font-size:32px;text-align:right;padding:8px 4px} .keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .keys span{background:#eef1f7;border-radius:6px;padding:12px;text-align:center} .keys span.op{background:#dce5ff;color:#2f5be0}
  .history{flex:1 1 240px;background:#fff;border-radius:8px;padding:12px} li{display:flex;padding:8px 0;border-bottom:1px solid #eef0f4} li b{margin-left:auto}
  .ring{position:absolute;right:8px;top:4px;width:160px;height:56px;border:4px solid ${ring ?? "transparent"};border-radius:50%}
</style></head><body><header><b>Tally</b><span>Calculator</span><span>History</span><span>Settings</span></header><main>
  <section class="calc"><div class="ring"></div><div class="display">${display}</div><div class="keys">${["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", "00", ".", "="].map((key, i) => `<span class="${i % 4 === 3 ? "op" : ""}">${key}</span>`).join("")}</div></section>
  <section class="history"><b>History</b><ul style="list-style:none;padding:0">${["1,284.50", "101.40", "14", "2,081.25"].map((value) => `<li><span>${value}</span><b>${value}</b></li>`).join("")}</ul></section></main></body></html>`;

/** The pictures the seed stores and the spec attaches: PNGs of the demo app at desktop and phone width. */
const takePictures = async (browser: Browser): Promise<Pictures> => {
  const folder = await mkdtemp(path.join(tmpdir(), "ostra-e2e-files-"));
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const png = async (name: string, width: number, height: number, display: string, ring: string | null): Promise<string> => {
    await page.setViewportSize({ width, height });
    await page.setContent(demoApp(display, ring));
    const file = path.join(folder, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: "png" }));
    return file;
  };
  const pictures = {
    mock: await png("mock", 1440, 900, "1,284.50", "#7b61ff"),
    pasted: await png("pasted", 1280, 800, "1,284.50", "#f08c00"),
    wrong: await png("wrong", 1280, 800, "105.62", "#e03131"),
    right: await png("right", 1280, 800, "105.63", "#2f9e44"),
    phone: await png("phone", 390, 844, "105.62", "#e03131"),
  };
  await context.close();
  return pictures;
};

let world: World;
let pictures: Pictures;

const seed = async (input: Record<string, unknown>): Promise<string> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-files-world.ts"), JSON.stringify({ databaseUrl, ...input })], { cwd: path.resolve(import.meta.dirname, "..") });
  return stdout.trim().split("\n").at(-1) ?? "{}";
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  pictures = await takePictures(browser);
  const tag = `m9-${Date.now().toString(36)}`;
  world = worldSchema.parse(JSON.parse(await seed({ scenario: "world", password: e2eAdmin.password, tag, files: { ...pictures, docx: path.join(fixtures, "history-panel-spec.docx"), pdf: path.join(fixtures, "report.pdf") } })));
});

/** The page in both themes, at its size, for the by-eye check against the targets; a ticket task's at its first message. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const first = page.locator("[data-part='ticket-context']");
  if ((await first.count()) > 0) await first.evaluate((element) => { element.scrollIntoView({ block: "start" }); });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, `m9-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** A file to attach through the browser: its name, type and bytes. */
type Attach = { readonly name: string; readonly mimeType: string; readonly buffer: Buffer };
const png = async (name: string, which: keyof Pictures = "wrong"): Promise<Attach> => ({ name, mimeType: "image/png", buffer: await readFile(pictures[which]) });
const docx = async (name = "history-panel-spec.docx"): Promise<Attach> => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await readFile(path.join(fixtures, "history-panel-spec.docx")) });

/** Pastes files into a field, as the browser does on Ctrl+V with files on the clipboard. */
const paste = async (field: Locator, files: readonly Attach[]): Promise<void> => {
  await field.focus();
  await field.evaluate((element, list) => {
    const data = new DataTransfer();
    for (const file of list) data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.mimeType }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, files.map((file) => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })));
};

/** Drags files over the page from outside it and drops them on `target`. */
const drop = async (page: Page, target: Locator, files: readonly Attach[], hold: (() => Promise<void>) | null = null): Promise<void> => {
  const transfer = await page.evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const file of list) data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.mimeType }));
    return data;
  }, files.map((file) => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })));
  await target.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByTestId("drop-zone")).toBeVisible();
  if (hold !== null) await hold();
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByTestId("drop-zone")).toBeHidden();
};

const tray = (page: Page): Locator => page.getByTestId("composer-tray");
const trayItems = (page: Page): Locator => tray(page).locator("[data-tray-item]");

/** Every file in the tray uploaded. */
const expectUploaded = async (page: Page, count: number): Promise<void> => {
  await expect(trayItems(page)).toHaveCount(count);
  await expect(tray(page).locator("[data-tray-item][data-state='ready']")).toHaveCount(count, { timeout: 30_000 });
};

const openTask = async (page: Page, taskId: string): Promise<void> => {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("task-doing")).toBeVisible();
};

/** The task page with its box ready for files: hydrated, and the server's limits read. */
const openBox = async (page: Page, taskId: string): Promise<void> => {
  await openTask(page, taskId);
  const attach = page.locator("[data-part='composer'] [data-action='attach']");
  await hydrated(attach);
  await expect(attach).toHaveAttribute("aria-disabled", "false");
};

test.describe.configure({ mode: "serial" });

// The phone project runs the phone's own test; the rest drag, hover and walk at desktop width.
test.beforeEach(({ isMobile }, testInfo) => {
  test.skip(isMobile && !testInfo.title.startsWith("at phone width"), "a desktop check");
});

test("F-148/c1, F-150/c1: a member attaches a PNG and a .docx by the paperclip, by pasting and by dropping, removes one, and sends files with no words; the .docx's chip says its text was extracted", async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page, world.username, e2eAdmin.password);
  await openBox(page, world.composerTaskId);
  const field = page.getByRole("textbox", { name: "Message the agent" });

  // The paperclip: a picture and a Word document.
  await page.getByTestId("attach-input").setInputFiles([await png("wrong-total.png"), await docx()]);
  await expectUploaded(page, 2);
  await expect(tray(page).locator("[data-look='image'] img")).toHaveAttribute("src", /^blob:/);
  // F-150/c1: core read the document's text, and its chip says so.
  await expect(tray(page).locator("[data-tray-item]", { hasText: "history-panel-spec.docx" }).locator("[data-part='text-extracted']")).toBeVisible();

  // Paste: a screenshot, named by the time, and a copied document.
  await paste(field, [await png("image.png", "pasted"), await docx("rounding-rules.docx")]);
  await expectUploaded(page, 4);
  await expect(trayItems(page).nth(2)).toHaveAttribute("aria-label", /^Pasted image \d\d\.\d\d\.\d\d\.png, PNG/);

  // Drop on the chat column: the zone shows while the files are over the page.
  await drop(page, page.locator("[data-chat-column]"), [await png("phone-total.png", "phone"), await docx("percent-spec.docx")], shots === undefined ? null : async () => { await shoot(page, "composer-drop"); });
  await expectUploaded(page, 6);
  if (shots !== undefined) {
    await field.fill("Here's Dana's mock and the spec. Keep \"Use\" on the right of each row, and use the sample for the tests.");
    await shoot(page, "composer-attachments");
    await field.fill("");
  }

  // Remove one before sending.
  await page.getByRole("button", { name: "Remove percent-spec.docx" }).click();
  await expect(trayItems(page)).toHaveCount(5);

  // Files with no words are a message: it goes, the tray empties, and the thread shows them under it.
  await page.locator("[data-part='composer'] [data-action='send']").click();
  await expect(trayItems(page)).toHaveCount(0);
  const sent = page.locator("[data-role='user']").filter({ has: page.locator("[data-part='message-files']") }).last();
  await expect(sent.locator("[data-part='file-thumb']")).toHaveCount(3);
  await expect(sent.locator("[data-testid='message-file-chips'] a[data-file]")).toHaveCount(2);
  await expect(sent.locator("a[data-file]", { hasText: "history-panel-spec.docx" }).locator("[data-part='text-extracted']")).toBeVisible();
});

test("F-148/c2: the box refuses a file over a limit as it arrives, naming it, with the server's numbers", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openBox(page, world.textOnlyTaskId);
  // The server's limits (`files.limits`): 10 files, 10 MB each, 25 MB in all on this stack.
  const limits = z.object({ result: z.object({ data: z.object({ maxFiles: z.number(), maxFileBytes: z.number(), maxTotalBytes: z.number() }) }) }).parse(await (await page.request.get("/api/trpc/files.limits")).json()).result.data;
  const big = { name: "design-review.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(limits.maxFileBytes + 1024 * 1024, 1) };
  await page.getByTestId("attach-input").setInputFiles([big, await png("a.png")]);
  await expect(page.getByTestId("composer-note")).toHaveText(`design-review.mov wasn't added: it's ${String(Math.round(big.buffer.length / (1024 * 1024)))} MB, and a file can be up to ${String(limits.maxFileBytes / (1024 * 1024))} MB.`);
  await expectUploaded(page, 1);
  if (shots !== undefined) await shoot(page, "composer-state-too-big");
  // Past the count: the rest are counted in one note, and the paperclip turns off.
  const many = await Promise.all(Array.from({ length: limits.maxFiles }, (_, i) => png(`shot-${String(i)}.png`, "phone")));
  await page.getByTestId("attach-input").setInputFiles(many);
  await expect(page.getByTestId("composer-note")).toHaveText(`1 more wasn't added: a message holds up to ${String(limits.maxFiles)} files.`);
  await expect(trayItems(page)).toHaveCount(limits.maxFiles);
  await expect(page.locator("[data-part='composer'] [data-action='attach']")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("composer-hint")).toHaveText(`${String(limits.maxFiles)} of ${String(limits.maxFiles)} files`);
  if (shots !== undefined) await shoot(page, "composer-state-full");
});

test("F-148/c5: the box says before sending that the model can't see images, and the thread says it after; an admin's Reads images changes it", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.username, e2eAdmin.password);
  // A model that sees images: no note.
  await openBox(page, world.composerTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("mock.png", "mock")]);
  await expectUploaded(page, 1);
  await expect(page.getByTestId("composer-note")).toHaveCount(0);

  // The text-only model: the note, then the same under the sent message.
  await openBox(page, world.textOnlyTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("wrong-total.png"), await png("phone-total.png", "phone")]);
  await expectUploaded(page, 2);
  await expect(page.getByTestId("composer-note")).toHaveText("DeepSeek V4.1 Flash can't see images; the agent gets them as files.");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Both screens round 12.5% of 845 down.");
  if (shots !== undefined) await shoot(page, "composer-state-model");
  await page.locator("[data-part='composer'] [data-action='send']").click();
  const sent = page.locator("[data-role='user']").filter({ hasText: "Both screens round" }).last();
  await expect(sent.getByTestId("images-not-sent")).toHaveText(/can't see images: .+ got them as files\./);

  // The admin's word: Reads images on, the note goes; back to the catalog's, which says nothing, the note says so.
  await page.goto(`/organization/models?model=${world.deepseekModelId}`);
  const switcher = page.getByRole("switch", { name: "DeepSeek V4.1 Flash reads images" });
  await expect(switcher).toBeVisible();
  await switcher.click();
  await expect(page.getByTestId("model-reads-images")).toHaveText(/^Yes/);
  await openBox(page, world.textOnlyTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("again.png")]);
  await expectUploaded(page, 1);
  await expect(page.getByTestId("composer-note")).toHaveCount(0);
  await page.goto(`/organization/models?model=${world.deepseekModelId}`);
  await page.locator("[data-action='images-use-catalog']").click();
  await expect(page.getByTestId("model-reads-images")).toHaveText(/^No/);
  await openBox(page, world.textOnlyTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("unknown.png")]);
  await expectUploaded(page, 1);
  await expect(page.getByTestId("composer-note")).toHaveText("ostra doesn't know whether DeepSeek V4.1 Flash can see images; the agent gets them as files.");

  // The seed's word again for the tests after this one: the admin's text only (on, then off).
  await page.goto(`/organization/models?model=${world.deepseekModelId}`);
  await switcher.click();
  await expect(page.getByTestId("model-reads-images")).toHaveText(/^Yes/);
  await switcher.click();
  await expect(page.getByTestId("model-reads-images")).toHaveText(/^No/);
  await expect(page.locator("[data-action='images-use-catalog']")).toBeVisible();
});

test("F-148/c9: on a runner below protocol minor 8 the box says the runner needs upgrading, and holds the files", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openBox(page, world.oldRunnerTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("a.png")]);
  await expectUploaded(page, 1);
  await expect(page.getByTestId("composer-note")).toHaveText(/^alex-laptop-.+ runs an older ostra and can't take files: update it, or remove them to send\.$/);
  await expect(page.locator("[data-part='composer'] [data-action='send']")).toBeDisabled();
  if (shots !== undefined) await shoot(page, "composer-state-runner");
});

test("F-148/c3, F-150/c1: a message's thumbnails open the viewer and its chips download, after a reload too; a document's chip says its text was extracted", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openTask(page, world.threadTaskId);
  const message = page.locator("[data-role='user']").filter({ has: page.locator("[data-part='message-files']") });
  await expect(message.locator("[data-part='file-thumb'] img").first()).toHaveJSProperty("complete", true);
  // F-150/c1: the PDF's and the docx's chips say their text was extracted, its tooltip with the words.
  const pdfChip = message.locator("a[data-file]", { hasText: "brand-guide.pdf" });
  await expect(pdfChip.locator("[data-part='text-extracted']")).toBeVisible();
  await pdfChip.hover();
  await expect(page.getByRole("tooltip")).toContainText("ostra took the text out of this file, 6,210 words");
  if (shots !== undefined) await shoot(page, "message-attachments");

  for (const pass of ["first", "after a reload"]) {
    if (pass !== "first") await page.reload();
    await message.getByRole("button", { name: "Image history-panel-mock.png from Sam Rivera, open" }).click();
    const viewer = page.getByTestId("attachment-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("heading", { name: "Attachments" }).or(viewer.getByText("Attachments", { exact: true }))).toBeVisible();
    await expect(viewer.getByTestId("viewer-position")).toContainText("Sam Rivera's message at");
    await expect(viewer.getByTestId("viewer-position")).toContainText("1 of 2");
    await expect(viewer.getByTestId("viewer-picture")).toHaveJSProperty("complete", true);
    if (pass === "first" && shots !== undefined) await shoot(page, "message-attachments-viewer");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    // The chip downloads the file, as an attachment under its own name.
    const href = await message.locator("a[data-file]", { hasText: "history-panel-spec.docx" }).getAttribute("href");
    expect(href).toMatch(/^\/api\/tasks\/.+\/files\/.+$/);
    const response = await page.request.get(href ?? "");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
});

test("F-149/c5: the ticket task's first message shows what the agent got: the description, files, links and comments", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openTask(page, world.ticketTaskId);
  const got = page.locator("[data-part='ticket-context']");
  await expect(got).toContainText("What the agent got");
  await expect(got.locator("[data-part='ticket-description']")).toContainText("Percent mode rounds half-cents down.");
  await expect(got.getByTestId("ticket-images").locator("[data-part='file-thumb']")).toHaveCount(3);
  await expect(got.locator("a[data-file]", { hasText: "rounding-rules.docx" }).locator("[data-part='text-extracted']")).toBeVisible();
  await expect(got.getByRole("link", { name: "Sentry · ACME-WEB-4F2, link, opens in a new tab" })).toContainText("Link · not fetched");
  await expect(got.locator("[data-part='ticket-comment']")).toHaveCount(2);
  await got.getByRole("button", { name: "Show 1 more" }).click();
  await expect(got.locator("[data-part='ticket-comment']")).toHaveCount(3);
  await expect(got.getByTestId("ticket-context-where")).toContainText(".ostra/ticket/");
  await expect(page.locator("[data-part='ticket-files']")).toHaveCount(0);
  await expect(page.getByTestId("ticket-context-row")).toHaveText("7 attachments · 3 comments");
  // The description's picture is its name, opening the viewer on the ticket's pictures.
  await got.getByRole("button", { name: "Show all" }).click();
  await got.locator("[data-part='description-image']").click();
  const viewer = page.getByTestId("attachment-viewer");
  await expect(viewer).toContainText("The ticket's attachments");
  await expect(viewer.getByTestId("viewer-facts")).toContainText("the description");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  if (shots !== undefined) {
    const less = got.getByRole("button", { name: "Show less" });
    while ((await less.count()) > 0) await less.first().click();
    await shoot(page, "ticket-context");
  }
});

test("F-149/c3: a file the ticket's limits left out is named with why, a failed one keeps its place with why, and Retry fetches it", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openTask(page, world.skippedTaskId);
  const skipped = page.locator("[data-part='ticket-context']");
  await expect(skipped.locator("[data-part='files-left-out']")).toContainText("3 left out, and the agent was told which");
  await expect(skipped.locator("[data-part='files-left-out']")).toContainText("support-call.mp4");
  await expect(skipped.locator("[data-part='files-left-out']")).toContainText("84 MB, over the 10 MB a file can be");
  await expect(skipped.locator("[data-part='files-left-out']")).toContainText("past the 20 attachments a ticket can give");
  if (shots !== undefined) await shoot(page, "ticket-context-skipped");

  await openTask(page, world.failedTaskId);
  const failed = page.locator("[data-part='ticket-context']");
  await expect(failed.locator("[data-part='thumb-missing']")).toHaveCount(1);
  await expect(failed.locator("[data-part='file-missing']")).toHaveCount(1);
  await expect(failed.getByTestId("ticket-files-failed")).toContainText("2 attachments didn't load from Linear");
  await expect(page.getByTestId("ticket-context-row")).toHaveText("2 attachments didn't load");
  if (shots !== undefined) await shoot(page, "ticket-context-failed");
  await failed.locator("[data-action='retry-ticket-files']").click();
  // Core's job fetches them and writes the next read: the places fill in, the block goes.
  await seed({ scenario: "round", taskId: world.failedTaskId, answer: "retry-loaded", picture: pictures.wrong });
  await expect(failed.getByTestId("ticket-files-failed")).toBeHidden({ timeout: 20_000 });
  await expect(failed.locator("[data-part='thumb-missing']")).toHaveCount(0);
  await expect(page.getByTestId("ticket-retry-live")).toHaveText("2 attachments loaded");
});

test("F-149/c6: a tracker that fetches no files says so in what the agent got", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openTask(page, world.noneTaskId);
  await expect(page.getByTestId("ticket-files-not-fetched")).toHaveText("The ticket's files weren't fetched: Linear doesn't offer them.");
});

test("F-149/c8: Send ticket updates goes for the driver, and says when nothing's new on the ticket", async ({ page }) => {
  await signIn(page, world.username, e2eAdmin.password);
  await openTask(page, world.ticketTaskId);
  await page.locator("[data-action='send-ticket-updates']").click();
  await expect(page.locator("[data-action='send-ticket-updates']")).toHaveText("Reading the ticket…");
  await seed({ scenario: "round", taskId: world.ticketTaskId, answer: "nothing-new", picture: pictures.wrong });
  await expect(page.getByTestId("ticket-updates-answer")).toHaveText("Nothing new on the ticket since the agent read it.", { timeout: 20_000 });
});

test("F-148/c1: the new-task box takes files, says what the model takes, and starts the task with them; files alone don't start one", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.username, e2eAdmin.password);
  await page.goto(`/tasks/new?project=${world.projectId}`);
  await expect(page.getByTestId("model-takes")).toHaveText("text only");
  await hydrated(page.locator("[data-action='attach']"));
  await expect(page.locator("[data-action='attach']")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("attach-input").setInputFiles([await png("wrong-total.png"), await png("phone-total.png", "phone"), await docx("rounding-rules.docx")]);
  await expectUploaded(page, 3);
  await expect(page.getByTestId("composer-note")).toHaveText("DeepSeek V4.1 Flash can't see images; the agent gets them as files.");
  await expect(page.getByTestId("new-task-attachments")).toContainText("2 images · 1 file");
  await expect(page.getByTestId("next-files").last()).toContainText(".ostra/attachments/1/");
  await expect(page.locator("[data-action='start-task']")).toBeDisabled();
  await page.locator("#new-task-prompt").fill("Percent mode rounds half-cents down: 12.5% of 845 shows 105.62 where finance expects 105.63. Round half up, to the cent.");
  if (shots !== undefined) await shoot(page, "new-task-attachments");
  await page.locator("[data-action='start-task']").click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const first = page.locator("[data-role='user']").first();
  await expect(first.locator("[data-part='file-thumb']")).toHaveCount(2);
  await expect(first.locator("a[data-file]", { hasText: "rounding-rules.docx" })).toBeVisible();
});

test("F-081/c2: the keyboard walk and the contrast check pass on the box with files, the thread's files and what the agent got, in both themes", async ({ page }) => {
  test.setTimeout(240_000);
  await prepareA11y(page);
  await signIn(page, world.username, e2eAdmin.password);
  const problems: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await page.waitForLoadState("networkidle");
    expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
    const visit = async (taskId: string, ready: () => Promise<void>, label: string): Promise<void> => {
      await page.goto(`/tasks/${taskId}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await ready();
      await settleRoute(page);
      problems.push(...(await checkContrast(page, null)).failures.map((failure) => `${label} (${theme}): ${failure}`));
      problems.push(...(await walkByTab(page, null)).map((problem) => `${label} (${theme}): ${problem}`));
    };
    await visit(
      world.composerTaskId,
      async () => {
        const attach = page.locator("[data-part='composer'] [data-action='attach']");
        await hydrated(attach);
        await expect(attach).toHaveAttribute("aria-disabled", "false");
        await page.getByTestId("attach-input").setInputFiles([await png("a.png"), await docx()]);
        await expectUploaded(page, 2);
      },
      "the box with files",
    );
    await visit(world.threadTaskId, () => expect(page.locator("[data-part='message-files'] [data-part='file-thumb'] img").first()).toHaveJSProperty("complete", true), "the thread's files");
    await visit(world.failedTaskId, () => expect(page.locator("[data-part='ticket-context']")).toBeVisible(), "what the agent got");
  }
  expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme: "dark" }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
  expect(problems).toEqual([]);
});

test("at phone width the box docks under the chat with its files above the field, and a message's files and the new task's box take the column", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  test.setTimeout(120_000);
  await signIn(page, world.username, e2eAdmin.password);
  await openBox(page, world.textOnlyTaskId);
  await page.getByTestId("attach-input").setInputFiles([await png("wrong-total.png"), await png("phone-total.png", "phone"), await docx("rounding-rules.docx"), { name: "percent-cases.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") }]);
  await expectUploaded(page, 4);
  // The dock's row: a 44px paperclip, the field and the send; the tray one row that scrolls.
  const attach = page.locator("[data-part='composer'] [data-action='attach']");
  expect((await attach.boundingBox())?.height).toBe(44);
  await expect(tray(page)).toHaveCSS("flex-wrap", "nowrap");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("The phone build too. Finance's rules are in the docx.");
  if (shots !== undefined) await shoot(page, "composer-phone-dock");
  await openTask(page, world.threadTaskId);
  const chips = page.locator("[data-part='message-files']").getByTestId("message-file-chips");
  await expect(chips).toHaveCSS("flex-direction", "column");
  if (shots !== undefined) {
    await chips.scrollIntoViewIfNeeded();
    await shoot(page, "composer-phone-message");
  }
  await page.goto(`/tasks/new?project=${world.projectId}`);
  await hydrated(page.locator("[data-action='attach']"));
  await expect(page.locator("[data-action='attach']")).toHaveAttribute("aria-disabled", "false");
  await page.locator("#new-task-prompt").fill("Percent mode rounds half-cents down: 12.5% of 845 shows 105.62. Round half up, to the cent, as finance's rules say.");
  await page.getByTestId("attach-input").setInputFiles([await png("wrong-total.png"), await png("phone-total.png", "phone"), await docx("rounding-rules.docx")]);
  await expectUploaded(page, 3);
  await expect(page.getByTestId("next-files").first()).toBeVisible();
  if (shots !== undefined) await shoot(page, "composer-phone-new-task");
});
