import { z } from "zod";
import type { HeartbeatConfig } from "../agent-sessions.ts";
import { createClock } from "../clock.ts";
import type { Clock } from "../clock.ts";
import type { CriterionId } from "../criteria.ts";
import { createFakeLinear } from "../fake-linear/fake-linear.ts";
import type { FakeLinear } from "../fake-linear/fake-linear.ts";
import type { FakeRules } from "../fake-linear/rules.ts";
import { createCapturingLogger } from "../log.ts";
import type { LogLine } from "../log.ts";
import { buildManifest, WEBHOOK_PATH } from "../manifest.ts";
import { createOstraServer, INSTALL_PATH } from "../server.ts";
import type { OstraServer } from "../server.ts";
import type { TurnDriver } from "../turn-driver.ts";

export type CheckStatus = "PASS" | "FAIL";
export type Check = { readonly name: string; readonly status: CheckStatus; readonly detail: string };

/** What one scenario reports: checks that passed or failed, and facts worth printing next to them. */
export type ScenarioReport = {
  readonly criterion: CriterionId | "hardening";
  readonly checks: readonly Check[];
  readonly notes: readonly string[];
};

export type Recorder = {
  check: (name: string, ok: boolean, detail?: string) => void;
  note: (text: string) => void;
  report: (criterion: ScenarioReport["criterion"]) => ScenarioReport;
};

export const createRecorder = (): Recorder => {
  const checks: Check[] = [];
  const notes: string[] = [];
  return {
    check: (name, ok, detail = "") => {
      checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
    },
    note: (text) => {
      notes.push(text);
    },
    report: (criterion) => ({ criterion, checks: [...checks], notes: [...notes] }),
  };
};

/** A scenario that throws is a failed scenario, not a crashed harness. */
export const guarded = async (
  criterion: ScenarioReport["criterion"],
  run: (recorder: Recorder) => Promise<void>,
): Promise<ScenarioReport> => {
  const recorder = createRecorder();
  try {
    await run(recorder);
  } catch (error: unknown) {
    recorder.check("scenario ran to the end", false, error instanceof Error ? `${error.name}: ${error.message}` : "threw a non-error");
  }
  return recorder.report(criterion);
};

// --- the rig: a fake Linear, an ostra server wired to it, and a simulated admin's browser -------------

export const DEFAULT_PUBLIC_URL = "https://ostra-dev.example.com";

export type RigOptions = {
  readonly driver: TurnDriver;
  /** Scenario-clock speed-up (1 = real time). Heartbeats and the fake's staleness rule run on it. */
  readonly clockScale?: number;
  /** A clock made by the caller, when the driver needs the same one. Wins over `clockScale`. */
  readonly clock?: Clock;
  readonly heartbeat?: HeartbeatConfig;
  readonly fakeRules?: Partial<FakeRules>;
  readonly retryDelaysMs?: readonly number[];
  readonly firstActivityBudgetMs?: number;
  readonly maxBodyBytes?: number;
  readonly publicUrl?: string;
  /** Real milliseconds the durable inbox insert takes before the webhook's 200 (see `OstraServerConfig`). */
  readonly inboxDelayMs?: number;
  /** The fake Linear's clock minus this machine's, in ms (see `FakeLinearOptions`). */
  readonly clockSkewMs?: number;
};

export type Rig = {
  readonly fake: FakeLinear;
  readonly server: OstraServer;
  readonly clock: Clock;
  readonly localOrigin: string;
  readonly webhookUrl: string;
  readonly publicUrl: string;
  readonly credentials: { readonly clientId: string; readonly clientSecret: string; readonly webhookSecret: string };
  readonly logs: readonly LogLine[];
  /** The admin clicks Connect Linear, then Authorize. Returns what the callback answered. */
  install: () => Promise<InstallOutcome>;
  close: () => Promise<void>;
};

const installBodySchema = z.union([
  z.object({
    installed: z.literal(true),
    organizationId: z.string(),
    appUserId: z.string(),
    appUserName: z.string(),
    scopes: z.array(z.string()),
  }),
  z.object({ error: z.string() }),
]);

export type InstallOutcome =
  | { readonly kind: "installed"; readonly status: number; readonly appUserId: string; readonly organizationId: string; readonly scopes: readonly string[] }
  | { readonly kind: "refused"; readonly status: number; readonly error: string }
  | { readonly kind: "broken"; readonly status: number };

const parseInstallBody = (status: number, body: unknown): InstallOutcome => {
  const parsed = installBodySchema.safeParse(body);
  if (!parsed.success) return { kind: "broken", status };
  if ("error" in parsed.data) return { kind: "refused", status, error: parsed.data.error };
  return { kind: "installed", status, appUserId: parsed.data.appUserId, organizationId: parsed.data.organizationId, scopes: parsed.data.scopes };
};

export const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};

export const createRig = async (options: RigOptions): Promise<Rig> => {
  const publicUrl = options.publicUrl ?? DEFAULT_PUBLIC_URL;
  const clock = options.clock ?? createClock(options.clockScale ?? 1);
  const { logger, lines } = createCapturingLogger();
  const fake = await createFakeLinear({
    clock,
    ...(options.fakeRules === undefined ? {} : { rules: options.fakeRules }),
    ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
    ...(options.clockSkewMs === undefined ? {} : { clockSkewMs: options.clockSkewMs }),
  });
  try {
    // The admin pastes the link into Linear and clicks Create: the fake plays Linear.
    const manifest = buildManifest({ publicUrl, developerName: "ostra" });
    if (!manifest.ok) throw new Error(`rig manifest: ${manifest.problems.join("; ")}`);
    const created = fake.createAppFromLink(manifest.links.json, "http://127.0.0.1:1/unset");
    if (!created.ok) throw new Error(`rig app: ${created.problems.join("; ")}`);
    const credentials = { clientId: created.clientId, clientSecret: created.clientSecret, webhookSecret: created.webhookSecret };

    const server = createOstraServer({
      publicUrl,
      linear: { ...credentials, endpoints: { apiUrl: fake.apiUrl, authorizeUrl: fake.authorizeUrl, tokenUrl: fake.tokenUrl } },
      agent: {
        firstActivityBudgetMs: options.firstActivityBudgetMs ?? 7_000,
        finalActivityBudgetMs: 30_000,
        hedgeAfterMs: 3_000,
        heartbeat: options.heartbeat ?? { kind: "ephemeral-thought", intervalMs: 20 * 60 * 1000 },
      },
      clock,
      driver: options.driver,
      log: logger,
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.inboxDelayMs === undefined ? {} : { inboxDelayMs: options.inboxDelayMs }),
    });
    const { port } = await server.listen();
    const localOrigin = `http://127.0.0.1:${String(port)}`;
    const webhookUrl = `${localOrigin}${WEBHOOK_PATH}`;
    fake.setDeliveryUrl(webhookUrl);

    let closed = false;
    return {
      fake,
      server,
      clock,
      localOrigin,
      webhookUrl,
      publicUrl,
      credentials,
      logs: lines,
      install: async () => {
        const toAuthorize = await fetch(`${localOrigin}${INSTALL_PATH}`, { redirect: "manual" });
        const authorizeLocation = toAuthorize.headers.get("location");
        if (authorizeLocation === null) return { kind: "broken", status: toAuthorize.status };
        const toCallback = await fetch(authorizeLocation, { redirect: "manual" });
        const callbackLocation = toCallback.headers.get("location");
        if (callbackLocation === null) return { kind: "refused", status: toCallback.status, error: "authorize-refused" };
        // The browser would go to the public address; the tunnel's job is to bring it here.
        const callback = new URL(callbackLocation);
        const answer = await fetch(`${localOrigin}${callback.pathname}${callback.search}`);
        return parseInstallBody(answer.status, await readJson(answer));
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await server.close();
        await fake.close();
      },
    };
  } catch (error: unknown) {
    await fake.close();
    throw error;
  }
};

/** Everything that was logged, as one string: for checking that no ticket text or secret got into it. */
export const logText = (logs: readonly LogLine[]): string => JSON.stringify(logs);
