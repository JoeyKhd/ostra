// The Node.js half of `instrumentation.ts`. It lives in its own module so the Edge build of the
// instrumentation hook never sees a Node.js API (Next.js warns about `process.stderr` otherwise).

export const registerNode = async (): Promise<void> => {
  const { getRuntime } = await import("./server/deps");
  await getRuntime().then(
    () => undefined,
    (error: unknown) => {
      // A secrets key that can't read the database's secrets (Q136) isn't a database that isn't up
      // yet: the panel refuses to start, with the cause and the two fixes. By name: Next.js bundles
      // the domain package, so `instanceof` may see another copy of the class.
      if (error instanceof Error && error.name === "SecretsKeyMismatchError") {
        process.stderr.write(`web: ${error.message}
`);
        process.exit(1);
      }
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: "warn", msg: "web.start_deferred", error: error instanceof Error ? error.name : "unknown" })}\n`);
    },
  );
};
