// The environment a child process gets. An allowlist, not `{ ...process.env }`: a developer's shell
// may hold GITHUB_*, LINEAR_*, model-endpoint or cloud keys, and none of the harness's children
// (replicas, panels, prisma) needs any of them (AGENTS.md, Boundaries). What a child does need
// (its config, a database URL) is passed explicitly by whoever spawns it.

const KEYS = [
  "PATH",
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
] as const;

export const baseChildEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};
