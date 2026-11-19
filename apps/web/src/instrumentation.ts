// Next.js runs `register` once when the server starts (ADR 0016). The panel builds its runtime
// then, not at the first request, so a fresh install seeds its first admin at start (F-001) and
// the log says so before anyone opens the panel. A failure here (the database isn't up yet) is
// logged and retried by the first request, which builds the runtime again. The work itself is in
// `instrumentation-node.ts`, imported only on the Node.js runtime.

export const register = async (): Promise<void> => {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { registerNode } = await import("./instrumentation-node");
  await registerNode();
};
