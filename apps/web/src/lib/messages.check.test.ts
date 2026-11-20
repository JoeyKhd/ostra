import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { checkSource, unusedKeys } from "./messages-check";

// F-083 (ticket 20): every word of the panel is in `messages/en.json`, read through `t`. This runs
// in `pnpm test` (no change to ci.yml): an AST check of `apps/web/src` and `packages/task-view/src`
// for JSX text and shown attributes that bypass `t`, and every key of `en.json` named somewhere.

const webDir = path.resolve(import.meta.dirname, "..", "..");
const repoRoot = path.resolve(webDir, "..", "..");
const roots = [path.join(webDir, "src"), path.join(repoRoot, "packages", "task-view", "src")];

const allowedSchema = z.strictObject({
  $comment: z.string(),
  allowed: z.array(z.strictObject({ text: z.string().min(1), reason: z.string().min(10) })),
});

const sourcesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .map((entry) => path.join(dir, entry))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes(`${path.sep}testing${path.sep}`) && !file.endsWith(`${path.sep}messages-check.ts`));
};

const readSources = async () => {
  const files = (await Promise.all(roots.map(sourcesUnder))).flat();
  return Promise.all(files.map(async (file) => ({ file: path.relative(repoRoot, file).replaceAll("\\", "/"), source: await readFile(file, "utf8") })));
};

const readAllowed = async () => allowedSchema.parse(JSON.parse(await readFile(path.join(webDir, "messages", "allowed-literals.json"), "utf8"))).allowed;
const readMessages = async (): Promise<unknown> => JSON.parse(await readFile(path.join(webDir, "messages", "en.json"), "utf8"));

describe("the message-file check", () => {
  it("F-083/c1: no JSX text, aria-label, title, placeholder, alt or toast in apps/web and task-view bypasses t", async () => {
    const allowed = await readAllowed();
    const findings = (await readSources()).filter(({ file }) => file.endsWith(".tsx")).flatMap(({ file, source }) => checkSource(file, source, allowed));
    expect(findings.map((finding) => `${finding.file}:${String(finding.line)} ${finding.kind}${finding.attribute === undefined ? "" : `[${finding.attribute}]`} ${JSON.stringify(finding.text)}`)).toEqual([]);
  });

  it("F-083/c1: every key of en.json is used somewhere, and none is unused", async () => {
    expect(unusedKeys(await readMessages(), await readSources())).toEqual([]);
  });

  it("F-083/c1: every allowed literal is still in a source, with its reason", async () => {
    const allowed = await readAllowed();
    const sources = (await readSources()).filter(({ file }) => file.endsWith(".tsx"));
    const all = sources.flatMap(({ file, source }) => checkSource(file, source));
    expect(allowed.filter((entry) => !all.some((finding) => finding.text === entry.text)).map((entry) => entry.text)).toEqual([]);
  });

  it("F-083/c1: the check finds a planted literal in JSX text, in a shown expression and in an attribute", () => {
    const planted = [
      "export const A = () => <p>Hello there</p>;",
      'export const B = ({ ok }: { ok: boolean }) => <p>{ok ? "Saved" : t("common.no")}</p>;',
      'export const C = () => <button aria-label="Close the sheet" />;',
      'export const D = () => <input placeholder={`Search ${"all"}`} />;',
      'export const E = () => <img alt="A runner" title={name ?? "Untitled"} />;',
      'export const F = () => { toast("Copied"); return null; };',
    ].join("\n");
    const findings = checkSource("planted.tsx", planted);
    expect(findings.map((finding) => [finding.line, finding.kind, finding.attribute ?? null, finding.text])).toEqual([
      [1, "jsx-text", null, "Hello there"],
      [2, "jsx-literal", null, "Saved"],
      [3, "attribute", "aria-label", "Close the sheet"],
      [4, "attribute", "placeholder", "Search"],
      [4, "attribute", "placeholder", "all"],
      [5, "attribute", "alt", "A runner"],
      [5, "attribute", "title", "Untitled"],
      [6, "toast", null, "Copied"],
    ]);
  });

  it("F-083: what goes through t, a name the allowlist gives, punctuation and entities pass", () => {
    const clean = [
      'export const A = () => <p title={t("common.close")}>{t("common.save")} · {count}</p>;',
      'export const B = () => <kbd aria-label={t("common.close")}>⌘K</kbd>;',
      'export const C = ({ a }: { a: string }) => <p>{a === "open" ? t("common.yes") : t("common.no")}&nbsp;–&nbsp;</p>;',
      'export const D = () => <img alt="" />;',
    ].join("\n");
    expect(checkSource("clean.tsx", clean, [{ text: "⌘K", reason: "A keyboard shortcut." }])).toEqual([]);
  });

  it("F-083/c1: the check finds an unused key, and a template that spells a key's start counts as using it", () => {
    const messages = { common: { save: "Save", gone: "Gone" }, reason: { one: "One", two: "Two" } };
    const sources = [
      { file: "a.tsx", source: 'export const A = () => <p>{t("common.save")}</p>;' },
      { file: "b.ts", source: "export const reasonText = (r: string) => t(`reason.${r}`);" },
    ];
    expect(unusedKeys(messages, sources)).toEqual(["common.gone"]);
    // A template with no key of its own (`${a}.${b}`) uses nothing.
    expect(unusedKeys({ x: { y: "Y" } }, [{ file: "c.ts", source: "export const k = (a: string, b: string) => `${a}.${b}`;" }])).toEqual(["x.y"]);
  });
});
