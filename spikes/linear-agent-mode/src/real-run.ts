import { setTimeout as delay } from "node:timers/promises";
import { LinearClient } from "@linear/sdk";
import { z } from "zod";
import { createClock, realClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { INPUTS } from "./criteria.ts";
import { linearEndpoints } from "./env.ts";
import { IssueId } from "./ids.ts";
import type { AgentSessionId, OrganizationId, TicketKey } from "./ids.ts";
import { createStderrLogger } from "./log.ts";
import { buildManifest, checkPublicUrl, explainPublicUrlProblem } from "./manifest.ts";
import { createOstraServer, INSTALL_PATH } from "./server.ts";
import type { OstraServer, WebhookTiming } from "./server.ts";
import { createRig } from "./scenarios/common.ts";
import type { Recorder, Rig } from "./scenarios/common.ts";
import { createRecorder } from "./scenarios/common.ts";
import { evaluateKeepAlive, evaluateLatency, firstActivitySamples } from "./scenarios/evaluate.ts";
import { HEARTBEAT_MINUTES, SILENT_TURN_MINUTES } from "./scenarios/keep-alive.ts";
import { createSilentDriver } from "./turn-driver.ts";
import { formatMs, summarize, until } from "./util.ts";

// `pnpm spike:real`: the same server, judged by the same evaluators as `pnpm spike`, against real Linear.
//
// What it needs and what it cannot do alone:
//   - OSTRA_DEV_PUBLIC_URL: a public https address forwarding to SPIKE_PORT (a tunnel or reverse proxy).
//   - LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET / LINEAR_WEBHOOK_SECRET: from clicking Create on the manifest link.
//   - A person to click Create, then Authorize; and, unless LINEAR_API_KEY is set, to delegate the tickets by hand;
//     and to press Send stop request on one session and post a follow-up on another.
//   - 35 minutes of wall-clock time for the keep-alive.
//
// SPIKE_REHEARSAL=1 runs the same phases against the local fake Linear, with a script standing in for the person, on a
// fast clock. It checks this file's orchestration. It proves nothing about Linear and never counts as a real run.

const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ""));
const env = z
  .object({
    OSTRA_DEV_PUBLIC_URL: z.string().optional(),
    LINEAR_CLIENT_ID: z.string().optional(),
    LINEAR_CLIENT_SECRET: z.string().optional(),
    LINEAR_WEBHOOK_SECRET: z.string().optional(),
    LINEAR_API_KEY: z.string().optional(),
    LINEAR_TEST_TEAM_KEY: z.string().optional(),
    SPIKE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    SPIKE_DELEGATIONS: z.coerce.number().int().min(3).max(200).default(50),
    SPIKE_REHEARSAL: z.literal("1").optional(),
    /** Rehearsal only: the fake Linear's clock runs this many ms ahead of this machine's, to see the run call itself inconclusive. */
    SPIKE_REHEARSAL_SKEW_MS: z.coerce.number().int().min(0).max(30_000).default(0),
    SPIKE_TIME_SCALE: z.coerce.number().int().min(1).max(5000).default(300),
  })
  .parse(cleaned);

const rehearsal = env.SPIKE_REHEARSAL === "1";
const label = rehearsal ? "rehearsal" : "real";

/** A stale episode can last less than a minute, so the last stretch of the watch polls every 10 s instead of every 60 s. */
const FAST_POLL_FROM_MINUTE = 28;

// --- what the person (or the script) does in Linear --------------------------------------------------

type Side = {
  /** Gets `count` delegations to the app into Linear. */
  delegate: (count: number, installedIn: OrganizationId) => Promise<void>;
  followUp: (sessionId: AgentSessionId, issue: TicketKey | null) => Promise<void>;
  stop: (sessionId: AgentSessionId, issue: TicketKey | null) => Promise<void>;
  /** Tidies up what the run made in Linear. Returns one line to print, or null when there was nothing to tidy. */
  cleanup: () => Promise<string | null>;
};

type Admin = { readonly client: LinearClient; readonly teamId: string; readonly teamKey: string };

/**
 * The admin's own client, used only to create the test issues. It refuses a key from any workspace other than the one
 * the app is installed in (the named test workspace), and picks the team by `LINEAR_TEST_TEAM_KEY` when one is given.
 */
const openAdmin = async (apiKey: string, installedIn: OrganizationId, teamKey: string | undefined): Promise<Admin> => {
  const client = new LinearClient({ apiKey });
  const organization = await client.organization;
  if (organization.id !== installedIn) {
    throw new Error("LINEAR_API_KEY belongs to a different workspace than the one the app is installed in. Refusing to create issues in it.");
  }
  const teams = (await client.teams()).nodes;
  const team = teamKey === undefined ? teams[0] : teams.find((candidate) => candidate.key === teamKey);
  if (team === undefined) throw new Error(teamKey === undefined ? "the test workspace has no team" : "LINEAR_TEST_TEAM_KEY names no team in the test workspace");
  return { client, teamId: team.id, teamKey: team.key };
};

const say = (text: string): void => {
  console.log(`  > ${text}`);
};

const printRecorder = (title: string, recorder: Recorder, criterion: "install" | "latency" | "stop-follow-up" | "keep-alive"): number => {
  const report = recorder.report(criterion);
  console.log(`\n${title}`);
  let failed = 0;
  for (const check of report.checks) {
    if (check.status === "FAIL") failed += 1;
    console.log(`    ${check.status === "PASS" ? "PASS    " : "FAIL    "} ${label}  ${check.name}${check.detail.length > 0 ? `  (${check.detail})` : ""}`);
  }
  for (const note of report.notes) console.log(`    note: ${note}`);
  return failed;
};

const main = async (): Promise<number> => {
  const clock: Clock = rehearsal ? createClock(env.SPIKE_TIME_SCALE) : realClock;
  const minute = 60_000 / clock.scale;
  console.log(`ostra milestone 0, spike 5: linear-agent-mode, ${rehearsal ? "REHEARSAL against the fake Linear (counts for nothing)" : "REAL run against Linear"}`);

  // The stand-in for a runner: a turn that says nothing for 35 minutes. Kept in scope, so what the server did to it
  // (follow-ups steered in, stops) can be read back from it.
  const driver = createSilentDriver({ clock, durationMs: SILENT_TURN_MINUTES * 60_000 });

  let server: OstraServer;
  let rig: Rig | undefined;
  let side: Side;
  let publicUrl: string;
  let appUserName = "the ostra app";

  if (rehearsal) {
    rig = await createRig({ clock, driver, heartbeat: { kind: "ephemeral-thought", intervalMs: HEARTBEAT_MINUTES * 60_000 }, clockSkewMs: env.SPIKE_REHEARSAL_SKEW_MS });
    server = rig.server;
    publicUrl = rig.publicUrl;
    const fake = rig.fake;
    side = {
      delegate: async (count) => {
        for (let i = 0; i < count; i += 5) {
          await Promise.all(Array.from({ length: Math.min(5, count - i) }, () => fake.delegate()));
        }
      },
      followUp: async (sessionId) => {
        await fake.prompt(sessionId, "Please also add a test.");
      },
      stop: async (sessionId) => {
        await fake.prompt(sessionId, "stop", { stop: true });
      },
      cleanup: () => Promise.resolve(null),
    };
  } else {
    const missing = INPUTS.filter((i) => !i.optional && env[i.name] === undefined).map((i) => i.name);
    const url = env.OSTRA_DEV_PUBLIC_URL;
    if (url === undefined) {
      console.log(`SKIPPED  needs OSTRA_DEV_PUBLIC_URL (a public https address that forwards to this machine's port ${String(env.SPIKE_PORT)}).`);
      return 2;
    }
    const check = checkPublicUrl(url);
    if (!check.ok) {
      console.log(`FAIL     OSTRA_DEV_PUBLIC_URL is not usable: ${explainPublicUrlProblem(check.problem)}.`);
      return 1;
    }
    publicUrl = check.origin;
    const manifest = buildManifest({ publicUrl, developerName: "ostra" });
    if (!manifest.ok) {
      console.log(`FAIL     no manifest: ${manifest.problems.join("; ")}`);
      return 1;
    }
    if (env.LINEAR_CLIENT_ID === undefined || env.LINEAR_CLIENT_SECRET === undefined || env.LINEAR_WEBHOOK_SECRET === undefined) {
      console.log("Step 1. As an admin of the test workspace, open this link and click Create:\n");
      console.log(`  ${manifest.links.json}\n`);
      console.log("Then put the client ID, client secret and webhook signing secret it shows into ~/.config/ostra-dev/linear.env as");
      console.log("LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET, load that file into your shell, and run this again.");
      console.log(`\nSKIPPED  needs ${missing.join(", ")}`);
      return 2;
    }
    server = createOstraServer({
      publicUrl,
      linear: { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET, webhookSecret: env.LINEAR_WEBHOOK_SECRET, endpoints: linearEndpoints(process.env) },
      agent: { firstActivityBudgetMs: 7_000, finalActivityBudgetMs: 30_000, hedgeAfterMs: 3_000, heartbeat: { kind: "ephemeral-thought", intervalMs: HEARTBEAT_MINUTES * 60_000 } },
      clock,
      driver,
      log: createStderrLogger(),
    });
    await server.listen(env.SPIKE_PORT, "127.0.0.1");
    say(`listening on 127.0.0.1:${String(env.SPIKE_PORT)}; the public address must forward to it`);
    const reached = await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(10_000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!reached) {
      console.log(`FAIL     ${publicUrl}/healthz is not reachable from here: the tunnel or proxy is not forwarding to this server.`);
      await server.close();
      return 1;
    }
    const apiKey = env.LINEAR_API_KEY;
    let admin: Admin | undefined;
    const created: IssueId[] = [];
    side = {
      delegate: async (count, installedIn) => {
        if (apiKey === undefined) {
          say(`Delegate ${String(count)} tickets to "${appUserName}" in the test workspace (assignee menu, Delegate). Any tickets will do.`);
          return;
        }
        const app = server.installations()[0];
        if (app === undefined) throw new Error("no installation to delegate to");
        // Before anything is created: is this key's workspace the one the app is installed in?
        admin ??= await openAdmin(apiKey, installedIn, env.LINEAR_TEST_TEAM_KEY);
        say(`creating and delegating ${String(count)} tickets in team ${admin.teamKey} with LINEAR_API_KEY (unverified: that an API delegation starts a session); they are archived afterwards`);
        for (let i = 0; i < count; i += 1) {
          const payload = await admin.client.createIssue({ teamId: admin.teamId, title: `ostra spike 5, delegation ${String(i + 1)} of ${String(count)}`, delegateId: app.appUserId });
          const issueId = IssueId.safeParse(payload.issueId);
          if (issueId.success) created.push(issueId.data);
          await delay(250);
        }
      },
      followUp: (_id, issue) => {
        say(`In Linear, open the session on ${issue ?? "that ticket"} and post a follow-up message.`);
        return Promise.resolve();
      },
      stop: (_id, issue) => {
        say(`In Linear, open the session on ${issue ?? "that ticket"} and press Send stop request.`);
        return Promise.resolve();
      },
      cleanup: async () => {
        if (admin === undefined || created.length === 0) return null;
        const open = admin;
        let archived = 0;
        for (const id of created) {
          const done = await open.client.archiveIssue(id).then(
            (r) => r.success,
            () => false,
          );
          if (done) archived += 1;
        }
        return `archived ${String(archived)} of the ${String(created.length)} issues this run created`;
      },
    };
  }

  const failures: number[] = [];
  let inconclusive = false;
  const total = env.SPIKE_DELEGATIONS;
  try {
    // 1. install --------------------------------------------------------------------------------
    const install = createRecorder();
    if (rig !== undefined) {
      await rig.install();
    } else {
      say(`Now install it: open ${publicUrl}${INSTALL_PATH} as a workspace admin and click Authorize (15 minutes).`);
      await until(() => server.installations().length > 0, { timeoutMs: 15 * 60_000, pollMs: 500 });
    }
    const installed = server.installations()[0];
    install.check("the app installed, and the token it got is the app's own user (the server refuses a token that is not)", installed !== undefined);
    if (installed !== undefined) {
      appUserName = installed.appUserName;
      install.check("it has the agent scopes", installed.scopes.includes("app:assignable") && installed.scopes.includes("app:mentionable"), installed.scopes.join(","));
      if (env.LINEAR_API_KEY !== undefined && !rehearsal) {
        const adminId = (await new LinearClient({ apiKey: env.LINEAR_API_KEY }).viewer).id;
        install.check("and it is a different user from the admin who authorised it", adminId !== installed.appUserId);
      } else {
        install.note("Not checked that the app user differs from the admin: no LINEAR_API_KEY to learn the admin's ID.");
      }
    }
    failures.push(printRecorder("[1] The app installs from a manifest link, as its own workspace user.", install, "install"));
    if (installed === undefined) return 1;
    const api = server.api(installed.organizationId);
    if (api === undefined) return 1;

    // 2. latency --------------------------------------------------------------------------------
    await side.delegate(total, installed.organizationId);
    say(`waiting for ${String(total)} delegations (up to ${rehearsal ? "1" : "30"} minutes)`);
    await until(() => server.service.metrics().length >= total, { timeoutMs: rehearsal ? 60_000 : 30 * 60_000, pollMs: 250 });
    // The fast lane is over for a session when the stand-in runner is first asked, whether or not the thought landed.
    await until(() => server.service.metrics().every((m) => m.driverAskedAt !== null), { timeoutMs: 60_000, pollMs: 250 });
    const metrics = server.service.metrics().slice(0, total);
    const latency = createRecorder();
    // Ack and transit come from one record per accepted `created`, joined to the session by its ID.
    const createdTimings = new Map<AgentSessionId, WebhookTiming>(
      server
        .stats()
        .timings.filter((t) => t.kind === "created")
        .map((t) => [t.sessionId, t]),
    );
    const timingOf = (sessionId: AgentSessionId): WebhookTiming | undefined => createdTimings.get(sessionId);
    const transits = metrics.flatMap((m) => {
      const timing = timingOf(m.sessionId);
      return timing === undefined ? [] : [timing.transitMs];
    });
    // Our clock minus Linear's timestamp is transit plus clock skew. If it is ever negative, this machine's clock is
    // behind Linear's by more than the transit, the delay is not recoverable from it, and nothing is clamped to hide that.
    const skewed = transits.length > 0 && Math.min(...transits) < 0;
    const addTransit = (sessionId: AgentSessionId): number => {
      const timing = timingOf(sessionId);
      return skewed || timing === undefined ? 0 : timing.transitMs;
    };
    evaluateLatency(latency, skewed ? "server-side only (clock skew, see the note)" : "from Linear's timestamp", total, {
      ackMs: metrics.flatMap((m) => {
        const ack = timingOf(m.sessionId)?.ackMs ?? null;
        return ack === null ? [] : [ack + addTransit(m.sessionId)];
      }),
      // The pass bar's first activity is a posted thought. The external-link update is not counted here.
      firstActivityMs: firstActivitySamples(metrics, addTransit),
    });
    latency.check("every session got a thought (an agent activity), not only an external-link update", metrics.every((m) => m.firstThoughtAt !== null), `${String(metrics.filter((m) => m.firstThoughtAt === null).length)} without`);
    if (skewed) {
      inconclusive = true;
      latency.note(`INCONCLUSIVE: the smallest "our clock at receipt minus Linear's timestamp" was ${formatMs(Math.min(...transits))}. This machine's clock is behind Linear's by more than the network transit, so the true ack and first-activity delays cannot be recovered from it, and the figures above leave transit out. Set the clock from NTP and run again.`);
    } else {
      latency.note(`transit from Linear's timestamp (one way, includes any clock skew): ${formatMs(summarize(transits).p50)} median, ${formatMs(summarize(transits).max)} at worst. The 200's return leg to Linear is not measured.`);
    }
    latency.note(`server-side ack, request in to 200 flushed: ${formatMs(summarize(metrics.flatMap((m) => timingOf(m.sessionId)?.ackMs ?? [])).max)} at worst. The inbox in this spike is an in-memory Map, so that figure leaves out a durable Postgres insert, which ostra's 200 will also wait for.`);
    const statuses = await Promise.all(metrics.map((m) => api.sessionStatus(m.sessionId).catch(() => "unreadable")));
    latency.check("Linear reports every session active, none in error or stale", statuses.every((s) => s === "active" || s === "pending"), [...new Set(statuses)].join(","));
    latency.check(
      "the first thought was posted before the stand-in runner was asked (a stand-in that is silent for 35 minutes; no runner exists here)",
      metrics.every((m) => m.firstThoughtAt !== null && m.driverAskedAt !== null && m.firstThoughtAt <= m.driverAskedAt),
    );
    failures.push(printRecorder(`[2] Across ${String(total)} delegations, the webhook is answered in under 5 s and the first activity lands in under 10 s, with no runner involved.`, latency, "latency"));

    // 3. stop and follow-up ---------------------------------------------------------------------
    const [followTarget, stopTarget, probe] = [metrics[0], metrics[1], metrics.at(-1)];
    if (followTarget === undefined || stopTarget === undefined || probe === undefined) return 1;
    await side.followUp(followTarget.sessionId, followTarget.issueIdentifier);
    await side.stop(stopTarget.sessionId, stopTarget.issueIdentifier);
    const seen = (id: AgentSessionId): { followUps: number; stops: number } => {
      const m = server.service.metrics().find((x) => x.sessionId === id);
      return { followUps: m?.followUpsSeen ?? 0, stops: m?.stopsSeen ?? 0 };
    };
    await until(() => seen(followTarget.sessionId).followUps >= 1 && seen(stopTarget.sessionId).stops >= 1, { timeoutMs: rehearsal ? 30_000 : 15 * 60_000, pollMs: 250 });
    await server.service.idle();
    const stopFollow = createRecorder();
    stopFollow.check("a follow-up webhook arrived", seen(followTarget.sessionId).followUps >= 1);
    stopFollow.check("and it was passed on to that session's running turn", driver.followUps.some((f) => f.sessionId === followTarget.sessionId));
    stopFollow.check("a stop request arrived", seen(stopTarget.sessionId).stops >= 1);
    stopFollow.check("and it stopped that session's turn", driver.stops.includes(stopTarget.sessionId));
    stopFollow.check("the stopped session ended (stopped) in ostra", JSON.stringify(server.service.stateOf(stopTarget.sessionId)) === JSON.stringify({ kind: "ended", reason: "stopped" }));
    const stopStatus = await api.sessionStatus(stopTarget.sessionId).catch(() => "unreadable");
    stopFollow.check("and Linear shows it complete", stopStatus === "complete", stopStatus);
    stopFollow.note("A stop that reaches a different replica than the one running the turn is not covered: session state is a per-process Map here. That needs the turn's state in Postgres (spike 6, milestone 1).");
    failures.push(printRecorder("[3] Stop and follow-up arrive.", stopFollow, "stop-follow-up"));

    // 4. keep-alive -----------------------------------------------------------------------------
    say(`keep-alive: watching ${probe.issueIdentifier ?? "one session"} for ${String(SILENT_TURN_MINUTES)} minutes${rehearsal ? " (fast clock)" : ""}; polling its status every minute, every 10 s from minute ${String(FAST_POLL_FROM_MINUTE)}`);
    const startedAt = clock.now();
    let staleSeen = false;
    const seenStatuses = new Set<string>();
    const ended = (): boolean => server.service.stateOf(probe.sessionId)?.kind === "ended";
    while (!ended() && clock.now() - startedAt < (SILENT_TURN_MINUTES + 10) * 60_000) {
      const status = await api.sessionStatus(probe.sessionId).catch(() => "unreadable");
      seenStatuses.add(status);
      if (status === "stale") staleSeen = true;
      const fast = clock.now() - startedAt >= FAST_POLL_FROM_MINUTE * 60_000;
      await delay(fast ? minute / 6 : minute);
    }
    await server.service.idle();
    const finalStatus = await api.sessionStatus(probe.sessionId).catch(() => "unreadable");
    const probeMetrics = server.service.metrics().find((m) => m.sessionId === probe.sessionId);
    const keepAlive = createRecorder();
    evaluateKeepAlive(keepAlive, label, SILENT_TURN_MINUTES * 60_000, {
      staleEpisodes: staleSeen ? 1 : 0,
      maxGapMs: probeMetrics?.maxPostGapMs ?? Number.POSITIVE_INFINITY,
      elapsedMs: (realClock.now() - (probeMetrics?.firstActivityAt ?? realClock.now())) * clock.scale,
      finalStatus,
    });
    keepAlive.check("it was kept alive by a heartbeat, not by luck", (probeMetrics?.heartbeatsPosted ?? 0) >= 1, `${String(probeMetrics?.heartbeatsPosted ?? 0)} posted, ${String(probeMetrics?.heartbeatsMissed ?? 0)} missed`);
    keepAlive.note(`statuses seen while it ran: ${[...seenStatuses].join(", ")}`);
    keepAlive.note("Whether Linear counts an ephemeral thought as activity is what this run tests: if the session went stale, switch the heartbeat's kind to a plain thought and run again.");
    failures.push(printRecorder("[4] A silent turn of 35 minutes stays alive.", keepAlive, "keep-alive"));
  } finally {
    const tidied = await side.cleanup().catch(() => "cleanup failed: some test issues may still need archiving by hand");
    if (tidied !== null) say(tidied);
    if (rig !== undefined) await rig.close();
    else await server.close();
  }

  const failed = failures.reduce((sum, n) => sum + n, 0);
  const verdict = failed > 0 ? "FAIL" : inconclusive ? "INCONCLUSIVE" : "PASS";
  console.log(`\n${verdict}  ${rehearsal ? "rehearsal only: this proves the script, not Linear" : "real run"}  (${String(failed)} failed checks)`);
  console.log("[5] needs no run here: `pnpm spike` covers it.");
  return failed > 0 ? 1 : inconclusive ? 2 : 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
