import http from "node:http";
import { z } from "zod";

// Many SSE viewers in one process, for the load test. Each records, per event, how long it took from the
// runner's emit time (`at`) to this process reading it, and checks that seq numbers are contiguous.
const config = z.object({
  bases: z.array(z.string()),
  cookie: z.string(),
  tasks: z.array(z.string()),
  viewersPerTask: z.number().int().min(1),
  timeoutMs: z.number().int(),
});
const settings = config.parse(JSON.parse(z.string().parse(process.env["OSTRA_LOAD_VIEWERS"])));

type TaskStats = { count: number; lastSeq: number; gaps: number; dups: number; ended: boolean };

const eventShape = z.object({
  seq: z.number(),
  at: z.number(),
  event: z.looseObject({ kind: z.string(), key: z.string().optional() }),
});

// The harness holds our stdin open. If it dies, the pipe closes and so do we.
process.stdin.on("end", () => {
  process.exit(0);
});
process.stdin.on("error", () => {
  process.exit(0);
});
process.stdin.resume();

const stats = new Map<string, TaskStats>();
const atSeconds: number[] = [];
const latencies: number[] = [];
let open = 0;
let liveFrames = 0;
let closedEarly = 0;
let ended = 0;
const wanted = settings.tasks.length * settings.viewersPerTask;

const connect = (base: string, taskId: string, viewerIndex: number): Promise<void> =>
  new Promise((resolve) => {
    const url = new URL(`/api/tasks/${encodeURIComponent(taskId)}/stream`, base);
    const key = `${taskId}#${String(viewerIndex)}`;
    const mine: TaskStats = { count: 0, lastSeq: 0, gaps: 0, dups: 0, ended: false };
    stats.set(key, mine);
    let buffer = "";
    const request = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { cookie: settings.cookie, accept: "text/event-stream" }, agent: false },
      (response) => {
        open += 1;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (raw.startsWith("event: live")) {
              liveFrames += 1;
              continue;
            }
            if (!raw.startsWith("id: ")) continue;
            const dataStart = raw.indexOf("data: ");
            if (dataStart < 0) continue;
            const now = Date.now();
            let parsed: z.infer<typeof eventShape>;
            try {
              parsed = eventShape.parse(JSON.parse(raw.slice(dataStart + 6)));
            } catch {
              continue;
            }
            if (parsed.seq <= mine.lastSeq) mine.dups += 1;
            else {
              if (parsed.seq !== mine.lastSeq + 1) mine.gaps += 1;
              mine.lastSeq = parsed.seq;
              mine.count += 1;
              atSeconds.push(Math.floor(parsed.at / 1000));
              latencies.push(Math.max(0, now - parsed.at));
            }
            if (parsed.event.kind === "session.config_changed" && parsed.event.key === "end" && !mine.ended) {
              mine.ended = true;
              ended += 1;
              response.destroy();
            }
          }
        });
        response.on("close", () => {
          if (!mine.ended) closedEarly += 1;
          resolve();
        });
      },
    );
    request.on("error", () => {
      if (!mine.ended) closedEarly += 1;
      resolve();
    });
  });

const all: Promise<void>[] = [];
let n = 0;
for (const taskId of settings.tasks) {
  for (let v = 0; v < settings.viewersPerTask; v += 1) {
    const base = settings.bases[n % settings.bases.length] ?? settings.bases[0] ?? "";
    n += 1;
    all.push(connect(base, taskId, v));
  }
}

// Wait for every connection to be open, then tell the harness.
const waitOpen = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (open < wanted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  process.stdout.write(`${JSON.stringify({ ready: open, wanted })}\n`);
};
await waitOpen();

const hardStop = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ result: summary(), timedOut: true })}\n`);
  process.exit(0);
}, settings.timeoutMs);

const summary = (): unknown => ({
  open,
  liveFrames,
  closedEarly,
  ended,
  wanted,
  perViewer: [...stats.entries()].map(([key, s]) => ({ key, ...s })),
  atSeconds,
  latencies,
});

await Promise.all(all);
clearTimeout(hardStop);
process.stdout.write(`${JSON.stringify({ result: summary(), timedOut: false })}\n`);
process.exit(0);
