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
