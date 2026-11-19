// Fixed values for the end-to-end stack, which work only against the throwaway database `stack.ts`
// starts.

/**
 * The stack's four ports are OSTRA_E2E_PORT (3100 by default) and the three after it, so two
 * checkouts on one machine can each run the suite.
 */
const basePort = ((): number => {
  const raw = process.env["OSTRA_E2E_PORT"] ?? "3100";
  const port = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65_532) {
    throw new Error(`OSTRA_E2E_PORT must be a port from 1024 to 65532, not "${raw}"`);
  }
  return port;
})();

export const e2ePort = basePort;
export const e2eBaseUrl = `http://localhost:${String(e2ePort)}`;

/**
 * The admin a fresh install seeds with no OSTRA_ADMIN_* set (F-001): demo@demo.com / demo, in an
 * organization named Demo. The first test signs in with the default password and chooses
 * `password`, which every later test signs in with.
 */
export const e2eAdmin = {
  username: "demo",
  email: "demo@demo.com",
  defaultPassword: "demo",
  password: "correct horse battery staple",
  organizationName: "Demo",
} as const;

/** The stub model endpoint (Anthropic's format) and the token it accepts: a test value. */
export const e2eStubPort = basePort + 1;
export const e2eStubBaseUrl = `http://127.0.0.1:${String(e2eStubPort)}/v1`;
/** Core, which the runner connects to, and the fake GitHub's repo (the fake serves one org, `fake-org`). */
export const e2eCorePort = basePort + 2;
export const e2eCoreUrl = `http://127.0.0.1:${String(e2eCorePort)}`;
export const e2eRepo = { owner: "fake-org", name: "test1" } as const;
export const e2eRunnerName = "e2e-runner";
/** A second stub model endpoint, in the OpenAI-compatible format, with the same token and models (F-088). */
export const e2eOpenAiStubPort = basePort + 3;
export const e2eOpenAiStubBaseUrl = `http://127.0.0.1:${String(e2eOpenAiStubPort)}/v1`;
export const e2eModelToken = "e2e-model-token-not-a-real-key";
/** One model the bundled catalog knows, and one it doesn't (a custom model). */
export const e2eStubModels = ["claude-sonnet-4-5", "local-coder-7b"] as const;
