import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

// The fake ACP agent's own sessions on disk, and its archive format (ticket 04): enough to prove a
// session moves to a fresh box the way OpenCode's does (spike 2). A session is kept per agent data
// folder; `export` writes it out as an archive, and `import` takes one into another data folder,
// bound to the directory it's given, as `opencode import --directory` does. Loading it from any
// other directory is refused, as OpenCode refuses a different `cwd`.

export const FAKE_ARCHIVE_FORMAT = "ostra-fake-agent-archive/1";

export const fakeSessionSchema = z.strictObject({
  id: z.string().min(1),
  /** The directory the session is bound to. */
  cwd: z.string().nullable(),
  /** What the agent said, oldest first: `session/load` replays it. */
  history: z.array(z.string()),
  /** Milestone 4 (F-137): the session's reasoning level, as its `thought_level` option names it. */
  effort: z.string().optional(),
});
export type FakeStoredSession = z.infer<typeof fakeSessionSchema>;

const archiveSchema = z.strictObject({ format: z.literal(FAKE_ARCHIVE_FORMAT), session: fakeSessionSchema });

const fileOf = (dataDir: string, sessionId: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error("a session ID the fake agent can't keep");
  }
  return path.join(dataDir, "sessions", `${sessionId}.json`);
};

export const saveFakeSession = async (dataDir: string, session: FakeStoredSession): Promise<void> => {
  const file = fileOf(dataDir, session.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(session));
};

/** A kept session, or `undefined`. */
export const loadFakeSession = async (dataDir: string, sessionId: string): Promise<FakeStoredSession | undefined> => {
  try {
    return fakeSessionSchema.parse(JSON.parse(await readFile(fileOf(dataDir, sessionId), "utf8")));
  } catch {
    return undefined;
  }
};

/** `export`: the session as an archive's text. */
export const exportFakeSession = async (dataDir: string, sessionId: string): Promise<string> => {
  const session = await loadFakeSession(dataDir, sessionId);
  if (session === undefined) {
    throw new Error("no such session to export");
  }
  return JSON.stringify({ format: FAKE_ARCHIVE_FORMAT, session });
};

/** `import`: an archive into this data folder, bound to `directory`. Answers the session's ID. */
export const importFakeSession = async (dataDir: string, archive: string, directory: string): Promise<string> => {
  const parsed = archiveSchema.parse(JSON.parse(archive));
  await saveFakeSession(dataDir, { ...parsed.session, cwd: directory });
  return parsed.session.id;
};
