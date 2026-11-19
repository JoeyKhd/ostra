import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LaunchSkill, Logger } from "@ostra/adapter-sdk";
import { runnerLimits } from "@ostra/protocol";
import type { BlobId, LeaseEpoch, TaskId, TaskSpecSkill } from "@ostra/protocol";
import type { ServerLink } from "./server-link.ts";

// The profile's skills at launch (ticket 29, F-021, ADR 0049): each skill's `SKILL.md` and files
// come down the bulk path (milestone 2's, as the ticket's files do), checked against the digest
// core sent, and are written into the task's own agent folder, `<agentDir>/skills/<name>/`, never
// into a repo. The adapter is handed the folders (`prepareLaunch`'s `skills`). A skill that can't
// be fetched or written whole is left out and named in the log; the task starts without it.

/** The skills folder in the task's agent folder. */
export const skillsDir = (agentDir: string): string => path.join(agentDir, "skills");

export type WriteSkillsInput = {
  readonly link: Pick<ServerLink, "downloadBlob">;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly skills: readonly TaskSpecSkill[];
  readonly agentDir: string;
  readonly logger: Logger;
};

export type WrittenSkills = {
  readonly skills: readonly LaunchSkill[];
  /** The skills left out, by name. */
  readonly skipped: readonly string[];
};

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** `target` is inside `dir`, by the resolved paths. */
const inside = (dir: string, target: string): boolean => {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const writeSkills = async (input: WriteSkillsInput): Promise<WrittenSkills> => {
  const root = skillsDir(input.agentDir);
  const written: LaunchSkill[] = [];
  const skipped: string[] = [];
  const names = new Set<string>();
  const download = async (blobId: BlobId): Promise<Buffer | null> => {
    const downloaded = await input.link.downloadBlob({ taskId: input.taskId, leaseEpoch: input.leaseEpoch, blobId, maxBytes: runnerLimits.skillFileMaxBytes });
    if (!downloaded.ok) {
      return null;
    }
    const { bytes, sha256 } = downloaded.value;
    // A copy that differs from the digest core named is never written.
    return sha256 !== null && sha256Of(bytes) === sha256 ? bytes : null;
  };
  for (const skill of input.skills.slice(0, runnerLimits.skillsMax)) {
    const dir = path.join(root, skill.name);
    if (names.has(skill.name) || !inside(root, dir)) {
      skipped.push(skill.name);
      continue;
    }
    const files: { readonly target: string; readonly bytes: Buffer }[] = [];
    const main = await download(skill.blobId);
    let whole = main !== null;
    if (main !== null) {
      files.push({ target: path.join(dir, "SKILL.md"), bytes: main });
    }
    for (const file of skill.files.slice(0, runnerLimits.skillFilesMax)) {
      const target = path.join(dir, ...file.path.split("/"));
      const bytes = whole && inside(dir, target) && path.resolve(target) !== path.resolve(dir, "SKILL.md") ? await download(file.blobId) : null;
      if (bytes === null) {
        whole = false;
        break;
      }
      files.push({ target, bytes });
    }
    if (!whole) {
      skipped.push(skill.name);
      input.logger.warn("a skill was left out", { skill: skill.name, reason: "download-failed" });
      continue;
    }
    try {
      for (const file of files) {
        await mkdir(path.dirname(file.target), { recursive: true });
        await writeFile(file.target, file.bytes, { mode: 0o644 });
      }
    } catch {
      skipped.push(skill.name);
      input.logger.warn("a skill was left out", { skill: skill.name, reason: "write-failed" });
      continue;
    }
    names.add(skill.name);
    written.push({ name: skill.name, dir });
  }
  input.logger.info("skills written", { written: written.length, skipped: skipped.length });
  return { skills: written, skipped };
};
