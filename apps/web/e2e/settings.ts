// Fixed values for the end-to-end stack, which work only against the throwaway database `stack.ts`
// starts.
export const e2ePort = 3100;
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
export const e2eStubPort = 3101;
export const e2eStubBaseUrl = `http://127.0.0.1:${String(e2eStubPort)}/v1`;
/** Core, which the runner connects to, and the fake GitHub's repo (the fake serves one org, `fake-org`). */
export const e2eCorePort = 3102;
export const e2eCoreUrl = `http://127.0.0.1:${String(e2eCorePort)}`;
export const e2eRepo = { owner: "fake-org", name: "test1" } as const;
export const e2eRunnerName = "e2e-runner";
export const e2eModelToken = "e2e-model-token-not-a-real-key";
/** One model the bundled catalog knows, and one it doesn't (a custom model). */
export const e2eStubModels = ["claude-sonnet-4-5", "local-coder-7b"] as const;
