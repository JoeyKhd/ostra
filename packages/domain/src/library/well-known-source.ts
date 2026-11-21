import { gunzip } from "node:zlib";

import { createTreeCollector, readTar } from "@ostra/adapter-sdk";
import type { RepoTree } from "@ostra/adapter-sdk";

import { skillLimits } from "./check-skill.ts";
import type { SkillProblem } from "./check-skill.ts";
import { sha256Hex, SKILL_READ_LIMITS, skillReadOf } from "./github-source.ts";
import type { SkillRead, SourceFailure } from "./github-source.ts";
import { callOut, jsonOf, outboundFailureWords } from "./outbound.ts";
import type { OutboundDeps } from "./outbound.ts";
import { parseWellKnownIndex, WELL_KNOWN_INDEX_PATHS } from "./vendor.ts";
import type { WellKnownEntry } from "./vendor.ts";

// F-145 (ADR 0069, ticket 27): skills from a site that serves the well-known index
// (`/.well-known/agent-skills/index.json`, then the legacy `/.well-known/skills/index.json`),
// v0.2.0 with a digest per entry. Each entry's bytes must match its digest: a mismatch refuses the
// look and the install, never falling back to anything without integrity (research §2.2). Every
// call goes to the site the admin named: an entry on another origin is never fetched, and a
// redirect only on the same origin is followed. An entry is a `SKILL.md`, or a `.tar.gz` of the
// skill's folder. Nothing the site serves reaches a log line or an error's words.

/** The whole look's deadline *(working value)*. */
const WELL_KNOWN_DEADLINE_MS = 30_000;
const INDEX_MAX_BYTES = 1024 * 1024;
/** An archive's most, as the `skills` CLI's direct download: 10 MiB down, 25 MiB unpacked. */
const ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_UNPACKED_MAX_BYTES = 25 * 1024 * 1024;
/** The most entries one look reads *(working value)*. */
export const WELL_KNOWN_ENTRIES_MAX = 50;

export type WellKnownSkills = {
  readonly ok: true;
  readonly skills: readonly SkillRead[];
  /** Entries of the index that don't read, or sit on another origin: never fetched. */
  readonly dropped: number;
};

const unavailable = (message: string): SourceFailure => ({ ok: false, error: "unavailable", message });

/** The site's index: the first of the two paths that answers, read as v0.2.0, and its own URL. */
const readIndex = async (deps: OutboundDeps, site: string, signal: AbortSignal): Promise<{ readonly ok: true; readonly url: string; readonly entries: readonly WellKnownEntry[]; readonly dropped: number } | SourceFailure> => {
  for (const path of WELL_KNOWN_INDEX_PATHS) {
    const url = `${site}${path}`;
    const answer = await callOut(deps, url, { headers: { accept: "application/json" }, maxBytes: INDEX_MAX_BYTES, signal, followRedirects: true });
    if (!answer.ok) {
      return unavailable(outboundFailureWords("The site's skills index", answer.failure));
    }
    if (answer.answer.status === 404) {
      continue;
    }
    if (answer.answer.status === 429) {
      return { ok: false, error: "rate-limited", message: "The site is limiting how often its skills index is read: try again later" };
    }
    if (answer.answer.status < 200 || answer.answer.status >= 300) {
      return unavailable(`The site's skills index answered HTTP ${String(answer.answer.status)}`);
    }
    const index = parseWellKnownIndex(jsonOf(answer.answer.bytes));
    if (index === null) {
      return {
        ok: false,
        error: "not-found",
        message: "The site's skills index isn't the v0.2.0 index with a digest for each skill, which ostra installs from",
      };
    }
    return { ok: true, url: answer.answer.url, entries: index.entries, dropped: index.dropped };
  }
  return { ok: false, error: "not-found", message: "The site serves no skills index at /.well-known/agent-skills/index.json or /.well-known/skills/index.json" };
};

/** An entry's address, only on the site's own origin. */
const entryUrl = (entry: WellKnownEntry, indexUrl: string): string | null => {
  if (!URL.canParse(entry.url, indexUrl)) {
    return null;
  }
  const url = new URL(entry.url, indexUrl);
  return url.origin === new URL(indexUrl).origin && url.protocol === "https:" ? url.toString() : null;
};

const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b;

const unreadable = (message: string): SkillProblem => ({ code: "unreadable", message, path: null });

/**
 * A skill's `.tar.gz`: its files, the folder's own or under the one top folder they all share, a
 * symlink followed only inside it, within the skill's caps.
 */
const unpackArchive = async (bytes: Uint8Array): Promise<{ readonly ok: true; readonly tree: RepoTree } | { readonly ok: false; readonly problem: SkillProblem }> => {
  if (!isGzip(bytes)) {
    return { ok: false, problem: unreadable("ostra reads a skill's archive only as a .tar.gz") };
  }
  const tar = await new Promise<Uint8Array | null>((resolve) => {
    gunzip(bytes, { maxOutputLength: ARCHIVE_UNPACKED_MAX_BYTES }, (error, result) => {
      resolve(error === null ? result : null);
    });
  });
  if (tar === null) {
    return { ok: false, problem: unreadable("The skill's archive doesn't unpack within 25 MiB") };
  }
  const once = (): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: () => {
      let given = false;
      return {
        next: (): Promise<IteratorResult<Uint8Array, undefined>> => {
          if (given) return Promise.resolve({ done: true, value: undefined });
          given = true;
          return Promise.resolve({ done: false, value: tar });
        },
      };
    },
  });
  const normalized = (path: string): string => path.replace(/^\.\//, "").replace(/\/+$/, "");
  // First the paths, for the one top folder they may share; then the files under it.
  const paths: string[] = [];
  const listed = await readTar(once(), {
    entry: (entry) => {
      if (entry.type === "file" || entry.type === "symlink") paths.push(normalized(entry.path));
      return "skip";
    },
    bytes: () => undefined,
  });
  if (!listed.ok) {
    return { ok: false, problem: unreadable("The skill's archive isn't a tar archive ostra reads") };
  }
  const tops = new Set(paths.map((path) => path.split("/")[0] ?? ""));
  const [top] = [...tops];
  const folder = !paths.includes("SKILL.md") && tops.size === 1 && top !== undefined && paths.every((path) => path.includes("/")) ? top : "";
  const collector = createTreeCollector(folder, SKILL_READ_LIMITS);
  const read = await readTar(once(), {
    entry: (entry) => {
      const path = normalized(entry.path);
      switch (entry.type) {
        case "file":
          return collector.wants(path, entry.size) ? "read" : collector.full() ? "stop" : "skip";
        case "symlink":
          collector.symlink(path, entry.linkTarget);
          return "skip";
        case "directory":
        case "hardlink":
        case "other":
          return "skip";
        default:
          return entry.type satisfies never;
      }
    },
    bytes: (entry, content) => {
      collector.file(normalized(entry.path), (entry.mode & 0o111) === 0 ? "regular" : "executable", content);
    },
  });
  if (!read.ok) {
    return { ok: false, problem: unreadable("The skill's archive isn't a tar archive ostra reads") };
  }
  const tree = collector.finish();
  const relative = (path: string): string => (folder === "" ? path : path.slice(folder.length + 1));
  return { ok: true, tree: { ...tree, files: tree.files.map((file) => ({ ...file, path: relative(file.path) })), notes: tree.notes.map((note) => ({ ...note, path: relative(note.path) })) } };
};

/** One entry's skill: its bytes fetched from the site, checked against its digest, then read. */
const readEntry = async (deps: OutboundDeps, entry: WellKnownEntry, url: string, signal: AbortSignal): Promise<{ readonly ok: true; readonly skill: SkillRead } | SourceFailure | { readonly ok: false; readonly error: "digest-mismatch"; readonly message: string }> => {
  const maxBytes = entry.type === "archive" ? ARCHIVE_MAX_BYTES : skillLimits.fileMaxBytes;
  const answer = await callOut(deps, url, { maxBytes, signal, followRedirects: true });
  if (!answer.ok) {
    return answer.failure.kind === "too-large"
      ? { ok: false, error: "too-large", message: `The skill ${entry.name} is bigger than ostra reads` }
      : unavailable(outboundFailureWords(`The skill ${entry.name}`, answer.failure));
  }
  if (answer.answer.status < 200 || answer.answer.status >= 300) {
    return unavailable(`The skill ${entry.name} answered HTTP ${String(answer.answer.status)}`);
  }
  const bytes = answer.answer.bytes;
  // Never a fallback: bytes that don't match what the index promised are refused.
  if (`sha256:${sha256Hex(bytes)}` !== entry.digest) {
    return { ok: false, error: "digest-mismatch", message: `The skill ${entry.name}'s files don't match the digest the site's index gives for them` };
  }
  if (entry.type === "skill-md") {
    return { ok: true, skill: skillReadOf({ folder: entry.name, folderName: entry.name, files: [{ path: "SKILL.md", bytes, executable: false }], readProblems: [] }) };
  }
  const unpacked = await unpackArchive(bytes);
  if (!unpacked.ok) {
    return { ok: true, skill: skillReadOf({ folder: entry.name, folderName: entry.name, files: [], readProblems: [unpacked.problem] }) };
  }
  const files = unpacked.tree.files.map((file) => ({ path: file.path, bytes: file.bytes, executable: file.mode === "executable" }));
  const readProblems: SkillProblem[] = [];
  if (unpacked.tree.truncated) {
    readProblems.push({ code: "too-many-files", message: "The skill's archive holds more than ostra takes: SKILL.md and at most 20 more files of 1 MiB", path: null });
  }
  return { ok: true, skill: skillReadOf({ folder: entry.name, folderName: entry.name, files, readProblems }) };
};

/** The skills a site serves, or the one named `skill`: each checked against its digest. */
export const readWellKnownSkills = async (
  deps: OutboundDeps,
  site: string,
  skill: string | null,
): Promise<WellKnownSkills | SourceFailure | { readonly ok: false; readonly error: "digest-mismatch"; readonly message: string }> => {
  const signal = AbortSignal.timeout(WELL_KNOWN_DEADLINE_MS);
  const index = await readIndex(deps, site, signal);
  if (!index.ok) {
    return index;
  }
  let dropped = index.dropped;
  const wanted = skill === null ? index.entries : index.entries.filter((entry) => entry.name === skill);
  if (wanted.length === 0) {
    return { ok: false, error: "not-found", message: skill === null ? "The site's skills index lists no skill" : `The site's skills index has no skill named ${skill}` };
  }
  const skills: SkillRead[] = [];
  for (const entry of wanted.slice(0, WELL_KNOWN_ENTRIES_MAX)) {
    const url = entryUrl(entry, index.url);
    if (url === null) {
      dropped += 1;
      continue;
    }
    const read = await readEntry(deps, entry, url, signal);
    if (!read.ok) {
      return read;
    }
    skills.push(read.skill);
  }
  if (skills.length === 0) {
    return { ok: false, error: "not-found", message: "The site's skills index lists no skill on its own address" };
  }
  return { ok: true, skills, dropped };
};
