import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Server } from 'node:http';

// Every child process the spike starts is tracked, so a run can kill whole
// process trees at the end and leave nothing behind (taskkill /T /F on Windows).
// In-process servers are tracked too, so the end-of-run check can see one
// still listening.

const live = new Set<ChildProcess>();
const servers = new Set<Server>();

export const spawnTracked = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => live.delete(child));
  return child;
};

export const trackServer = <S extends Server>(server: S): S => {
  servers.add(server);
  server.once('close', () => servers.delete(server));
  return server;
};

// Servers still listening (a closed server stops listening at once, before
// its 'close' event).
export const listeningServers = (): number => [...servers].filter((s) => s.listening).length;

const waitForExit = (child: ChildProcess, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const killTree = async (child: ChildProcess): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', () => {
        resolve();
      });
      killer.once('error', () => {
        resolve();
      });
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  await waitForExit(child, 5_000);
};

export const killAllTracked = async (): Promise<number> => {
  const remaining = [...live];
  await Promise.all(remaining.map(killTree));
  return remaining.length;
};

export const liveCount = (): number => live.size;

export type OsProcess = { readonly pid: number; readonly ppid: number; readonly name: string; readonly commandLine: string };

// Every process on the machine, from the OS itself rather than from the
// tracked set: Win32_Process on Windows, ps elsewhere. The lister is spawned
// untracked, and its pid is returned so its own subtree can be left out.
export const listOsProcesses = async (): Promise<{ readonly lister: number | null; readonly processes: readonly OsProcess[] }> => {
  const win = process.platform === 'win32';
  const command = win ? 'powershell.exe' : 'ps';
  const args = win
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Tab-separated: pid, parent pid, name, command line.
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }',
      ]
    : ['-eo', 'pid=,ppid=,comm=,args='];
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  await new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
  const processes: OsProcess[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (win) {
      const [pid, ppid, name, ...rest] = line.split('\t');
      if (pid === undefined || ppid === undefined || name === undefined) continue;
      const p = Number(pid);
      const pp = Number(ppid);
      if (Number.isInteger(p) && Number.isInteger(pp)) processes.push({ pid: p, ppid: pp, name, commandLine: rest.join('\t') });
    } else {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
      processes.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], commandLine: m[4] ?? '' });
    }
  }
  return { lister: child.pid ?? null, processes };
};

// Processes the run may have left: every descendant of this process (minus
// the lister's own subtree), plus any process anywhere whose command line
// names one of the markers (the scratch directory, the stub's entry file), in
// case one was re-parented after its parent died.
export const strayProcesses = async (markers: readonly string[]): Promise<readonly OsProcess[]> => {
  const { lister, processes } = await listOsProcesses();
  const children = new Map<number, OsProcess[]>();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const subtree = (root: number): Set<number> => {
    const seen = new Set<number>();
    const stack = [root];
    for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
      for (const c of children.get(pid) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        stack.push(c.pid);
      }
    }
    return seen;
  };
  const excluded = lister === null ? new Set<number>() : new Set([lister, ...subtree(lister)]);
  const mine = subtree(process.pid);
  const lowered = markers.map((m) => m.toLowerCase());
  return processes.filter(
    (p) =>
      p.pid !== process.pid &&
      !excluded.has(p.pid) &&
      (mine.has(p.pid) || lowered.some((m) => p.commandLine.toLowerCase().includes(m))),
  );
};
