// The scripts the stub models play in the T-cases. Shell commands use `node -e`
// so they run the same under PowerShell (OpenCode's shell on Windows) and bash.
// A trailing marker argument tags each process, so the harness can find it,
// orphaned or not, by its command line.
//
// Scenario arguments come from prompt text. Before any of them reaches a shell
// command, each is checked against a strict pattern (digits, or IDs made of
// letters, digits, `_` and `-`); anything else gets a "bad args" reply and no
// tool call. Values go in as separate arguments and are read from
// `process.argv`, never spliced into the script.

import type { NormalizedMessage, StubReply, StubRequest } from "../lib/stub-models/types.ts";
import { conversationText, type Scenario } from "../lib/stub-models/scenario.ts";

const DIGITS = /^\d{1,9}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
/** `<sessionId>.<requestId>.<port>`: one target for the shell probe. */
const PROBE_TARGET = /^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,128}\.\d{1,5}$/;

const BAD_ARGS: StubReply = { text: "stub: bad args" };

const words = (args: string): string[] => args.split(/\s+/).filter((w) => w !== "");

/** The arguments, if each matches its pattern; missing ones take the defaults. */
const checkedArgs = (args: string, patterns: readonly RegExp[], defaults: readonly string[]): string[] | undefined => {
  const given = words(args);
  if (given.length > patterns.length) return undefined;
  const out: string[] = [];
  for (const [index, pattern] of patterns.entries()) {
    const value = given[index] ?? defaults[index];
    if (value === undefined || !pattern.test(value)) return undefined;
    out.push(value);
  }
  return out;
};

export const sleepCommand = (ms: number, marker: string): string => {
  if (!Number.isInteger(ms) || ms < 0 || !TOKEN.test(marker)) throw new Error("sleepCommand: bad arguments");
  return `node -e "setTimeout(()=>{},Number(process.argv[1]))" ${String(ms)} ${marker}`;
};

export const serverCommand = (marker: string): string => {
  if (!TOKEN.test(marker)) throw new Error("serverCommand: bad marker");
  return `node -e "require('http').createServer().listen(0);setInterval(()=>{},1000)" ${marker}`;
};

/** Starts a detached grandchild that outlives its parent shell (and, on POSIX, leaves the agent's process group). */
const detachedCommand = (marker: string): string =>
  `node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)',process.argv[1]],{detached:true,stdio:'ignore'}).unref()" ${marker}`;

/**
 * From the agent's own shell: unauthenticated calls to each target's OpenCode
 * port (list sessions, list permission requests, read the event stream, answer
 * a pending request). Prints `PROBE <json>` with a status per call, or ERR.
 */
const probeCommand = (targets: readonly string[]): string =>
  `node -e "const out=[];const calls=[];for(const t of process.argv.slice(1)){const [sid,rid,port]=t.split('.');const b='http://127.0.0.1:'+port;` +
  `calls.push([port,'GET','/api/session'],[port,'GET','/api/permission/request'],[port,'GET','/api/session/'+sid+'/permission'],[port,'GET','/api/event'],` +
  `[port,'POST','/api/session/'+sid+'/permission/'+rid+'/reply'])}` +
  `(async()=>{for(const [port,m,p] of calls){try{const r=await fetch('http://127.0.0.1:'+port+p,{method:m,headers:{'content-type':'application/json'},` +
  `body:m==='POST'?JSON.stringify({decision:'once'}):undefined,signal:AbortSignal.timeout(3000)});out.push([port,m,p,r.status])}catch(e){out.push([port,m,p,'ERR'])}}` +
  `console.log('PROBE '+JSON.stringify(out));process.exit(0)})()" ${targets.join(" ")}`;

const envDumpCommand = `node -e "console.log(JSON.stringify(process.env))"`;

const resultText = (results: readonly NormalizedMessage[]): string => results.map((r) => r.text).join("\n");

const SECRET = /secret word is ([A-Za-z0-9-]+)/g;

const secretsIn = (messages: readonly NormalizedMessage[]): string[] => {
  const found = new Set<string>();
  for (const match of conversationText(messages).matchAll(SECRET)) if (match[1] !== undefined) found.add(match[1]);
  return [...found];
};

/** T8: the options offered to the model. The harness answers with a free-text token that is none of them. */
export const QUESTION_OPTIONS = ["red", "blue"] as const;

export const scenarios: Readonly<Record<string, Scenario>> = {
  hello: ({ step }) => (step === 0 ? { text: "hello from the stub" } : undefined),

  /** T6: several steps with output, a few seconds long, so a runner stall lands mid-turn. */
  busy: ({ step }) => {
    switch (step) {
      case 0:
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      case 1:
        return {
          toolCalls: [
            {
              name: "shell",
              arguments: { command: `node -e "for(let i=0;i<200;i++)console.log('line '+i);setTimeout(()=>{},4000)" ostra-marker-t6`, timeout: 60_000, description: "print and wait" },
            },
          ],
        };
      case 2:
        return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, busy" } }] };
      case 3:
        return { text: "busy done ".repeat(40), chunkDelayMs: 5 };
      default:
        return undefined;
    }
  },

  /** args: <url>. The egress recorder's positive control. The URL goes to OpenCode's webfetch tool, not a shell. */
  webfetch: ({ step, args }) => {
    if (step === 0) return { toolCalls: [{ name: "webfetch", arguments: { url: args, format: "text", timeout: 10 } }] };
    if (step === 1) return { text: "fetched" };
    return undefined;
  },

  /** Remembers nothing: the secret is in the user's prompt. */
  remember: ({ step, args }) => (step === 0 ? { text: `Noted. I will remember ${args}.` } : undefined),

  /** Answers from the history it was sent: the context check for resume. */
  recall: ({ step, request }) => {
    if (step !== 0) return undefined;
    const earlier = request.messages.slice(0, -1);
    const found = secretsIn(earlier);
    return { text: found.length > 0 ? `The secret word is ${found.join(",")}.` : "I do not know the secret word." };
  },

  "env-dump": ({ step }) => {
    if (step === 0) return { toolCalls: [{ name: "shell", arguments: { command: envDumpCommand, description: "print the environment" } }] };
    if (step === 1) return { text: "environment printed" };
    return undefined;
  },

  /** args: <ms> <marker> */
  sleep: ({ step, args }) => {
    const checked = checkedArgs(args, [DIGITS, TOKEN], ["1000", "ostra-marker"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [ms = "1000", marker = "ostra-marker"] = checked;
    if (step === 0) {
      return {
        toolCalls: [
          { name: "shell", arguments: { command: sleepCommand(Number(ms), marker), timeout: Number(ms) + 120_000, description: "wait" } },
        ],
      };
    }
    if (step === 1) return { text: "slept" };
    return undefined;
  },

  /** args: <ms> <keepalive|silent>. One long model call: the first byte comes after `ms`. */
  "slow-model": ({ step, args }) => {
    const checked = checkedArgs(args, [DIGITS, /^(keepalive|silent)$/], ["30000", "keepalive"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [ms = "30000", mode = "keepalive"] = checked;
    return step === 0 ? { text: "slow model ok", delayMs: Number(ms), keepalive: mode === "keepalive" } : undefined;
  },

  /** args: <marker>. A background server and a foreground sleep: T14's leftovers. */
  "bg-and-sleep": ({ step, args }) => {
    const checked = checkedArgs(args, [TOKEN], ["ostra-marker"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [marker = "ostra-marker"] = checked;
    if (step === 0) {
      return {
        toolCalls: [
          { name: "shell", arguments: { command: serverCommand(marker), background: true, description: "start a server" } },
          { name: "shell", arguments: { command: sleepCommand(60_000, marker), timeout: 180_000, description: "wait" } },
        ],
      };
    }
    if (step === 1) return { text: "done waiting" };
    return undefined;
  },

  /** args: <marker>. T13: a detached process that outlives its shell, then a long foreground step to crash in. */
  "detached-then-sleep": ({ step, args }) => {
    const checked = checkedArgs(args, [TOKEN], ["ostra-marker"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [marker = "ostra-marker"] = checked;
    if (step === 0) return { toolCalls: [{ name: "shell", arguments: { command: detachedCommand(marker), description: "start a detached helper" } }] };
    if (step === 1) return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(60_000, marker), timeout: 180_000, description: "wait" } }] };
    if (step === 2) return { text: "done" };
    return undefined;
  },

  /** args: <target>...: `<sessionId>.<requestId>.<port>` per OpenCode port to probe from the agent's shell. */
  "shell-probe": ({ step, args, lastToolResults }) => {
    const targets = words(args);
    if (targets.length === 0 || targets.length > 8 || !targets.every((t) => PROBE_TARGET.test(t))) return step === 0 ? BAD_ARGS : undefined;
    if (step === 0) return { toolCalls: [{ name: "shell", arguments: { command: probeCommand(targets), timeout: 120_000, description: "probe local ports" } }] };
    if (step === 1) return { text: `probe finished: ${resultText(lastToolResults).includes("PROBE ") ? "output seen" : "no output"}` };
    return undefined;
  },

  /** args: <ms> <marker>. Two model calls with a tool step between them (T10's mid-turn switch). */
  "two-calls": ({ step, args }) => {
    const checked = checkedArgs(args, [DIGITS, TOKEN], ["6000", "ostra-marker"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [ms = "6000", marker = "ostra-marker"] = checked;
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(Number(ms), marker), timeout: 120_000, description: "wait" } }] };
    }
    if (step === 1) return { text: "second call done" };
    return undefined;
  },

  /** Slow streamed text, about `args` seconds long: a cancel during a model call. */
  "slow-text": ({ step, args }) => {
    if (step !== 0) return undefined;
    const checked = checkedArgs(args, [DIGITS], ["30"]);
    const seconds = Number(checked?.[0] ?? "30");
    return { text: "x".repeat(seconds * 4 * 24), chunkDelayMs: 250 };
  },

  /** args: <path>. Edit one file, and show the result. The path goes to OpenCode's edit tool, not a shell. */
  "edit-file": ({ step, args, lastToolResults }) => {
    const checked = checkedArgs(args, [/^[A-Za-z0-9_.-]{1,64}$/], ["README.md"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [file = "README.md"] = checked;
    if (step === 0) return { toolCalls: [{ name: "read", arguments: { path: file } }] };
    if (step === 1) return { toolCalls: [{ name: "edit", arguments: { path: file, oldString: "hello", newString: "hello, edited by the agent" } }] };
    if (step === 2) return { text: `edit result: ${resultText(lastToolResults).slice(0, 200)}` };
    return undefined;
  },

  /** T7: two edits under `ask`; the harness answers once, then reject. */
  "permission-pair": ({ step, lastToolResults }) => {
    if (step === 0) return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, approved" } }] };
    if (step === 1) return { toolCalls: [{ name: "edit", arguments: { path: "notes.txt", oldString: "notes", newString: "notes, rejected" } }] };
    if (step === 2) return { text: `continued after reject: ${lastToolResults.some((r) => r.isError) ? "tool failed" : "tool ok"}` };
    return undefined;
  },

  /** T7: one edit under `ask`, held; then a text. */
  "permission-one": ({ step }) => {
    if (step === 0) return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, after wait" } }] };
    if (step === 1) return { text: "edit step finished" };
    return undefined;
  },

  /** T8: one question; the answer is echoed back. */
  question: ({ step, lastToolResults }) => {
    if (step === 0) {
      return {
        toolCalls: [
          {
            name: "question",
            arguments: {
              questions: [
                {
                  question: "Which colour should the button be?",
                  header: "Colour",
                  options: QUESTION_OPTIONS.map((label) => ({ label, description: `A ${label} button` })),
                },
              ],
            },
          },
        ],
      };
    }
    if (step === 1) return { text: `answer seen: ${resultText(lastToolResults).slice(0, 300)}` };
    return undefined;
  },

  /** The HTTP fallback's plan check: a todo list, then text. */
  todo: ({ step }) => {
    if (step === 0) {
      return {
        toolCalls: [
          {
            name: "todowrite",
            arguments: {
              todos: [
                { content: "Read README.md", status: "in_progress" },
                { content: "Edit README.md", status: "pending" },
              ],
            },
          },
        ],
      };
    }
    if (step === 1) return { text: "todo written" };
    return undefined;
  },

  /** T5: read, edit, shell, a failing tool, a subagent, then text. */
  t5: ({ step }) => {
    switch (step) {
      case 0:
        return {
          reasoning: "Reading the file first.",
          toolCalls: [
            {
              name: "todowrite",
              arguments: {
                todos: [
                  { content: "Read README.md", status: "in_progress" },
                  { content: "Edit README.md", status: "pending" },
                ],
              },
            },
            { name: "read", arguments: { path: "README.md" } },
          ],
        };
      case 1:
        return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, t5" } }] };
      case 2:
        return { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('shell-ok')"`, description: "say ok" } }] };
      case 3:
        return { toolCalls: [{ name: "read", arguments: { path: "does-not-exist.txt" } }] };
      case 4:
        return {
          toolCalls: [{ name: "subagent", arguments: { agent: "general", description: "inspect readme", prompt: "[[stub:sub-work]] look at README.md" } }],
        };
      case 5:
        // Keep the turn open while the child works: child updates stop when the prompt ends.
        return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(8000, "ostra-marker-t5-wait"), timeout: 60_000, description: "wait for the subagent" } }] };
      case 6:
        return { text: "t5 done" };
      default:
        return undefined;
    }
  },

  "sub-work": ({ step }) => {
    if (step === 0) return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
    if (step === 1) return { text: "sub done" };
    return undefined;
  },

  /** The HTTP API steering probe: a long tool step, then a reply that says whether the steer text arrived. */
  "steer-probe": ({ step, args, since }) => {
    const checked = checkedArgs(args, [DIGITS, TOKEN], ["15000", "ostra-marker"]);
    if (checked === undefined) return step === 0 ? BAD_ARGS : undefined;
    const [ms = "15000", marker = "ostra-marker"] = checked;
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(Number(ms), marker), timeout: 120_000, description: "wait" } }] };
    }
    if (step === 1) {
      const steered = conversationText(since).includes("STEER-TOKEN");
      return { text: steered ? "steer seen mid-turn" : "no steer seen" };
    }
    return undefined;
  },
};

/** Calls without tools: titles and summaries. A summary keeps the secrets, as a real one would. */
export const auxiliary = (request: StubRequest): StubReply => {
  const all = conversationText(request.messages).toLowerCase();
  if (all.includes("summar") || all.includes("compact")) {
    const found = secretsIn(request.messages);
    return { text: `Summary of the conversation so far.${found.length > 0 ? ` The secret word is ${found.join(",")}.` : ""}` };
  }
  return { text: "Stub task" };
};

const SUMMARY_HEADINGS = ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"];

const summaryOf = (messages: readonly NormalizedMessage[]): string => {
  const found = secretsIn(messages);
  const context = found.length > 0 ? `* The secret word is ${found.join(",")}.` : "* (none)";
  return SUMMARY_HEADINGS.map((heading) => `${heading}\n${heading === "## Important Context" ? context : heading === "## Work State" ? "" : "* (none)"}`).join("\n");
};

/** OpenCode's compaction call carries tools but asks for a templated summary: answer it in kind. */
export const intercept = (request: StubRequest): StubReply | undefined => {
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  if (lastUser === undefined) return undefined;
  if (lastUser.text.includes("structured summary") || lastUser.text.includes("required summary template")) return { text: summaryOf(request.messages) };
  return undefined;
};
