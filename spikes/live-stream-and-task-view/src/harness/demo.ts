import { buildAllKindsEvents, streamingTurn } from "../producer/scenarios.ts";
import { TaskId } from "../shared/ids.ts";
import { buildWeb } from "./checks-static.ts";
import { makeRunner, newTask, startContext } from "./context.ts";

// `pnpm demo`: a running server with one task you can open in your own browser, as three members.
// The task replays every kind of event, then streams a long turn. Press Ctrl-C to stop (and clean up).
const built = await buildWeb();
if (built.code !== 0) throw new Error("the page did not build");
const ctx = await startContext();
const runner = makeRunner(ctx, ctx.baseA);
const taskId = TaskId.parse("demo");
await newTask(ctx, taskId, "alex");
for (const event of buildAllKindsEvents("demo").events) runner.emit(taskId, event);
process.stdout.write(
  [
    "",
    `open the same task as three members, in three browser windows (or profiles):`,
    `  driver:    ${ctx.baseA}/task/demo?as=alex&turns=all`,
    `  watcher:   ${ctx.baseB}/task/demo?as=sam&turns=all`,
    `  read-only: ${ctx.baseA}/task/demo?as=val&turns=all`,
    "press Ctrl-C to stop",
    "",
  ].join("\n"),
);
for (let i = 0; ; i += 1) {
  await streamingTurn(runner, taskId, { turnId: `demo-stream-${String(i)}`, segmentId: `demo-stream-${String(i)}-m`, totalWords: 300, streamMs: 12_000 });
}
