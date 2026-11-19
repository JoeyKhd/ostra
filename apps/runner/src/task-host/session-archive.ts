import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { AgentAdapter, BoxRef, ExecutorAdapter } from "@ostra/adapter-sdk";
import { runnerLimits, SESSION_ARCHIVE_CONTENT_TYPE } from "@ostra/protocol";
import type { BlobRef, LeaseEpoch, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { sha256Of } from "../server/bulk.ts";
import type { ServerLink } from "./server-link.ts";

// The session archive (ADR 0039, spec section 4, tickets 22 and 24). Ported from
// spikes/can-a-session-move-to-a-fresh-box/src/lib/session-archive.ts.
//
// After a turn the agent adapter's export command writes the session out, beside the live agent;
// the runner wraps it in its own envelope, gzips it with `node:zlib`, and uploads it through the
// bulk path with its SHA-256. On a fresh box the runner downloads it, checks the digest against
// the spec's, unwraps it, and the adapter's import command takes it into this box's agent folder,
// bound to this box's workspace (OpenCode's `--directory`). The envelope is the runner's own
// format: one line of JSON (which agent wrote it, and its own session ID, which `session/load`
// needs), then the export's bytes. Nothing of it is ever logged.

const promisedGzip = promisify(gzip);
const promisedGunzip = promisify(gunzip);

export const SESSION_ARCHIVE_FORMAT = "ostra-session-archive/1";

const envelopeHeaderSchema = z.strictObject({
  format: z.literal(SESSION_ARCHIVE_FORMAT),
  /** The agent adapter's name: an archive is imported by the adapter that exported it. */
  agent: z.string().min(1).max(64),
  /** The agent's own session ID, which the import keeps and `session/load` names. */
  agentSessionId: z.string().min(1).max(256),
});
export type ArchiveHeader = z.infer<typeof envelopeHeaderSchema>;

/** How long an export or an import may run. */
const COMMAND_TIMEOUT_MS = 120_000;

/** The archive's bytes: the header line, then the export, gzipped. */
export const packArchive = async (header: ArchiveHeader, exported: Uint8Array): Promise<Buffer> =>
  promisedGzip(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), exported]));

export type Unpacked = { readonly ok: true; readonly header: ArchiveHeader; readonly exported: Buffer } | { readonly ok: false; readonly reason: string };

/** The archive's header and export, or why it can't be read. */
export const unpackArchive = async (archive: Uint8Array): Promise<Unpacked> => {
  let raw: Buffer;
  try {
    raw = await promisedGunzip(archive);
  } catch {
    return { ok: false, reason: "the archive isn't gzip" };
  }
  const newline = raw.indexOf(0x0a);
  if (newline < 0) {
    return { ok: false, reason: "the archive has no header" };
  }
  let header: unknown;
  try {
    header = JSON.parse(raw.subarray(0, newline).toString("utf8"));
  } catch {
    return { ok: false, reason: "the archive's header isn't JSON" };
  }
  const parsed = envelopeHeaderSchema.safeParse(header);
  if (!parsed.success) {
    return { ok: false, reason: "the archive's header isn't one this runner reads" };
  }
  return { ok: true, header: parsed.data, exported: raw.subarray(newline + 1) };
};

export type ArchiveContext = {
  readonly executor: ExecutorAdapter;
  readonly agent: AgentAdapter;
  readonly link: Pick<ServerLink, "uploadBlob" | "downloadBlob">;
  readonly box: BoxRef;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  /** The box's agent folder, and the folder the agent's session opens on (its checkout, with one repo). */
  readonly agentDir: string;
  readonly workspaceDir: string;
};

export type Saved = { readonly ok: true; readonly archive: BlobRef } | { readonly ok: false; readonly reason: string };

/** Where an export or an import's file goes while it's handled: the box's agent folder, never the workspace. */
const scratchFile = (agentDir: string, name: string): string => path.join(agentDir, ".ostra-archive", name);

/**
 * Exports the agent's session, wraps and gzips it, and uploads it. Never throws: a failure is a
 * reason in words, and the turn carries on (`session.saved` with `archive: null`).
 */
export const saveSessionArchive = async (context: ArchiveContext, agentSessionId: string, turnOrdinal: number): Promise<Saved> => {
  if (!context.agent.capabilities.sessionArchive) {
    return { ok: false, reason: `${context.agent.name} can't export its session` };
  }
  const file = scratchFile(context.agentDir, `export-${String(turnOrdinal)}`);
  try {
    const command = await context.agent.exportSession({ agentSessionId, agentDir: context.agentDir, workspaceDir: context.workspaceDir, archivePath: file });
    if (!command.ok) {
      return { ok: false, reason: `the agent's export couldn't be made: ${command.error.message}` };
    }
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true });
    const ran = await context.executor.runAgentCommand({ box: context.box, command: command.value, timeoutMs: COMMAND_TIMEOUT_MS });
    if (!ran.ok) {
      return { ok: false, reason: `the agent's export didn't run: ${ran.error.message}` };
    }
    if (ran.value.exitCode !== 0) {
      return { ok: false, reason: `the agent's export failed (exit ${String(ran.value.exitCode)})` };
    }
    let exported: Buffer;
    try {
      exported = await readFile(file);
    } catch {
      return { ok: false, reason: "the agent's export wrote no file" };
    }
    const archive = await packArchive({ format: SESSION_ARCHIVE_FORMAT, agent: context.agent.name, agentSessionId }, exported);
    if (archive.length > runnerLimits.archiveMaxBytes) {
      return { ok: false, reason: `the archive is over the cap (${String(archive.length)} bytes); the next reopen uses the template` };
    }
    const uploaded = await context.link.uploadBlob({
      taskId: context.taskId,
      leaseEpoch: context.leaseEpoch,
      purpose: "session-archive",
      contentType: SESSION_ARCHIVE_CONTENT_TYPE,
      bytes: archive,
    });
    if (!uploaded.ok) {
      return { ok: false, reason: `uploading the archive failed: ${uploaded.failure.message}` };
    }
    return { ok: true, archive: uploaded.value };
  } catch (error) {
    return { ok: false, reason: `saving the archive failed (${error instanceof Error ? error.name : "unknown"})` };
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
};

export type Loaded = { readonly ok: true; readonly agentSessionId: string } | { readonly ok: false; readonly reason: string };

/**
 * Downloads the archive the spec names, checks its size and digest, and imports it into this box,
 * bound to the folder the agent's session opens on here. Never throws: a failure is
 * a reason in words, and the restore falls back to the template (ticket 24).
 */
export const loadSessionArchive = async (context: ArchiveContext, archive: BlobRef): Promise<Loaded> => {
  if (!context.agent.capabilities.sessionArchive) {
    return { ok: false, reason: `${context.agent.name} can't import a session` };
  }
  const file = scratchFile(context.agentDir, "import");
  try {
    const downloaded = await context.link.downloadBlob({ taskId: context.taskId, leaseEpoch: context.leaseEpoch, blobId: archive.blobId, maxBytes: archive.size });
    if (!downloaded.ok) {
      return { ok: false, reason: `the archive didn't download: ${downloaded.failure.message}` };
    }
    const bytes = downloaded.value.bytes;
    if (bytes.length !== archive.size || sha256Of(bytes) !== archive.sha256) {
      return { ok: false, reason: "the archive didn't match its digest" };
    }
    const unpacked = await unpackArchive(bytes);
    if (!unpacked.ok) {
      return { ok: false, reason: unpacked.reason };
    }
    if (unpacked.header.agent !== context.agent.name) {
      return { ok: false, reason: "the archive was made by another agent" };
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, unpacked.exported, { mode: 0o600 });
    const command = await context.agent.importSession({
      agentSessionId: unpacked.header.agentSessionId,
      agentDir: context.agentDir,
      workspaceDir: context.workspaceDir,
      archivePath: file,
    });
    if (!command.ok) {
      return { ok: false, reason: `the agent's import couldn't be made: ${command.error.message}` };
    }
    const ran = await context.executor.runAgentCommand({ box: context.box, command: command.value, timeoutMs: COMMAND_TIMEOUT_MS });
    if (!ran.ok) {
      return { ok: false, reason: `the agent's import didn't run: ${ran.error.message}` };
    }
    if (ran.value.exitCode !== 0) {
      return { ok: false, reason: `the agent's import failed (exit ${String(ran.value.exitCode)})` };
    }
    return { ok: true, agentSessionId: unpacked.header.agentSessionId };
  } catch (error) {
    return { ok: false, reason: `restoring the archive failed (${error instanceof Error ? error.name : "unknown"})` };
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
};
