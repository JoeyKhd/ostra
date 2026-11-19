// The Node.js half of `instrumentation.ts`. It lives in its own module so the Edge build of the
// instrumentation hook never sees a Node.js API (Next.js warns about `process.stderr` otherwise).

export const registerNode = async (): Promise<void> => {
  const { getRuntime } = await import("./server/deps");
  await getRuntime().then(
    () => undefined,
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: "warn", msg: "web.start_deferred", error: error instanceof Error ? error.name : "unknown" })}\n`);
    },
  );
};
