import { treeFolderOf } from "@ostra/adapter-sdk";
import { runnerLimits } from "@ostra/protocol";

import { skillFilesOf } from "./hash.ts";
import type { SkillFile } from "./hash.ts";
import { SKILL_NAME } from "./reference.ts";

// F-145 (ADR 0069, ticket 06): a skill checked before it's installed, against the Agent Skills
// spec's front matter (research §2.7) and ostra's limits (ADR 0049), with the files that look like
// scripts pointed out for the install dialog, since a skill can tell the agent to run them
// (research §5.1). Every problem is listed, each in words the dialog shows. The front matter is
// read here, without a YAML library: only the top-level scalars `name` and `description` matter,
// plain, quoted, or as a `|` or `>` block. Pure; a skill's text is never logged.

/** ostra's limits on a skill: `SKILL.md` and at most 20 more files, each at most 1 MiB (ADR 0049). */
export const skillLimits = {
  filesMax: runnerLimits.skillFilesMax,
  fileMaxBytes: runnerLimits.skillFileMaxBytes,
  nameMaxChars: 64,
  descriptionMaxChars: 1024,
} as const;

/** A skill's file as a host read it: its bytes, and whether git keeps it executable. */
export type CheckedSkillFile = SkillFile & { readonly executable: boolean };

export type SkillProblemCode =
  | "no-skill-md"
  | "skill-md-twice"
  | "no-front-matter"
  | "name-missing"
  | "name-invalid"
  | "name-not-folder"
  | "description-missing"
  | "description-too-long"
  | "too-many-files"
  | "file-too-large"
  | "path-outside";

export type SkillProblem = { readonly code: SkillProblemCode; readonly message: string; readonly path: string | null };

/** Why a file looks like a script: under `scripts/`, starting with `#!`, or with its executable bit. */
export type ScriptReason = "scripts-folder" | "shebang" | "executable";

export type ScriptFile = { readonly path: string; readonly reasons: readonly ScriptReason[] };

export type SkillCheck =
  | { readonly ok: true; readonly name: string; readonly description: string; readonly scripts: readonly ScriptFile[] }
  | { readonly ok: false; readonly problems: readonly SkillProblem[]; readonly scripts: readonly ScriptFile[] };

const decoder = new TextDecoder();

/** A scalar's value from its text after `key:`, and the lines that follow (a block, or a plain scalar's continuation). */
const scalarOf = (first: string, following: readonly string[]): string | null => {
  const head = first.trim();
  if (head === "|" || head === ">" || /^[|>][+-]?\d*$/.test(head)) {
    const block: string[] = [];
    for (const line of following) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      block.push(line);
    }
    const indent = Math.min(...block.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
    const lines = block.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n").replace(/\s+$/, "");
    return head.startsWith(">") ? lines.replace(/([^\n])\n(?=[^\n\s])/g, "$1 ") : lines;
  }
  if (head.startsWith("'")) {
    const end = head.lastIndexOf("'");
    return end > 0 ? head.slice(1, end).replaceAll("''", "'") : null;
  }
  if (head.startsWith('"')) {
    const end = head.lastIndexOf('"');
    return end > 0 ? head.slice(1, end).replace(/\\(["\\/nt])/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char)) : null;
  }
  // A plain scalar, with its comment cut, goes on over the indented lines after it.
  const continued = [head.replace(/\s+#.*$/, "")];
  for (const line of following) {
    if (line.trim() === "" || !/^\s/.test(line)) break;
    continued.push(line.trim());
  }
  return continued.join(" ").trim();
};

/** `SKILL.md`'s top-level `name` and `description`, or `null` when it opens with no front matter. */
export const skillFrontMatter = (text: string): { readonly name: string | null; readonly description: string | null } | null => {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    return null;
  }
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."));
  if (end === -1) {
    return null;
  }
  const front = lines.slice(1, end);
  const field = (key: string): string | null => {
    const index = front.findIndex((line) => line.startsWith(`${key}:`));
    if (index === -1) {
      return null;
    }
    const line = front[index] ?? "";
    return scalarOf(line.slice(key.length + 1), front.slice(index + 1));
  };
  return { name: field("name"), description: field("description") };
};

/** Whether a file looks like a script, and why. */
const scriptReasons = (file: CheckedSkillFile): ScriptReason[] => {
  const reasons: ScriptReason[] = [];
  if (file.path.startsWith("scripts/") || file.path.includes("/scripts/")) reasons.push("scripts-folder");
  if (file.bytes[0] === 0x23 && file.bytes[1] === 0x21) reasons.push("shebang");
  if (file.executable) reasons.push("executable");
  return reasons;
};

/**
 * Checks a skill's files, paths relative to its folder, which is named `folder` (the last part of
 * its path in the repo, or its name in a well-known index). The files the installer leaves out
 * (`metadata.json`, `.git` and the rest, as the hash does) aren't counted.
 */
export const checkSkill = (input: { readonly folder: string; readonly files: readonly CheckedSkillFile[] }): SkillCheck => {
  const problems: SkillProblem[] = [];
  const problem = (code: SkillProblemCode, message: string, path: string | null = null): void => {
    problems.push({ code, message, path });
  };
  const files = skillFilesOf(input.files);
  const scripts = files.map((file) => ({ path: file.path, reasons: scriptReasons(file) })).filter((file) => file.reasons.length > 0);

  for (const file of files) {
    if (treeFolderOf(file.path) !== file.path || file.path === "") {
      problem("path-outside", `${file.path} isn't a path inside the skill's folder`, file.path);
    }
    if (file.bytes.length > skillLimits.fileMaxBytes) {
      problem("file-too-large", `${file.path} is over 1 MiB, the most a skill's file holds`, file.path);
    }
  }
  const skillMds = files.filter((file) => (file.path.split("/").at(-1) ?? "").toLowerCase() === "skill.md");
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (skillMd === undefined) {
    problem("no-skill-md", "The skill has no SKILL.md at its folder's top");
  } else if (skillMds.length > 1) {
    problem("skill-md-twice", "The skill's folder holds more than one SKILL.md: each skill is its own folder");
  }
  const others = files.length - (skillMd === undefined ? 0 : 1);
  if (others > skillLimits.filesMax) {
    problem("too-many-files", `The skill has ${String(others)} files besides SKILL.md: ostra takes at most ${String(skillLimits.filesMax)}`);
  }

  let name: string | null = null;
  let description: string | null = null;
  if (skillMd !== undefined) {
    const front = skillFrontMatter(decoder.decode(skillMd.bytes));
    if (front === null) {
      problem("no-front-matter", "SKILL.md doesn't start with front matter between --- lines", "SKILL.md");
    } else {
      name = front.name;
      description = front.description;
      if (name === null || name === "") {
        problem("name-missing", "SKILL.md's front matter has no name", "SKILL.md");
      } else if (!SKILL_NAME.test(name) || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
        problem("name-invalid", "A skill's name is at most 64 lowercase letters, digits and single dashes", "SKILL.md");
      } else if (name !== input.folder) {
        problem("name-not-folder", `The skill is named ${name}, and its folder ${input.folder}: the two must match`, "SKILL.md");
      }
      if (description === null || description.trim() === "") {
        problem("description-missing", "SKILL.md's front matter has no description", "SKILL.md");
      } else if (description.length > skillLimits.descriptionMaxChars) {
        problem("description-too-long", `The skill's description is over ${String(skillLimits.descriptionMaxChars)} characters`, "SKILL.md");
      }
    }
  }
  if (problems.length > 0 || name === null || description === null) {
    return { ok: false, problems, scripts };
  }
  return { ok: true, name, description, scripts };
};
