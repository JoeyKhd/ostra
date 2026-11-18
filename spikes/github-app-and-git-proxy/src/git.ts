import { createReadStream } from 'node:fs';
import { mkdir, opendir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killTree, spawnTracked } from './proc.ts';

// Runs stock git as the agent would, with arguments as an array (never a
// shell string) and an environment built from an allowlist.

export type GitResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  readonly timedOut: boolean;
};

export type GitRunOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

const KEEP_OUTPUT = 256 * 1024;

const tail = (s: string): string => (s.length > KEEP_OUTPUT ? s.slice(-KEEP_OUTPUT) : s);

export const runGit = async (args: readonly string[], options: GitRunOptions): Promise<GitResult> => {
  const started = Date.now();
  const child = spawnTracked('git', args, { cwd: options.cwd, env: { ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = tail(stdout + chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = tail(stderr + chunk.toString('utf8'));
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, options.timeoutMs ?? 15 * 60_000);
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', (c) => {
      resolve(c);
    });
    child.once('error', () => {
      resolve(null);
    });
  });
  clearTimeout(timer);
  return { code, stdout, stderr, ms: Date.now() - started, timedOut };
};

// The variables a git process needs on this OS, and nothing else. No
// GITHUB_TOKEN, no GH_TOKEN, nothing inherited by accident.
const PASS_THROUGH = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'TERM'] as const;

export type AgentWorld = {
  readonly home: string;
  readonly workspace: string;
  readonly traceDir: string;
  readonly env: Readonly<Record<string, string>>;
};

export const makeAgentWorld = async (
  root: string,
  proxyUrl: string,
  options: { readonly trace: boolean; readonly publicBase: string },
): Promise<AgentWorld> => {
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const traceDir = path.join(home, 'traces');
  await mkdir(workspace, { recursive: true });
  await mkdir(traceDir, { recursive: true });
  await mkdir(path.join(home, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(path.join(home, 'AppData', 'Local'), { recursive: true });
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  if (options.trace) {
    // Redaction off on purpose: if a credential ever passed through the
    // agent's git, these traces would show it.
    Object.assign(env, {
      GIT_TRACE: path.join(traceDir, 'trace.log'),
      GIT_TRACE_CURL: path.join(traceDir, 'curl.log'),
      GIT_TRACE_PACKET: path.join(traceDir, 'packet.log'),
      GIT_TRACE_REDACT: '0',
      GIT_CURL_VERBOSE: '1',
    });
  }
  const proxyBase = proxyUrl.endsWith('/') ? proxyUrl : `${proxyUrl}/`;
  await writeFile(
    path.join(home, '.gitconfig'),
    [
      '[user]',
      '\tname = ostra agent (spike)',
      '\temail = agent@example.invalid',
      '[init]',
      '\tdefaultBranch = main',
      '[core]',
      '\tautocrlf = false',
      '[advice]',
      '\tdetachedHead = false',
      '[credential]',
      '\thelper =',
      `[url "${proxyBase}"]`,
      `\tinsteadOf = ${options.publicBase}`,
      '',
    ].join('\n'),
    'utf8',
  );
  const lfs = await runGit(['lfs', 'install', '--skip-repo'], { cwd: home, env });
  if (lfs.code !== 0) throw new Error('git lfs install failed in the agent world');
  return { home, workspace, traceDir, env };
};

export type ScanResult = {
  readonly files: number;
  readonly bytes: number;
  readonly hits: readonly { readonly file: string; readonly needle: number }[];
};

const scanFile = async (file: string, needles: readonly Buffer[], overlap: number): Promise<{ bytes: number; hit: number }> => {
  let carry: Buffer = Buffer.alloc(0);
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) continue;
    bytes += value.length;
    const window = carry.length === 0 ? value : Buffer.concat([carry, value]);
    const hit = needles.findIndex((n) => window.includes(n));
    if (hit >= 0) return { bytes, hit };
    carry = window.subarray(Math.max(0, window.length - overlap));
  }
  return { bytes, hit: -1 };
};

// Searches every file under the roots for any of the needles.
export const scanForSecrets = async (roots: readonly string[], secrets: readonly string[]): Promise<ScanResult> => {
  const needles = secrets.filter((s) => s.length >= 8).map((s) => Buffer.from(s, 'utf8'));
  const overlap = Math.max(0, ...needles.map((n) => n.length));
  let files = 0;
  let bytes = 0;
  const hits: { file: string; needle: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        const r = await scanFile(full, needles, overlap);
        bytes += r.bytes;
        if (r.hit >= 0) hits.push({ file: full, needle: r.hit });
      }
    }
  };
  for (const root of roots) await walk(root);
  return { files, bytes, hits };
};

// The forms a credential could leak in: as is, inside a Basic header (the
// base64 of `x-access-token:<token>`, and of the token alone), URL-encoded,
// and a slice from its middle, which catches a token cut short by a log line
// or a column.
export const secretVariants = (token: string): string[] => {
  const variants = [
    token,
    Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64'),
    Buffer.from(token, 'utf8').toString('base64'),
    encodeURIComponent(token),
  ];
  if (token.length >= 64) variants.push(token.slice(Math.floor(token.length / 2) - 16, Math.floor(token.length / 2) + 16));
  return [...new Set(variants)];
};
