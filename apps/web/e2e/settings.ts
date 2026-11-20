// Fixed values for the end-to-end stack, which work only against the throwaway database `stack.ts`
// starts.

/**
 * The stack's four ports are OSTRA_E2E_PORT (3100 by default) and the three after it, and the
 * second stack's are the same ten up, so two checkouts on one machine can each run the suite.
 */
const basePort = ((): number => {
  const raw = process.env["OSTRA_E2E_PORT"] ?? "3100";
  const port = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65_522) {
    throw new Error(`OSTRA_E2E_PORT must be a port from 1024 to 65522, not "${raw}"`);
  }
  return port;
})();

/** An http(s) address from the environment, or `undefined` when unset. */
const addressFrom = (name: string): string | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`${name} must be an http or https address, not "${raw}"`);
  }
  return raw.replace(/\/$/, "");
};

/**
 * F-076 (ticket 22): the specs can run against a stack someone else started, such as `docker
 * compose up` on deploy/compose.yaml (`compose-e2e.sh`). OSTRA_E2E_PANEL_URL and OSTRA_E2E_CORE_URL
 * name it; Playwright then starts no stack of its own, and the fakes run beside it (`fakes.ts`).
 */
const externalPanelUrl = addressFrom("OSTRA_E2E_PANEL_URL");
const externalCoreUrl = addressFrom("OSTRA_E2E_CORE_URL");
if ((externalPanelUrl === undefined) !== (externalCoreUrl === undefined)) {
  throw new Error("OSTRA_E2E_PANEL_URL and OSTRA_E2E_CORE_URL name an outside stack together: set both or neither");
}
export const e2eExternalStack = externalPanelUrl !== undefined;

export const e2ePort = basePort;
export const e2eBaseUrl = externalPanelUrl ?? `http://localhost:${String(e2ePort)}`;
/**
 * F-001: a second stack, ten ports up, started with OSTRA_ALLOW_DEFAULT_PASSWORD=true, for
 * `06-default-password.spec.ts` (the `default-password` project in playwright.config.ts).
 */
export const e2eDefaultPasswordPort = basePort + 10;
export const e2eDefaultPasswordBaseUrl = `http://localhost:${String(e2eDefaultPasswordPort)}`;

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
export const e2eCoreUrl = externalCoreUrl ?? `http://127.0.0.1:${String(e2eCorePort)}`;
export const e2eRepo = { owner: "fake-org", name: "test1" } as const;
/**
 * Milestone 3's ticket 46 (F-027, F-072): two heads of a task's branch on `test1` that the fake
 * GitHub compares with `main` (`fakes.ts`), for the Changes tab: the first with a rename, a binary
 * file and an edit; the second changes the edit's last line and nothing else.
 */
export const e2eChangesHeads = { first: "c4a9e2b7d1f0835a6e2c9b4d7f1a0e3c5b8d2f61", second: "d7b1f4c8e2a0937b5f3d1c6e8a2b4f0d9c7e3a52" } as const;
/**
 * F-136: the fake GitHub's second account, `client-b`, with the App installed and waiting to be
 * linked, and one repo. A third, `client-c`, owns a second App (`stack.ts`), whose key the stack writes out.
 */
export const e2eGitHubOrgB = { login: "client-b", id: 6_002, installationId: 8, repo: "billing" } as const;
export const e2eRunnerName = "e2e-runner";
/** A second stub model endpoint, in the OpenAI-compatible format, with the same token and models (F-088). */
export const e2eOpenAiStubPort = basePort + 3;
export const e2eOpenAiStubBaseUrl = `http://127.0.0.1:${String(e2eOpenAiStubPort)}/v1`;
export const e2eModelToken = "e2e-model-token-not-a-real-key";
/** One model the bundled catalog knows, and one it doesn't (a custom model). */
export const e2eStubModels = ["claude-sonnet-4-5", "local-coder-7b"] as const;

/**
 * F-115 (ticket 45): the second stack's email, set by its settings, which lock the panel's email
 * page (`06-email-locked.spec.ts`; `stack.ts` with OSTRA_E2E_EMAIL_LOCKED=1). SMTP on a reserved
 * `.example` host, so nothing is ever sent; no password, so the stack holds no secret.
 */
export const e2eLockedEmail = {
  OSTRA_EMAIL_PROVIDER: "smtp",
  OSTRA_EMAIL_FROM: "ostra@e2e.example",
  OSTRA_EMAIL_FROM_NAME: "ostra e2e",
  OSTRA_SMTP_HOST: "smtp.e2e.example",
  OSTRA_SMTP_PORT: "2525",
  OSTRA_SMTP_SECURE: "starttls",
  OSTRA_SMTP_USER: "ostra",
} as const;
