// Fixed values for the end-to-end stack. The token is a test value that works only against the
// throwaway database `stack.ts` starts.
export const e2ePort = 3100;
export const e2eSetupToken = "ostra-setup-e2e-0123456789abcdef0123456789abcdef";
export const e2eBaseUrl = `http://localhost:${String(e2ePort)}`;

export const e2eAdmin = {
  username: "admin",
  email: "admin@example.com",
  password: "correct horse battery staple",
  organizationName: "ostra-test",
} as const;

/** The stub model endpoint (Anthropic's format) and the token it accepts: a test value. */
export const e2eStubPort = 3101;
export const e2eStubBaseUrl = `http://127.0.0.1:${String(e2eStubPort)}/v1`;
export const e2eModelToken = "e2e-model-token-not-a-real-key";
/** One model the bundled catalog knows, and one it doesn't (a custom model). */
export const e2eStubModels = ["claude-sonnet-4-5", "local-coder-7b"] as const;
