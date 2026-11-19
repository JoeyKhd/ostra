// The prepare step's entry point: `node prepare-main.ts`, a child of the init that runs as the
// agent's user. It reads one job from stdin (see `prepare.ts`) and exits 0, or says why on stderr.
import { PREPARE_FAILURE_PREFIX, PrepareJobError, runPrepareJob } from "./prepare.ts";

const readStdin = async (): Promise<string> => {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text;
};

// Which fields were bad, or the file system's error code: never the job's content or paths.
const describeFailure = (error: unknown): string => {
  if (error instanceof PrepareJobError) {
    return error.message;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "error";
};

try {
  await runPrepareJob(await readStdin());
} catch (error) {
  process.stderr.write(`${PREPARE_FAILURE_PREFIX}${describeFailure(error)}\n`);
  process.exitCode = 1;
}
