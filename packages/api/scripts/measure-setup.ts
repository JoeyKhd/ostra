// `pnpm measure:setup --url <panel> --start <time> [--username <name>] [--out <file>]`: the
// 30-minute measure's timeline (F-076, ADR 0064, milestone 7 ticket 24). It signs in to the panel as
// the instance admin, reads `setup.timeline` for the install's first organization, prints each
// step's time since `--start` (when the person ran the guide's first command) and the total, and
// writes `timeline.json` for the measure's record (ticket 25).
//
// The password is read from the prompt (or one line of standard input), never from an argument,
// the environment or a log. Nothing it prints or writes holds the password, the session's cookie or
// any address but the panel's.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { setupTimelineOutputSchema } from "@ostra/api/setup-timeline";
import type { SetupTimelineOutput } from "@ostra/api/setup-timeline";

const usage = "Usage: pnpm measure:setup --url <panel address> --start <time of the first command, ISO 8601> [--username <instance admin>] [--out <file>]\n";

/** The step names as the record prints them. */
const stepLabels = {
  password: "Password changed",
  "model-provider": "Model provider added",
  github: "GitHub App connected",
  tracker: "Tracker connected (optional)",
  project: "Project created",
  runner: "Runner connected",
  "first-task": "First task started",
  "first-pr": "First PR opened",
} as const satisfies Record<SetupTimelineOutput["steps"][number]["step"], string>;

/** `12m 05s`, `-0m 30s` for a step done before the clock started. */
const formatDuration = (ms: number): string => {
  const sign = ms < 0 ? "-" : "";
  const seconds = Math.round(Math.abs(ms) / 1000);
  return `${sign}${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** The printed record: one line per step, then the total. IDs, names and times only. */
const formatTimeline = (panel: string, timeline: SetupTimelineOutput): string => {
  const lines = [`Setup timeline of ${panel}`, `Started ${new Date(timeline.start).toISOString()}`, ""];
  for (const row of timeline.steps) {
    const label = stepLabels[row.step].padEnd(30);
    lines.push(row.state === "done" ? `${label}+${formatDuration(row.sinceStartMs)}` : `${label}${row.optional ? "skipped" : "missing"}`);
  }
  lines.push("");
  lines.push(timeline.totalMs === null ? `Total: not complete (missing: ${timeline.missing.join(", ")})` : `Total: ${formatDuration(timeline.totalMs)}`);
  return `${lines.join("\n")}\n`;
};

const trpcResultSchema = z.object({ result: z.object({ data: setupTimelineOutputSchema }) });
const trpcErrorSchema = z.object({ error: z.looseObject({ data: z.looseObject({ code: z.string() }).optional() }) });

/** The session's cookies, as the panel set them, to send back: never printed. */
const cookieHeaderOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.includes("="))
    .join("; ");

type MeasureInput = {
  readonly panel: string;
  readonly start: number;
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
};

/** Signs in, reads the timeline, signs out. Throws a message with no secret in it. */
const readTimeline = async (input: MeasureInput): Promise<SetupTimelineOutput> => {
  const request = input.fetch ?? fetch;
  const panel = input.panel.replace(/\/+$/, "");
  const signIn = await request(`${panel}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: input.username, password: input.password }),
  });
  if (!signIn.ok) {
    throw new Error(`The panel refused the sign-in (HTTP ${String(signIn.status)}). Check the username and the password.`);
  }
  const cookie = cookieHeaderOf(signIn);
  if (cookie === "") {
    throw new Error("The panel signed in but set no session.");
  }
  try {
    const query = encodeURIComponent(JSON.stringify({ start: input.start }));
    const answer = await request(`${panel}/api/trpc/setup.timeline?input=${query}`, { headers: { cookie } });
    const body: unknown = await answer.json().catch(() => null);
    const ok = trpcResultSchema.safeParse(body);
    if (ok.success) {
      return ok.data.result.data;
    }
    const refused = trpcErrorSchema.safeParse(body);
    const code = refused.success ? (refused.data.error.data?.code ?? String(answer.status)) : String(answer.status);
    throw new Error(code === "FORBIDDEN" ? "The panel refused: sign in as an instance admin." : `The panel answered setup.timeline with ${code}.`);
  } finally {
    // Best effort: the session ends now rather than when it expires.
    await request(`${panel}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin: panel, "content-type": "application/json" }, body: "{}" }).catch(() => null);
  }
};

/** The password, from the prompt with no echo on a terminal, or the first line of standard input. */
const readPassword = async (): Promise<string> => {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) {
      text += z.string().parse(chunk);
      if (text.includes("\n")) break;
    }
    return text.split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write("Password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let typed = "";
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(typed);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("Cancelled."));
          return;
        }
        typed = char === "\u007f" || char === "\b" ? typed.slice(0, -1) : typed + char;
      }
    };
    stdin.on("data", onData);
  });
};

const options = { url: { type: "string" }, start: { type: "string" }, username: { type: "string" }, out: { type: "string" } } as const;

const argsOf = (): ReturnType<typeof parseArgs<{ options: typeof options; strict: true }>>["values"] | null => {
  try {
    return parseArgs({ options, strict: true }).values;
  } catch {
    return null;
  }
};

const main = async (): Promise<number> => {
  const values = argsOf();
  if (values === null) {
    process.stderr.write(usage);
    return 2;
  }
  const panel = values.url === undefined ? null : URL.parse(values.url);
  const start = values.start === undefined ? Number.NaN : Date.parse(values.start);
  if (panel === null || (panel.protocol !== "http:" && panel.protocol !== "https:") || Number.isNaN(start)) {
    process.stderr.write(usage);
    return 2;
  }
  const panelAddress = panel.origin + panel.pathname.replace(/\/+$/, "");
  const password = await readPassword();
  if (password === "") {
    process.stderr.write("No password given.\n");
    return 2;
  }
  try {
    const timeline = await readTimeline({ panel: panelAddress, start, username: values.username ?? "demo", password });
    process.stdout.write(formatTimeline(panelAddress, timeline));
    const out = path.resolve(values.out ?? "timeline.json");
    await writeFile(out, `${JSON.stringify({ panel: panelAddress, startedAt: new Date(start).toISOString(), ...timeline }, null, 2)}\n`);
    process.stdout.write(`Wrote ${path.basename(out)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "The measure failed."}\n`);
    return 1;
  }
};

process.exitCode = await main();
